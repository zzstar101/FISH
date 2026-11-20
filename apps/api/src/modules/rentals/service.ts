import {
  type RentalCard,
  RentalCardSchema,
  type RentalCreateInput,
  type RentalDetail,
  RentalDetailSchema,
  type RentalErrorCode,
  type RentalFeedQuery,
  type RentalFeedResponse,
  RentalFeedResponseSchema,
  type RentalSort,
  type RentalUpdateInput,
} from '@fish/contracts/rentals/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { newId } from '@fish/db/ids'
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
} from '@fish/shared/public-id'
import { isCursorTimestamp } from '../listings/cursor'
import type { ContentModeration } from '../moderation/content'
import {
  ContentModerationUnavailable,
  moderationReasonCodeFor,
  tracedFieldOf,
} from '../moderation/content'
import type { TextModerationResult } from '../moderation/providers/types'
import type { ModerationDecision } from '../moderation/types'
import { publicAvatarUrl } from '../uploads/avatar-url'
import type { MediaStorage } from '../uploads/storage'
import { RENTAL_ALLOWED_CATEGORY, type RentalEntry, type RentalStore } from './store'

/**
 * 租赁发布 / 编辑 / 详情 / 广场的业务层（#706 RNT-02）。
 *
 * 分工：本层负责**业务规则**（资格、品类、租期、条款版本、可见性）与契约映射；
 * 审核与图片确认交给共享内核 `createContentModeration`（与出售同一份实现）；
 * 事务边界在 store。
 */

export class RentalServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: RentalErrorCode | 'VALIDATION_FAILED',
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'RentalServiceError'
  }
}

const notFound = () => new RentalServiceError(404, 'RENTAL_NOT_FOUND', '出租商品不存在或不可见')
const notEligible = () =>
  new RentalServiceError(403, 'RENTAL_NOT_ELIGIBLE', '发布出租需先完成教育邮箱认证')
const notOwner = () => new RentalServiceError(403, 'NOT_RENTAL_OWNER', '只能操作自己的出租商品')

export interface RentalService {
  createRental(ownerId: string, input: RentalCreateInput): Promise<RentalDetail>
  updateRental(ownerId: string, id: string, input: RentalUpdateInput): Promise<RentalDetail>
  getDetail(viewerId: string | null, id: string): Promise<RentalDetail>
  listFeed(query: RentalFeedQuery): Promise<RentalFeedResponse>
  listMine(ownerId: string): Promise<RentalFeedResponse>
  setStatus(ownerId: string, id: string, to: 'ACTIVE' | 'OFFLINE'): Promise<RentalDetail>
}

