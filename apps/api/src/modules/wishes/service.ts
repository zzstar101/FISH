import {
  type WishCreateInput,
  type WishDto,
  type WishListQuery,
  type WishPoolResponse,
  type WishStatus,
  type WishUpdateInput,
  wishCreateInputSchema,
  wishPoolResponseSchema,
  wishStatusSchema,
  wishUpdateInputSchema,
} from '@fish/contracts/wishes/schema'
import { newId } from '@fish/db/ids'
import type { WishMatchQueue } from './match-queue'
import type { EditableWishFields, PoolRow, WishRow, WishStore } from './store'

export class WishServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = 'WishServiceError'
  }
}

const ACTIVE_WISH_LIMIT = 10
const DUPLICATE_WINDOW_MS = 5_000
const POOL_MIN_COUNT = 3
const POOL_LIMIT = 50
const POOL_CACHE_TTL_MS = 60_000

function rowStatus(row: WishRow): WishStatus {
  const parsed = wishStatusSchema.safeParse(row.status)
  if (!parsed.success) throw new Error(`数据库中的愿望状态无效: ${row.status}`)
  return parsed.data
}

function toEditableFields(input: WishUpdateInput): EditableWishFields {
  return {
    keyword: input.keyword,
    category: input.category,
    budgetMinCents: input.budgetMinCents,
    budgetMaxCents: input.budgetMaxCents,
    description: input.description,
    acceptSimilar: input.acceptSimilar,
  }
}

function toPoolResponse(rows: PoolRow[]): WishPoolResponse {
  return wishPoolResponseSchema.parse({
    items: rows.map((row) => ({
      keyword: row.keyword,
      category: row.category,
      wantCount: Number(row.want_count),
      medianBudgetCents: Math.round(Number(row.median_budget_cents)),
    })),
  })
}

export interface WishService {
  createWish(userId: string, input: WishCreateInput): Promise<WishDto>
  listWishes(userId: string, query: WishListQuery): Promise<{ items: WishDto[]; total: number }>
  getWish(userId: string, id: string): Promise<WishDto>
  updateWish(userId: string, id: string, input: WishUpdateInput): Promise<WishDto>
  closeWish(userId: string, id: string): Promise<WishDto>
  fulfillWish(userId: string, id: string): Promise<WishDto>
  getPool(): Promise<WishPoolResponse>
}

