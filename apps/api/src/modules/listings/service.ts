import { MeSchema } from '@fish/contracts/auth/user'
import {
  ALLOWED_IMAGE_MIME,
  type ListingCard,
  type ListingCreateInput,
  type ListingDetail,
  ListingDetailSchema,
  type ListingErrorCode,
  type ListingFeedQuery,
  type ListingFeedResponse,
  ListingFeedResponseSchema,
  type ListingModerationStatus,
  type ListingSeller,
  type ListingUpdateInput,
  listingObjectKeyPrefix,
  MAX_IMAGE_BYTES,
} from '@fish/contracts/listings/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { newId } from '@fish/db/ids'
import { createModerationService, type ModerationService } from '../moderation/service'
import type { ModerationField, ModerationResult } from '../moderation/types'
import type { MediaStorage } from '../uploads/storage'
import { toListingCard } from './card'
import { decodeCursor, encodeCursor, isCursorTimestamp } from './cursor'
import type {
  FeedCursorKey,
  FeedEntry,
  ListingImageRow,
  ListingRow,
  ListingState,
  ListingStore,
  ListingUpdateResult,
} from './store'
import { LOCKED_LISTING_STATUSES } from './store'

/**
 * 业务规则失败 → 契约 §3 的错误码表。带上 `details` 是为了让路由层直接落成
 * `VALIDATION_FAILED` 的字段级错误，而不是让调用方自己猜是哪个字段。
 */
export class ListingServiceError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly code: ListingErrorCode | 'VALIDATION_FAILED',
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'ListingServiceError'
  }
}

/** 与 #7 已合并的实现同一个窗口（apps/api/src/modules/wishes/service.ts）。 */
const DUPLICATE_WINDOW_MS = 5_000

const OFFLINE: ListingStatusValue = 'OFFLINE'
const ACTIVE: ListingStatusValue = 'ACTIVE'

type ListingStatusValue = ListingRow['status']

export interface ListingService {
  listFeed(viewerId: string | null, query: ListingFeedQuery): Promise<ListingFeedResponse>
  getDetail(viewerId: string | null, id: string): Promise<ListingDetail>
  createListing(
    userId: string,
    input: ListingCreateInput,
  ): Promise<{ created: boolean; detail: ListingDetail }>
  updateListing(userId: string, id: string, input: ListingUpdateInput): Promise<ListingDetail>
  /** 下架（ACTIVE → OFFLINE）与重新上架（OFFLINE → ACTIVE），幂等。 */
  transition(userId: string, id: string, to: 'OFFLINE' | 'ACTIVE'): Promise<ListingDetail>
}

/** 契约 §1 的 `free ⟹ priceCents = 0` 在库里的约束名（见 `packages/db/src/schema/listings.ts`）。 */
const FREE_PRICE_CONSTRAINT = 'listings_free_price_cents_zero'

/**
 * 判断错误是否为**那一条** CHECK 约束冲突。
 *
 * 探测方式与 `apps/api/src/modules/auth/service.ts` 的 `isUniqueViolation` 同构：Bun 的
 * `PostgresError` 把 SQLSTATE 放在 `errno` 上（`code` 恒为 `'ERR_POSTGRES_SERVER_ERROR'`），
 * Drizzle 又会把它包一层（`{ query, params, cause }`），所以要顺着 `cause` 链找。
 *
 * 但**不能只看 23514**：`listings` 上还有 `listings_price_cents_non_negative`、
 * `listing_images_sort_order_non_negative` 等 CHECK，将来还会有新的。逐个比对约束名，
 * 别的约束冲突照旧上抛（500），不会被错报成"0 元送价格必须为 0"。
 * 驱动不再暴露 `constraint` 时同样返回 false —— 宁可是 500，也不要给前端一个错误的字段级错误。
 */
function isFreePriceConstraintViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ('errno' in current && current.errno === '23514') {
      return 'constraint' in current && current.constraint === FREE_PRICE_CONSTRAINT
    }
    current = current.cause
  }
  return false
}