export function createRentalService(deps: {
  store: RentalStore
  storage: MediaStorage
  moderation: ContentModeration
}): RentalService {
  const { store, storage, moderation } = deps

  function toCard(entry: RentalEntry): RentalCard | null {
    /*
     * M0 只允许 DIGITAL。正常写入路径（`createRentalAtomic` 写死常量）不会产出别的分类，
     * 但「如实读取 + 越界跳过」比「硬编码 DIGITAL 覆盖真相」安全：后者会让一条 BOOKS 出租
     * 以数码的名义出现在广场（审查 P2 实测）。这里按契约的脏数据处理（记日志、跳过该条），
     * 与 `toListingCard` 的决策 C 同一口径。
     */
    if (entry.listing.category !== RENTAL_ALLOWED_CATEGORY) {
      console.error('[rentals] 跳过非数码品类的出租商品', entry.listing.id, entry.listing.category)
      return null
    }

    const card = {
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, entry.listing.id),
      listingNo: entry.listing.listingNo.toString(),
      title: entry.listing.title,
      dailyPriceCents: entry.listing.priceCents,
      depositCents: entry.terms.depositCents,
      category: entry.listing.category as 'DIGITAL',
      condition: entry.listing.condition,
      // 对外只暴露两种状态：`RESERVED` / `SOLD` 是出售的状态机，出租 V1 不用
      // （#707 起租期占用走独立的日期表，不改商品状态）。
      status: entry.listing.status === 'ACTIVE' ? ('ACTIVE' as const) : ('OFFLINE' as const),
      minDays: entry.terms.minDays,
      maxDays: entry.terms.maxDays,
      coverUrl: entry.coverObjectKey ? storage.publicUrl(entry.coverObjectKey) : null,
      createdAt: entry.listing.createdAt.toISOString(),
      owner: {
        id: encodePublicId(PUBLIC_ID_PREFIX.user, entry.owner.id),
        nickname: entry.owner.nickname,
        avatarUrl: publicAvatarUrl(entry.owner.avatarUrl),
        authStatus: entry.owner.authStatus,
      },
      // #706 不实现档期查询（#707 负责）：恒 null，端上显示「档期以预约时为准」。
      nextAvailableDate: null,
    }

    const parsed = RentalCardSchema.safeParse(card)
    if (!parsed.success) {
      console.error('[rentals] 跳过无法映射为契约的卡片', entry.listing.id, parsed.error.message)
      return null
    }
    return parsed.data
  }

  async function toDetail(entry: RentalEntry, viewerId: string | null): Promise<RentalDetail> {
    const isOwner = viewerId === entry.listing.sellerId
    const imageRows = await store.listImageKeys(entry.listing.id)
    const detail = {
      ...toCard(entry),
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, entry.listing.id),
      title: entry.listing.title,
      description: entry.listing.description,
      images: imageRows.map((objectKey, index) => ({
        id: `${entry.listing.id}:${index}`,
        url: storage.publicUrl(objectKey),
        sortOrder: index,
      })),
      rules: entry.terms.rules,
      isOwner,
      updatedAt: entry.listing.updatedAt.toISOString(),
    }

    // 详情没有「跳过」这个选项：映射不过说明与契约不符，宁可 500 也不返回缺字段的详情。
    const parsed = RentalDetailSchema.safeParse(detail)
    if (!parsed.success) {
      console.error('[rentals] 详情无法映射为契约', entry.listing.id, parsed.error.message)
      throw new Error('出租商品数据与契约不符')
    }
    return parsed.data
  }

  /** 审核结果 → store 的写入形状（两个写路径共用）。 */
  async function reviewContent(input: {
    dataId: string
    title: string
    description: string
    objectKeys: string[] | undefined
    storedKeys: ReadonlySet<string>
    ownerId: string
    action: 'CREATE' | 'UPDATE'
  }): Promise<{
    moderationStatus: 'APPROVED' | 'REVIEW'
    moderationReason: string | null
    moderationRuleVersion: string
    moderation: NonNullable<Parameters<RentalStore['createRentalAtomic']>[0]>['moderation']
  }> {
    const reject = (
      status: 400 | 422 | 503,
      code: string,
      message: string,
      details?: ApiErrorDetail[],
    ): never => {
      if (code === 'LISTING_CONTENT_BLOCKED' || code === 'RENTAL_CONTENT_BLOCKED') {
        throw new RentalServiceError(422, 'RENTAL_CONTENT_BLOCKED', message, details)
      }
      // 其余码（图片 / 上传）在出租域里没有独立语义，统一按内容未通过处理。
      throw new RentalServiceError(
        status === 503 ? 422 : (status as 422),
        'RENTAL_CONTENT_BLOCKED',
        message,
        details,
      )
    }

    let textResult: TextModerationResult
    try {
      textResult = await moderation.moderateText({
        dataId: input.dataId,
        title: input.title,
        description: input.description,
      })
    } catch (error) {
      if (error instanceof ContentModerationUnavailable) {
        if (error.status === 400) {
          throw new RentalServiceError(422, 'RENTAL_CONTENT_BLOCKED', '内容不符合审核要求')
        }
        // provider 不可用：fail closed，让客户端重试（503 由路由层映射）。
        throw new RentalServiceError(
          422,
          'RENTAL_CONTENT_BLOCKED',
          '内容安全审核服务暂不可用，请稍后重试',
        )
      }
      throw error
    }

    if (textResult.decision === 'BLOCK') {
      throw new RentalServiceError(422, 'RENTAL_CONTENT_BLOCKED', '出租内容未通过审核', [
        { field: 'title', message: '内容未通过审核' },
      ])
    }

    const imageDecisions = input.objectKeys
      ? await moderation.assertUsableObjectKeys({
          userId: input.ownerId,
          objectKeys: input.objectKeys,
          storedKeys: input.storedKeys,
          reject,
        })
      : await moderation.imageDecisionsOfStoredKeys({
          userId: input.ownerId,
          storedKeys: [...input.storedKeys],
        })

    const decision: ModerationDecision = moderation.aggregate([
      textResult.decision,
      ...imageDecisions,
    ])
    if (decision === 'BLOCK') {
      throw new RentalServiceError(422, 'RENTAL_CONTENT_BLOCKED', '出租内容未通过审核', [
        { field: 'objectKeys', message: '图片内容未通过审核' },
      ])
    }

    const traced = tracedFieldOf(textResult)
    return {
      moderationStatus: decision === 'REVIEW' ? 'REVIEW' : 'APPROVED',
      moderationReason: moderationReasonCodeFor(decision),
      moderationRuleVersion: textResult.policyVersion,
      moderation: {
        decision: decision === 'REVIEW' ? 'REVIEW' : 'ALLOW',
        ruleVersion: textResult.policyVersion,
        provider: textResult.provider,
        providerRequestId: traced?.requestId ?? null,
        suggestion: textResult.suggestion,
        label: traced?.label ?? null,
        subLabel: traced?.subLabel ?? null,
        score: traced?.score ?? null,
        // 由调用方按**编辑前的真实状态**覆盖（见 `updateRental`）；新建时无前值。
        priorListingStatus: null as 'ACTIVE' | 'OFFLINE' | 'RESERVED' | 'SOLD' | null,
      },
    }
  }

  /** 资格 + 品类：M0 的两条硬规则。 */
  async function assertEligible(ownerId: string): Promise<void> {
    if (!(await store.isEligibleOwner(ownerId))) throw notEligible()
  }

  return {
    async createRental(ownerId, input) {
      await assertEligible(ownerId)

      const listingId = newId()
      const reviewed = await reviewContent({
        dataId: encodePublicId(PUBLIC_ID_PREFIX.listing, listingId),
        title: input.title,
        description: input.description,
        objectKeys: input.objectKeys,
        storedKeys: new Set(),
        ownerId,
        action: 'CREATE',
      })

      const result = await store.createRentalAtomic({
        id: listingId,
        ownerId,
        title: input.title,
        description: input.description,
        dailyPriceCents: input.dailyPriceCents,
        depositCents: input.depositCents,
        rules: input.rules ?? null,
        minDays: input.minDays,
        maxDays: input.maxDays,
        condition: input.condition,
        objectKeys: input.objectKeys,
        moderationStatus: reviewed.moderationStatus,
        moderationReason: reviewed.moderationReason,
        moderationRuleVersion: reviewed.moderationRuleVersion,
        moderation: reviewed.moderation,
        duplicateWindowStart: new Date(Date.now() - 5_000),
      })

      return loadDetail(ownerId, result.listingId)
    },

    async updateRental(ownerId, id, input) {
      const existing = await store.findRentalDetail(id)
      if (!existing) throw notFound()
      if (existing.listing.sellerId !== ownerId) throw notOwner()

      // 部分更新下的租期关系要按**合并后的最终状态**判（与 free⟹price 同一手法）：
      // 只给 maxDays 时也要看库里当前的 minDays。
      const finalMin = input.minDays ?? existing.terms.minDays
      const finalMax = input.maxDays ?? existing.terms.maxDays
      if (finalMax < finalMin) {
        throw new RentalServiceError(422, 'VALIDATION_FAILED', '最长租期不能短于最短租期', [
          { field: 'maxDays', message: '最长租期不能短于最短租期' },
        ])
      }

      // 审计记录要写明「这次编辑前是什么状态」—— 硬编码 ACTIVE 会让一次 OFFLINE 商品
      // 的编辑在审计里看起来是从 ACTIVE 改下来的（审查报告 P2 的那一条）。
      const priorStatus = existing.listing.status
      const storedKeys = new Set(await store.listImageKeys(id))
      const contentChanged =
        input.title !== undefined ||
        input.description !== undefined ||
        input.objectKeys !== undefined

      const reviewed = contentChanged
        ? await reviewContent({
            dataId: encodePublicId(PUBLIC_ID_PREFIX.listing, id),
            title: input.title ?? existing.listing.title,
            description: input.description ?? existing.listing.description,
            objectKeys: input.objectKeys,
            storedKeys,
            ownerId,
            action: 'UPDATE',
          })
        : null

      const result = await store.updateRentalAtomic({
        listingId: id,
        ownerId,
        // 审计记录要用**review 过的完整文本**，不是「这次改了什么」（否则只改描述时
        // titleSnapshot 会是空串，与出售侧的审计口径分叉）。
        auditSnapshot: {
          title: input.title ?? existing.listing.title,
          description: input.description ?? existing.listing.description,
        },
        listingFields: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.condition !== undefined ? { condition: input.condition } : {}),
        },
        termsFields: {
          ...(input.dailyPriceCents !== undefined
            ? { dailyPriceCents: input.dailyPriceCents }
            : {}),
          ...(input.depositCents !== undefined ? { depositCents: input.depositCents } : {}),
          ...(input.rules !== undefined ? { rules: input.rules } : {}),
          ...(input.minDays !== undefined ? { minDays: input.minDays } : {}),
          ...(input.maxDays !== undefined ? { maxDays: input.maxDays } : {}),
        },
        ...(input.objectKeys !== undefined ? { objectKeys: input.objectKeys } : {}),
        ...(reviewed
          ? {
              moderation: {
                ...reviewed.moderation,
                priorListingStatus: reviewed.moderationStatus === 'REVIEW' ? priorStatus : null,
              },
              moderationStatus: reviewed.moderationStatus,
              moderationReason: reviewed.moderationReason,
              moderationRuleVersion: reviewed.moderationRuleVersion,
            }
          : {}),
      })

      if (result.kind === 'not-found') throw notFound()
      if (result.kind === 'not-owner') throw notOwner()
      if (result.kind === 'terms-invalid') {
        // 锁内判定的合并态违约（并发 PATCH 各改一半），与事务外那次判定同一个错误码。
        throw new RentalServiceError(422, 'VALIDATION_FAILED', '最长租期不能短于最短租期', [
          { field: 'maxDays', message: '最长租期不能短于最短租期' },
        ])
      }
      if (result.kind === 'not-editable') {
        throw new RentalServiceError(
          409,
          'RENTAL_TERMS_LOCKED',
          '出租商品已被平台下架，暂不能修改；如需恢复请联系平台处理',
        )
      }
      return loadDetail(ownerId, id)
    },

    async getDetail(viewerId, id) {
      const entry = await store.findRentalDetail(id)
      if (!entry) throw notFound()
      const isOwner = viewerId === entry.listing.sellerId
      // 未过审 / 已下架：非本人一律 404（与出售详情的 OFFLINE 口径一致，不给存在性探针）。
      if (
        (!isOwner && entry.listing.moderationStatus !== 'APPROVED') ||
        (!isOwner && entry.listing.status === 'OFFLINE')
      ) {
        throw notFound()
      }
      return toDetail(entry, viewerId)
    },

    async listFeed(query) {
      const cursor = decodeRentalCursor(query.cursor, query.sort)
      const rows = await store.listRentals({
        limit: query.limit,
        sort: query.sort,
        cursor,
        search: query.q,
        days: query.days,
        includeUnapproved: false,
      })
      return buildFeedResponse(rows, query.limit, query.sort, (entry) => toCard(entry))
    },

    async listMine(ownerId) {
      const rows = await store.listRentals({
        limit: 50,
        sort: 'newest',
        cursor: null,
        ownerId,
        includeUnapproved: true,
      })
      // 本端点**不接受游标**（`RENTAL_ROUTES.mine` 没有 cursor 参数），所以不能 advertise 一个
      // 客户端用不上的 nextCursor —— 那会让「第 51 条起永久不可达」看起来像可翻页。
      const response = buildFeedResponse(rows, 50, 'newest', (entry) => toCard(entry))
      return { ...response, nextCursor: null }
    },

    async setStatus(ownerId, id, to) {
      const entry = await store.findRentalDetail(id)
      if (!entry) throw notFound()
      if (entry.listing.sellerId !== ownerId) throw notOwner()

      const from = to === 'ACTIVE' ? 'OFFLINE' : 'ACTIVE'
      const current = entry.listing.status
      // 幂等：已是目标态直接返回详情（与出售的 transition 同一口径）。
      if (current === to) return loadDetail(ownerId, id)

      const changed = await store.setStatus({ listingId: id, from, to })
      if (!changed) {
        // 并发下别人先改了：再读一次，只有目标态才算幂等成功。
        const latest = await store.findRentalDetail(id)
        if (latest?.listing.status === to) return loadDetail(ownerId, id)
        throw new RentalServiceError(409, 'RENTAL_TERMS_LOCKED', '当前状态不允许该操作')
      }
      return loadDetail(ownerId, id)
    },
  }

  async function loadDetail(viewerId: string | null, id: string): Promise<RentalDetail> {
    const entry = await store.findRentalDetail(id)
    if (!entry) throw notFound()
    // 写路径的返回给**本人**：即使此刻是 REVIEW（`status = OFFLINE`）也要能看到自己的商品。
    return toDetail(entry, viewerId)
  }

  function buildFeedResponse(
    rows: RentalEntry[],
    limit: number,
    sort: RentalSort,
    map: (entry: RentalEntry) => RentalCard | null,
  ): RentalFeedResponse {
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows

    const items: RentalCard[] = []
    for (const entry of page) {
      const card = map(entry)
      if (card) items.push(card)
    }

    const last = page.at(-1)
    const nextCursor =
      hasMore && last
        ? encodeRentalCursor(
            sort === 'newest'
              ? // **微秒**文本，不是 `Date.toISOString()`（毫秒会让同毫秒内的行在翻页时消失）。
                { sortKey: last.createdAtCursor, id: last.listing.id }
              : { sortKey: last.listing.priceCents, id: last.listing.id },
          )
        : null

    return RentalFeedResponseSchema.parse({ items, nextCursor })
  }
}

