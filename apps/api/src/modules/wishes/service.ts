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
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
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

  /**
   * 状态流转后补投一次向量刷新（#322 M4 复审修复）。
   *
   * `updateStatusIfActive` 取 `clock_timestamp()`，即状态流转同样推进实体版本；而语义召回的
   * 新鲜度谓词要求向量行的 `source_updated_at` 与实体版本**毫秒级相等**
   * （`packages/db/src/embedding-store.ts` 的 `freshWishesEmbedding()`）。内容没变时
   * `EMBED_WISH` 走 handler 的 `unchanged` 分支，只把向量行的版本标记推进到实体当前版本，
   * **不重复调用 provider**。漏掉这一步，向量行会永久停在旧版本、掉出 `similarWishesByIds`
   * 的候选（该查询无状态谓词，`engine.ts` 商品方向的既有行补算走它），重算也只剩结构分。
   * 诚实边界：终态愿望本来就被 `creatable()` 排除在可见匹配之外，所以这不是用户可见的召回
   * 回归，而是**不变式与新鲜度可观测性的缺口**（`obs:summary` 的 fresh 计数会一直显示它不新鲜）。
   *
   * 复用 `enqueue()` 的成对投递：`MATCH_WISH` 对非 ACTIVE 愿望会 `skipped('target-not-active')`
   * （`apps/worker/src/jobs/matching/engine.ts`），不写任何匹配行，所以这里不必再造一条只投
   * EMBED 的路径。
   *
   * 投递在状态写入之后（与 `createWish`/`updateWish` 一样不假装原子）：投递失败会抛错，但状态
   * 已提交，客户端重试会走 `current === target` 分支再补投一次。并发竞态的“输家”也会走到
   * 目标态分支（见下方 `rowStatus(concurrent) === target`），那里同样要补投——否则赢家的投递
   * 若失败，就没有任何一次请求会再修它。
   */
  const refreshVectorAfterTransition = (id: string) => matchQueue.enqueue(id)

  const transition = async (userId: string, id: string, target: 'CLOSED' | 'FULFILLED') => {
    const wish = await store.findById(id)
    if (!wish) throw new WishServiceError(404, '愿望不存在')
    if (wish.user_id !== userId) throw new WishServiceError(403, '无权操作该愿望')

    const current = rowStatus(wish)
    if (current === target) {
      // 已经是目标态：不再写状态，但仍要补投——上一次状态写入的投递可能失败过（状态已提交，
      // 而客户端重试会走到这个分支），漏掉它就等于向量行永久停在旧版本。
      await refreshVectorAfterTransition(id)
      return toWishDto(wish)
    }
    if (current !== 'ACTIVE') throw new WishServiceError(409, '愿望已经处于终态')

    const updated = await store.updateStatusIfActive(id, target)
    if (updated) {
      invalidatePoolCache()
      // 先失效缓存再投递，与 `createWish`/`updateWish` 同一顺序。
      await refreshVectorAfterTransition(id)
      return toWishDto(updated)
    }

    const concurrent = await store.findById(id)
    if (!concurrent) throw new WishServiceError(404, '愿望不存在')
    if (concurrent.user_id !== userId) throw new WishServiceError(403, '无权操作该愿望')
    if (rowStatus(concurrent) === target) {
      // 并发竞态里我们输给了另一个写入者（或同一次提交的重试）：状态已是目标态、条件更新落空。
      // 这是一次成功返回，客户端不会重试，所以必须在这里补投——否则赢家的投递若失败，就没有
      // 任何后续请求会修这条向量行。
      await refreshVectorAfterTransition(id)
      return toWishDto(concurrent)
    }
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
      const updated = await store.update(id, toEditableFields(patch))
      if (updated) {
        invalidatePoolCache()
        // #322 M1：编辑愿望此前**不投递任何 job**，于是改完 keyword/description/category 既不重算
        // 匹配、也不刷新语义向量。规则与商品侧一致且刻意简单：一次成功 PATCH = 一次重算 + 一次
        // 向量刷新（重算按 wishId 幂等；向量侧还会按内容指纹跳过没变的重新生成，不重复计费）。
        // 投递放在 `store.update` 之后：wish store 的 update 本身不是事务化的（与 `createWish`
        // 的既有顺序一致），不假装它原子。
        await matchQueue.enqueue(id)
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
    id: encodePublicId(PUBLIC_ID_PREFIX.wish, row.id),
    userId: encodePublicId(PUBLIC_ID_PREFIX.user, row.user_id),
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