export function createListingService(deps: {
  store: ListingStore
  storage: MediaStorage
  moderation?: ModerationService
  /** 可注入时钟：去重窗口的边界断言不需要 sleep。 */
  now?: () => Date
}): ListingService {
  const { store, storage } = deps
  const moderation = deps.moderation ?? createModerationService()
  const now = deps.now ?? (() => new Date())

  function notFound(): ListingServiceError {
    return new ListingServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')
  }

  /**
   * 卖家资料的对外投影。`avatarUrl` 在库里是无约束 `text`，契约声明它是 `z.url()`：
   * 值域外的历史值降级为 `null`，否则整条详情会因为一个脏字段解析失败
   * 而 500（与 `apps/api/src/modules/auth/service.ts` 的 `toMe` 同一取舍）。
   * #86 F：校区已从产品与数据模型整体移除，卖家投影不再有任何校区字段。
   */
  function toSeller(row: {
    id: string
    nickname: string
    avatarUrl: string | null
    authStatus: 'UNVERIFIED' | 'VERIFIED'
  }): ListingSeller {
    return {
      id: row.id,
      nickname: row.nickname,
      avatarUrl: MeSchema.shape.avatarUrl.safeParse(row.avatarUrl).data ?? null,
      authStatus: row.authStatus,
    }
  }

  /** 卡片映射抽到 `card.ts`：#8 的 `/matches` 也要给同一张卡片，两处各写一份必然漂移。 */
  function toCard(
    listing: ListingRow,
    coverObjectKey: string | null,
    moderationStatus: ListingModerationStatus | null = null,
  ): ListingCard | null {
    return toListingCard(listing, coverObjectKey, storage, moderationStatus)
  }

  function toDetail(input: {
    listing: ListingRow
    seller: {
      id: string
      nickname: string
      avatarUrl: string | null
      authStatus: 'UNVERIFIED' | 'VERIFIED'
    }
    images: ListingImageRow[]
    viewerId: string | null
  }): ListingDetail {
    // 封面只认 0 号图（#6 契约 §1「下标即 sortOrder（0 = 封面）」），与 feed / profile /
    // matching / conversations / transactions 五处读模型同口径：缺 0 号图 → null。
    // 不能退化成「最小 sort_order」——store 按 `ORDER BY sort_order ASC` 返回，
    // `images[0]` 恰好就是最小那张；那条口径分叉会让同一份数据在详情与 feed 上
    // 给出两个不同结论（#47）。注意 `images[]` 仍返回全部图：详情页画廊读的是它
    // （detail-page.tsx 按 sortOrder 排序渲染），不受封面口径影响。
    const cover = input.images.find((image) => image.sortOrder === 0)
    const isOwner = input.viewerId === input.listing.sellerId
    const detail = {
      id: input.listing.id,
      title: input.listing.title,
      priceCents: input.listing.priceCents,
      category: input.listing.category,
      condition: input.listing.condition,
      status: input.listing.status,
      urgent: input.listing.urgent,
      negotiable: input.listing.negotiable,
      free: input.listing.free,
      coverUrl: cover ? storage.publicUrl(cover.objectKey) : null,
      createdAt: input.listing.createdAt.toISOString(),
      description: input.listing.description,
      images: input.images.map((image) => ({
        url: storage.publicUrl(image.objectKey),
        sortOrder: image.sortOrder,
      })),
      seller: toSeller(input.seller),
      isOwner,
      // 审核态只给卖家本人：买家看到的商品本来就只可能是 APPROVED，
      // 返回真实值等于白送一个内部状态字段（见契约 `ListingModerationStatusSchema`）。
      moderationStatus: isOwner ? input.listing.moderationStatus : null,
      updatedAt: input.listing.updatedAt.toISOString(),
    }

    // 详情没有"跳过"这个选项：解析不过说明这一行与契约不符，宁可 500 也不要静默返回
    // 一个缺字段的详情（前端会按契约直接取字段）。
    const parsed = ListingDetailSchema.safeParse(detail)
    if (!parsed.success) {
      console.error('[listings] 详情无法映射为契约', input.listing.id, parsed.error.message)
      throw new Error('商品数据与契约不符')
    }
    return parsed.data
  }

  async function loadDetail(viewerId: string | null, id: string): Promise<ListingDetail> {
    const found = await store.findDetail(id)
    if (!found) throw notFound()
    // OFFLINE 对非卖家 404（不是 403）：403 等于确认"这个 id 存在且是别人的商品"。
    if (
      (found.listing.status === OFFLINE || found.listing.moderationStatus !== 'APPROVED') &&
      found.listing.sellerId !== viewerId
    )
      throw notFound()

    return toDetail({
      listing: found.listing,
      seller: found.seller,
      images: found.images,
      viewerId,
    })
  }

  /**
   * 写入前的图片校验。分两类错误码：
   * - 对象不存在 → `UPLOAD_OBJECT_MISSING`（多半是前端没传完就提交）；
   * - 前缀不属于本人 / 超出大小或 mime → `IMAGE_REFERENCE_INVALID`（引用了不该引用的对象）。
   *
   * 归属只靠前缀，不需要新表（契约 §2.3）；大小与 mime 必须在这里查真实对象，
   * 因为 presign 的签名只覆盖 `host`、mime 不受约束（契约 §7.7）。
   */
  async function assertUsableObjectKeys(userId: string, objectKeys: string[]): Promise<void> {
    const prefix = listingObjectKeyPrefix(userId)

    for (const objectKey of objectKeys) {
      if (!objectKey.startsWith(prefix)) {
        throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片不属于当前用户' },
        ])
      }
    }

    // 逐张校验：≤9 次 HEAD，换掉"客户端可以拿 presign 传任意类型"的洞（契约 §7.7）。
    for (const objectKey of objectKeys) {
      const stat = await storage.stat(objectKey)
      if (!stat) {
        throw new ListingServiceError(422, 'UPLOAD_OBJECT_MISSING', '图片尚未上传完成', [
          { field: 'objectKeys', message: '图片尚未上传完成' },
        ])
      }
      if (stat.size > MAX_IMAGE_BYTES || !isAllowedMime(stat.contentType)) {
        throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片格式或大小不符合要求', [
          { field: 'objectKeys', message: '图片格式或大小不符合要求' },
        ])
      }
    }
  }

  return {
    async listFeed(viewerId, query) {
      // `status` 只在同时给 `sellerId` 时被 schema 接受；到这里还要确认查的是**自己**，
      // 否则任何人都能 `?status=SOLD` 拉全站已售商品（契约 §2.1）。
      if (query.sellerId !== undefined && query.sellerId !== viewerId) {
        throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能查看自己指定状态的商品')
      }
      // 防御纵深（评审 D3）：`status` 必须与 `sellerId` 同时出现。
      // 契约里这条只由 schema 的 refine 守着，而 router 之外（内部调用 / 将来重构）绕进本函数
      // 就能拿到全站 OFFLINE / RESERVED / SOLD 列表。这里与 schema 保持**同一个错误码**
      // （422 VALIDATION_FAILED），免得同一非法输入在两个层给出不同结论。
      if (query.status !== undefined && query.sellerId === undefined) {
        throw new ListingServiceError(422, 'VALIDATION_FAILED', 'status 必须与 sellerId 一起使用', [
          { field: 'status', message: 'status 必须与 sellerId 一起使用' },
        ])
      }

      const cursor = decodeFeedCursor(query.cursor, query.sort)
      // 卖家查自己且未指定 status ⇒ 不按状态过滤（「我发布的」要包含 OFFLINE / RESERVED / SOLD）。
      // 公开 Feed 仍固定 ACTIVE（不传 status 时缺省）——不这样做就不能既满足
      // 「我发布的含 REVIEW」又不把全站 OFFLINE 商品泄露出去。
      const ownSellerQuery = query.sellerId !== undefined && query.sellerId === viewerId
      const status = query.status ?? (ownSellerQuery ? undefined : ACTIVE)

      const rows = await store.listFeed({
        limit: query.limit,
        cursor,
        sort: query.sort,
        // `exactOptionalPropertyTypes`：字段声明为可选，不能显式传 undefined。
        ...(status ? { status } : {}),
        search: query.q,
        category: query.category,
        priceMinCents: query.priceMinCents,
        priceMaxCents: query.priceMaxCents,
        sellerId: query.sellerId,
        // 本人查询自己的商品时包含未通过审核的（REVIEW / BLOCKED），在前端展示"审核中"等状态；
        // 公开 Feed、匹配、他人详情继续严格过滤。此处 authorize 已达：query.sellerId !== viewerId 抛 403。
        includeUnapproved: ownSellerQuery,
      })

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      const items: ListingCard[] = []
      for (const entry of page) {
        // 只有「查自己」的列表带审核态；公开 Feed 与查他人都是 null（见 `toListingCard`）。
        const card = toCard(
          entry.listing,
          entry.coverObjectKey,
          ownSellerQuery ? entry.listing.moderationStatus : null,
        )
        if (card) items.push(card)
      }

      // 游标基于**最后一条已返回**的行，而不是 limit+1 那一条：否则会漏掉一个商品。
      const last = page.at(-1)
      const nextCursor =
        hasMore && last
          ? encodeCursor({ sortKey: cursorKeyOf(last, query.sort), id: last.listing.id })
          : null

      return ListingFeedResponseSchema.parse({ items, nextCursor })
    },

    getDetail(viewerId, id) {
      return loadDetail(viewerId, id)
    },

    async createListing(userId, input) {
      const moderationResult = moderation.moderate({
        title: input.title,
        description: input.description,
      })
      if (moderationResult.decision === 'BLOCK') {
        await recordModeration(store, {
          sellerId: userId,
          action: 'CREATE',
          title: input.title,
          description: input.description,
          result: moderationResult,
        })
        throw new ListingServiceError(
          422,
          'LISTING_CONTENT_BLOCKED',
          '商品内容未通过审核',
          moderationBlockDetails(moderationResult),
        )
      }

      await assertUsableObjectKeys(userId, input.objectKeys)

      const listingId = newId()
      const result = await store.createListingAtomic({
        id: listingId,
        sellerId: userId,
        title: input.title,
        description: input.description,
        priceCents: input.priceCents,
        condition: input.condition,
        category: input.category,
        urgent: input.urgent,
        negotiable: input.negotiable,
        free: input.free,
        objectKeys: input.objectKeys,
        duplicateWindowStart: new Date(now().getTime() - DUPLICATE_WINDOW_MS),
        moderationStatus: moderationResult.decision === 'REVIEW' ? 'REVIEW' : 'APPROVED',
        moderationReason: moderationResult.reasonCode,
        moderationRuleVersion: moderationResult.ruleVersion,
        moderation: {
          decision: moderationResult.decision,
          matchedRules: moderationResult.matches.map((match) => match.ruleCode),
          matchedTermsMasked: moderationResult.matches.map((match) => match.maskedTerm),
          ruleVersion: moderationResult.ruleVersion,
          priorListingStatus: moderationResult.decision === 'REVIEW' ? 'ACTIVE' : null,
        },
      })

      // 命中 5 秒内容窗口：返回已有商品（200 而不是 201），并**重新投递**匹配 job ——
      // 前一次投递失败不能让该商品永久失配，消费侧按 listingId 幂等（契约 §2.3）。
      if (result.kind === 'duplicate') await store.enqueueMatchJob(result.listingId)

      return {
        created: result.kind === 'created',
        detail: await loadDetail(userId, result.listingId),
      }
    },

    async updateListing(userId, id, input) {
      if (input.objectKeys) await assertUsableObjectKeys(userId, input.objectKeys)

      // "读当前行 → 合并最终内容 → 审核 → UPDATE + moderation record" 全部在同一个事务内，
      // 且当前行由 `SELECT ... FOR UPDATE` 锁住（store.updateListingAtomic）。把审核放在事务外
      // 会留下并发窗口：两个 PATCH 各自基于旧快照算结论，后提交的把 moderation_status 写回
      // APPROVED，最终出现"待审内容 + APPROVED"。
      let result: ListingUpdateResult
      // `apply` 在锁内算出的字段级原因要等事务返回后才能抛；`rejected` 只带一个 kind，
      // 所以在这里接一下（不落库：命中词本身不进任何持久化或响应）。
      let blockedDetails: ApiErrorDetail[] | undefined
      try {
        result = await store.updateListingAtomic({
          id,
          sellerId: userId,
          ...(input.objectKeys ? { objectKeys: input.objectKeys } : {}),
          apply: (_input, current) => {
            // 部分更新下 `free ⟹ priceCents === 0` 要按**合并后的最终状态**判定（契约 §7.1）：
            // 只给 priceCents 时也要看库里当前的 free。
            const finalFree = input.free ?? current.free
            const finalPrice = input.priceCents ?? current.priceCents
            if (finalFree && finalPrice !== 0) {
              throw new ListingServiceError(422, 'VALIDATION_FAILED', '0 元送时价格必须为 0', [
                { field: 'priceCents', message: '0 元送时价格必须为 0' },
              ])
            }

            const finalTitle = input.title ?? current.title
            const finalDescription = input.description ?? current.description
            const moderationResult = moderation.moderate({
              title: finalTitle,
              description: finalDescription,
            })
            // 阻断：只写审计（由 store 在**同一锁内事务**完成），不写商品。
            const moderationPlan = {
              title: finalTitle,
              description: finalDescription,
              decision: moderationResult.decision,
              matchedRules: moderationResult.matches.map((match) => match.ruleCode),
              matchedTermsMasked: moderationResult.matches.map((match) => match.maskedTerm),
              ruleVersion: moderationResult.ruleVersion,
              priorListingStatus:
                moderationResult.decision === 'REVIEW'
                  ? current.pendingReviewAction === 'CREATE'
                    ? 'ACTIVE'
                    : (current.pendingReviewPriorStatus ?? current.status)
                  : null,
            }
            if (moderationResult.decision === 'BLOCK') {
              blockedDetails = moderationBlockDetails(moderationResult)
              return { kind: 'blocked' as const, moderation: moderationPlan }
            }

            // `objectKeys` 必须从 `fields` 里剔除：它不是 `listings` 的列，混进 `set()` 会让
            // drizzle 生成不存在的列名（而且图片替换要走自己的删+插路径）。
            const { objectKeys: _objectKeys, ...fields } = input
            return {
              kind: 'write' as const,
              fields: {
                ...fields,
                moderationStatus: moderationResult.decision === 'REVIEW' ? 'REVIEW' : 'APPROVED',
                moderationReason: moderationResult.reasonCode,
                moderationRuleVersion: moderationResult.ruleVersion,
                moderatedAt: new Date(),
                ...(moderationResult.decision === 'REVIEW' ? { status: 'OFFLINE' as const } : {}),
              },
              moderation: moderationPlan,
            }
          },
        })
      } catch (error) {
        // 最终状态仍由 DB 的 `listings_free_price_cents_zero` 兜底（契约 §7.1）：锁内校验已经
        // 排除了并发 PATCH 竞态，但如果将来出现绕过 service 的写入方，仍然要报 422 而不是 500。
        if (isFreePriceConstraintViolation(error)) {
          throw new ListingServiceError(422, 'VALIDATION_FAILED', '0 元送时价格必须为 0', [
            { field: 'priceCents', message: '0 元送时价格必须为 0' },
          ])
        }
        throw error
      }

      if (result.kind === 'rejected') {
        // 审计记录已由 store 在**同一锁内事务**里写好（见 `ListingUpdatePlan`）：
        // 不要在这里再写一遍，也不要无锁重读去猜当时的内容。
        throw new ListingServiceError(
          422,
          'LISTING_CONTENT_BLOCKED',
          '商品内容未通过审核',
          blockedDetails,
        )
      }

      // `'locked'` / `'not-owner'` / `'not-found'` 都来自锁内读到的行，不再是 check-then-act 的第二次读。
      if (result.kind === 'locked') {
        throw new ListingServiceError(
          409,
          'LISTING_NOT_EDITABLE',
          '商品处于交易中或已售出，无法修改',
        )
      }
      if (result.kind === 'governance-blocked') {
        throw new ListingServiceError(
          409,
          'LISTING_GOVERNANCE_BLOCKED',
          '商品已被平台下架，暂不能修改；如需恢复请联系平台处理',
        )
      }
      if (result.kind === 'not-owner') {
        throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能操作自己的商品')
      }
      if (result.kind === 'not-found') throw notFound()

      return loadDetail(userId, id)
    },

    async transition(userId, id, to) {
      const state = await requireOwnEditable(userId, id, store)

      // 目标态已经是当前态 → 幂等成功（契约 §2.5 / §2.6 的状态表）。
      if (state.status === to) return loadDetail(userId, id)

      const changed = await store.setStatus({ id, from: state.status, to })
      if (!changed) {
        // 并发下别人先改了：只有改成目标态才算幂等成功，否则是状态机拒绝。
        const latest = await store.findState(id)
        if (latest?.status === to) return loadDetail(userId, id)
        throw new ListingServiceError(409, 'LISTING_NOT_EDITABLE', '当前状态不允许该操作')
      }

      return loadDetail(userId, id)
    },
  }
}