/** 与 `listings/cursor.ts` 同一编码（base64url JSON），但 id 前缀仍是 `lst_`（同一 id 空间）。 */
function encodeRentalCursor(cursor: { sortKey: string | number; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, cursor.id),
    }),
    'utf8',
  ).toString('base64url')
}

function decodeRentalCursor(
  raw: string | undefined,
  sort: RentalSort,
): { sortKey: string | number; id: string } | null {
  if (raw === undefined) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    throw new RentalServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
      { field: 'cursor', message: 'cursor 无效' },
    ])
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RentalServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
      { field: 'cursor', message: 'cursor 无效' },
    ])
  }
  const { sortKey, id } = parsed as Record<string, unknown>
  if (typeof id !== 'string' || !isPublicId(PUBLIC_ID_PREFIX.listing, id)) {
    throw new RentalServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
      { field: 'cursor', message: 'cursor 无效' },
    ])
  }
  // 公开 id 是 base32 后缀，必须**解码**回 uuid 才能绑到 uuid 列（直接切前缀会拿到 base32）。
  const decodedId = decodePublicId(PUBLIC_ID_PREFIX.listing, id)
  if (sort === 'newest') {
    // 值域也要校验：手写正则放得过 `2026-13-45T99:99:99Z`，它随后被 PG 的 `::timestamptz`
    // 拒绝 → 500，而契约要求 422。复用 `listings/cursor.ts` 的同一个判据（zod 查月日时分秒）。
    if (typeof sortKey !== 'string' || !isCursorTimestamp(sortKey)) {
      throw new RentalServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
        { field: 'cursor', message: 'cursor 无效' },
      ])
    }
    return { sortKey, id: decodedId }
  }
  if (typeof sortKey !== 'number' || !Number.isFinite(sortKey)) {
    throw new RentalServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
      { field: 'cursor', message: 'cursor 无效' },
    ])
  }
  return { sortKey, id: decodedId }
}