export function createWishService({
  store,
  matchQueue,
}: {
  store: WishStore
  matchQueue: WishMatchQueue
}): WishService {
  let poolCache: { expiresAt: number; response: WishPoolResponse } | null = null

  const invalidatePoolCache = () => {
    poolCache = null
  }

  const requireOwnedActiveWish = async (userId: string, id: string) => {
    const wish = await store.findById(id)
    if (!wish) throw new WishServiceError(404, '愿望不存在')
    if (wish.user_id !== userId) throw new WishServiceError(403, '无权操作该愿望')
    if (rowStatus(wish) !== 'ACTIVE') throw new WishServiceError(409, '只有 ACTIVE 愿望可以编辑')
    return wish
  }

  const transition = async (userId: string, id: string, target: 'CLOSED' | 'FULFILLED') => {
    const wish = await store.findById(id)
    if (!wish) throw new WishServiceError(404, '愿望不存在')
    if (wish.user_id !== userId) throw new WishServiceError(403, '无权操作该愿望')

    const current = rowStatus(wish)
    if (current === target) return toWishDto(wish)
    if (current !== 'ACTIVE') throw new WishServiceError(409, '愿望已经处于终态')

    const updated = await store.updateStatusIfActive(id, target, new Date())
    if (updated) {
      invalidatePoolCache()
      return toWishDto(updated)
    }

    const concurrent = await store.findById(id)
    if (!concurrent) throw new WishServiceError(404, '愿望不存在')
    if (concurrent.user_id !== userId) throw new WishServiceError(403, '无权操作该愿望')
    if (rowStatus(concurrent) === target) return toWishDto(concurrent)
    throw new WishServiceError(409, '愿望已经处于终态')
  }

  return {
    async createWish(userId, input) {
      const parsed = wishCreateInputSchema.parse(input)
      const now = new Date()
      const result = await store.createOrGetRecent(
        {
          id: newId(),
          user_id: userId,
          keyword: parsed.keyword,
          category: parsed.category,
          budget_min_cents: parsed.budgetMinCents,
          budget_max_cents: parsed.budgetMaxCents,
          description: parsed.description ?? null,
          accept_similar: parsed.acceptSimilar,
          status: 'ACTIVE',
          created_at: now,
          updated_at: now,
        },
        ACTIVE_WISH_LIMIT,
        new Date(now.getTime() - DUPLICATE_WINDOW_MS),
      )
      if (result.kind === 'active-limit') {
        throw new WishServiceError(409, `ACTIVE 愿望最多 ${ACTIVE_WISH_LIMIT} 条`)
      }

      // 先失效缓存再投递：投递失败抛错时记录已落库，不能让需求池继续返回旧快照。
      if (result.kind === 'created') invalidatePoolCache()

      // 对重复请求重新投递，避免前一次投递失败后该愿望永久失配；匹配侧需按 wishId 幂等消费。
      await matchQueue.enqueue(result.row.id)
      return toWishDto(result.row)
    },

    async listWishes(userId, query) {
      const parsed = {
        ...query,
        status: query.status === undefined ? undefined : wishStatusSchema.parse(query.status),
      }
      const result = await store.listByUser(userId, {
        status: parsed.status,
        limit: parsed.pageSize,
        offset: (parsed.page - 1) * parsed.pageSize,
      })
      return { items: result.rows.map(toWishDto), total: result.total }
    },

    async getWish(userId, id) {
      const wish = await store.findById(id)
      if (!wish) throw new WishServiceError(404, '愿望不存在')
      if (wish.user_id !== userId) throw new WishServiceError(403, '无权查看该愿望')
      return toWishDto(wish)
    },

    async updateWish(userId, id, input) {
      const wish = await requireOwnedActiveWish(userId, id)
      const patch = wishUpdateInputSchema.parse(input)
      const mergedDescription =
        patch.description === undefined ? wish.description : patch.description
      // 校验合并后的预算区间等字段仍合法（结果不落库）；实际只写本次提供的字段，
      // 两个并发 PATCH 各改一个字段时，避免后写方用旧快照覆盖先写方（lost update）。
      wishCreateInputSchema.parse({
        keyword: patch.keyword ?? wish.keyword,
        category: patch.category ?? wish.category,
        budgetMinCents: patch.budgetMinCents ?? wish.budget_min_cents,
        budgetMaxCents: patch.budgetMaxCents ?? wish.budget_max_cents,
        description: mergedDescription ?? undefined,
        acceptSimilar: patch.acceptSimilar ?? wish.accept_similar,
      })
      const updated = await store.update(id, toEditableFields(patch), new Date())
      if (updated) {
        invalidatePoolCache()
        return toWishDto(updated)
      }
      throw new WishServiceError(409, '只有 ACTIVE 愿望可以编辑')
    },

    closeWish(userId, id) {
      return transition(userId, id, 'CLOSED')
    },

    fulfillWish(userId, id) {
      return transition(userId, id, 'FULFILLED')
    },

    async getPool() {
      if (poolCache && poolCache.expiresAt > Date.now()) return poolCache.response
      const response = toPoolResponse(await store.aggregatePool(POOL_MIN_COUNT, POOL_LIMIT))
      poolCache = { expiresAt: Date.now() + POOL_CACHE_TTL_MS, response }
      return response
    },
  }
}

export function toWishDto(row: WishRow): WishDto {
  return {
    id: row.id,
    userId: row.user_id,
    keyword: row.keyword,
    category: row.category as WishDto['category'],
    budgetMinCents: row.budget_min_cents,
    budgetMaxCents: row.budget_max_cents,
    description: row.description,
    acceptSimilar: row.accept_similar,
    status: rowStatus(row),
    matchCount: row.match_count ?? 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}