async function recordModeration(
  store: ListingStore,
  input: {
    listingId?: string
    sellerId: string
    action: 'CREATE' | 'UPDATE'
    title: string
    description: string
    result: ModerationResult
  },
): Promise<void> {
  await store.recordModeration?.({
    listingId: input.listingId,
    sellerId: input.sellerId,
    action: input.action,
    title: input.title,
    description: input.description,
    decision: input.result.decision,
    matchedRules: input.result.matches.map((match) => match.ruleCode),
    matchedTermsMasked: input.result.matches.map((match) => match.maskedTerm),
    ruleVersion: input.result.ruleVersion,
  })
}

/**
 * BLOCK → 可安全展示的字段级错误（`error.details`，`field` 与契约字段名一致，
 * 客户端据此把错误贴到对应输入框，而不是只给一句页面级通用错误）。
 *
 * **只给字段名与固定文案，绝不下发命中词或脱敏片段**：`rules.maskTerm()` 对两字词会露出
 * 首尾两字（`毒品` → `毒*品`），等于把词库交给绕过者，而词库本身还会继续演化（#74 口径）。
 *
 * 只取 `decision === 'BLOCK'` 的命中：同一次提交可能同时命中 BLOCK 与 REVIEW 规则，
 * 把只触发 REVIEW 的字段报成「禁止发布的内容」会指错方向。
 *
 * 返回 `undefined`（而不是空数组）当没有任何 BLOCK 命中时——那种情况下响应体与
 * 加 `details` 之前逐字节一致，调用方不必分辨 `[]` 与缺失。
 */
/**
 * 字段名 → 可展示的中文名。写成 `Record<ModerationField, string>` 而不是三元表达式：
 * 将来 `ModerationField` 多一个成员时，这里会在**类型检查**阶段逼着补文案，
 * 而不是把新字段静默说成「描述」（那会把用户指到错的输入框）。
 */
const MODERATION_FIELD_LABEL: Record<ModerationField, string> = {
  title: '标题',
  description: '描述',
}

function moderationBlockDetails(result: ModerationResult): ApiErrorDetail[] | undefined {
  const fields = [
    ...new Set(
      result.matches.filter((match) => match.decision === 'BLOCK').map((match) => match.field),
    ),
  ]
  if (fields.length === 0) return undefined
  return fields.map((field) => ({
    field,
    message: `${MODERATION_FIELD_LABEL[field]}包含平台禁止发布的内容`,
  }))
}

function isAllowedMime(contentType: string): boolean {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(contentType)
}

/**
 * 编辑 / 下架 / 上架共用的前置校验：存在性 → 归属 → 状态机。
 * 顺序不能换：先判归属会把"别人的商品是否存在"泄漏给调用方。
 */
async function requireOwnEditable(
  userId: string,
  id: string,
  store: ListingStore,
): Promise<ListingState> {
  const state = await store.findState(id)
  if (!state) throw new ListingServiceError(404, 'LISTING_NOT_FOUND', '商品不存在')
  if (state.sellerId !== userId) {
    throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能操作自己的商品')
  }
  if (LOCKED_LISTING_STATUSES.includes(state.status)) {
    throw new ListingServiceError(409, 'LISTING_NOT_EDITABLE', '商品处于交易中或已售出，无法修改')
  }
  // 治理下架（#73 PR3）：下架 / 上架都归管理员，卖家不能自行恢复。恢复走 admin restore，
  // 目标状态取下架审计快照里的 prior_listing_status。
  if (state.governanceDelistedAt) {
    throw new ListingServiceError(
      409,
      'LISTING_GOVERNANCE_BLOCKED',
      '商品已被平台下架，暂不能修改；如需恢复请联系平台处理',
    )
  }
  return state
}

/** 游标解码 + 与排序键类型对齐；不合法一律 422（契约 §2.1）。 */
function decodeFeedCursor(
  raw: string | undefined,
  sort: ListingFeedQuery['sort'],
): FeedCursorKey | null {
  if (raw === undefined) return null

  const decoded = decodeCursor(raw)
  if (!decoded) throw invalidCursor()

  if (sort === 'newest') {
    // 只接受我们自己生成的"微秒精度 UTC ISO"形态，且**值域**必须合法：
    // 否则 `::timestamptz` 转换失败又会变成 500（契约要求 422）。校验通过后原样传给 SQL 以保住微秒。
    if (typeof decoded.sortKey !== 'string' || !isCursorTimestamp(decoded.sortKey)) {
      throw invalidCursor()
    }
    return { kind: 'newest', createdAt: decoded.sortKey, id: decoded.id }
  }

  if (typeof decoded.sortKey !== 'number') throw invalidCursor()
  return { kind: sort, priceCents: decoded.sortKey, id: decoded.id }
}

function invalidCursor(): ListingServiceError {
  return new ListingServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])
}

function cursorKeyOf(entry: FeedEntry, sort: ListingFeedQuery['sort']): string | number {
  // newest 用 store 给的微秒文本；priceAsc/priceDesc 用整数分（本来就无损）。
  return sort === 'newest' ? entry.createdAtCursor : entry.listing.priceCents
}
