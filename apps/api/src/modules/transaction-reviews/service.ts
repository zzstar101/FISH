import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import type { ModerationDecision } from '@fish/contracts/moderation/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import type {
  TransactionReview,
  TransactionReviewCreateInput,
  TransactionReviewDeleteResponse,
  TransactionReviewItem,
  TransactionReviewResponse,
  TransactionReviewsResponse,
} from '@fish/contracts/transaction-reviews/schema'
import {
  MAX_REVIEW_IMAGES,
  TransactionReviewItemSchema,
  TransactionReviewSchema,
  TransactionReviewsResponseSchema,
} from '@fish/contracts/transaction-reviews/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createLocalContentModerationProvider } from '../moderation/providers/local'
import {
  ContentModerationError,
  type ContentModerationProvider,
  type TextModerationResult,
} from '../moderation/providers/types'
import { moderatePublicUgcText } from '../moderation/ugc-text'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { isReviewModerationMediaKey, reviewModerationMediaPrefix } from '../uploads/review-media'
import type { MediaStorage } from '../uploads/storage'
import { isReviewMediaPublicKey, reviewMediaPublicPrefix } from '../uploads/storage'
import {
  createReviewMediaService,
  type ReviewImageModerationConfig,
  type ReviewMediaService,
} from './media-service'
import { effectiveReviewModerationDecision, type ReviewModerationStore } from './moderation-store'
import type {
  MyReviewRow,
  ReviewTimelineRow,
  TransactionReviewRow,
  TransactionReviewsStore,
} from './store'

export class TransactionReviewServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422 | 503,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'TransactionReviewServiceError'
  }
}

const transactionNotFound = () =>
  new TransactionReviewServiceError(404, 'TRANSACTION_NOT_FOUND', '交易不存在')
const reviewNotFound = () =>
  new TransactionReviewServiceError(404, 'REVIEW_NOT_FOUND', '还没有评价')
const reviewExists = () =>
  new TransactionReviewServiceError(409, 'TRANSACTION_REVIEW_EXISTS', '这笔交易你已经评价过了')
const notCompleted = () =>
  new TransactionReviewServiceError(409, 'TRANSACTION_NOT_COMPLETED', '交易完成后才能评价')
/**
 * #475 配图不可引用：跨用户键 / 他人 listing 键 / chat-media 键 / 未经本链 confirm 的键 /
 * 对象不存在 —— **同一稳定码**，不区分（不把「别人的对象是否存在」变成侧信道）。
 */
const reviewImageInvalid = () =>
  new TransactionReviewServiceError(422, 'REVIEW_IMAGE_INVALID', '图片对象不可引用，请重新上传', [
    { field: 'imageObjectKeys', message: '图片对象不可引用' },
  ])
const reviewImagesInvalidInput = (message: string) =>
  new TransactionReviewServiceError(422, 'VALIDATION_FAILED', message, [
    { field: 'imageObjectKeys', message },
  ])
/** 已落库的审核结论是 BLOCK：这张图永远不能出现在评价里（也不给「重传同一键」的错觉）。 */
const reviewImageBlocked = () =>
  new TransactionReviewServiceError(
    422,
    'REVIEW_IMAGE_BLOCKED',
    '图片未通过内容审核，请更换后重新上传',
    [{ field: 'imageObjectKeys', message: '图片未通过内容审核' }],
  )
/**
 * #483 审查响应：存储运行错误是**可重试的服务故障**，与「图片无效」（422，用户要换图）分开——
 * 不把 MinIO 抖动伪装成让用户重传的问题。
 */
const reviewMediaUnavailable = () =>
  new TransactionReviewServiceError(
    503,
    'REVIEW_MEDIA_UNAVAILABLE',
    '图片校验暂时不可用，请稍后重试',
  )

/**
 * 评价行 → 契约 DTO（决策 C：逐条 parse，一条越界的历史行不能把整页打成 500）。
 *
 * `transactionId` 由调用方以**公开 ID** 传入 —— 评价边场景是路径参数解码后的 uuid 再编码，
 * 时间线场景直接取行内交易 id；行本身不冗余存它。
 */
function toReviewDto(
  row: MyReviewRow,
  transactionPublicId: string,
  storage: Pick<MediaStorage, 'publicUrl'>,
  decisions?: ReadonlyMap<string, ModerationDecision>,
): TransactionReview | null {
  const decisionOf = (key: string): ModerationDecision | undefined =>
    decisions?.get(key) ?? row.imageModeration?.[key]
  const parsed = TransactionReviewSchema.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.review, row.id),
    transactionId: transactionPublicId,
    rating: row.rating,
    body: row.body,
    // BLOCK 图不进任何 DTO（作者也不给）；没有台账结论的键按未通过处理。
    images: row.imageKeys.flatMap((objectKey) => {
      const decision = decisionOf(objectKey)
      if (!decision || decision === 'BLOCK') return []
      return [{ url: storage.publicUrl(objectKey), moderationDecision: decision }]
    }),
    createdAt: row.createdAt,
  })
  if (!parsed.success) {
    console.error('[transaction-reviews] 跳过无法映射为契约的评价', row.id, parsed.error.message)
    return null
  }
  return parsed.data
}

/**
 * 公开可见性：只要有一条图片的有效结论不是 ALLOW，整条评价都不对外展示
 * （图片待审期间评价正文也不公开，避免「图待审、文字先公开」的半截状态）。
 * 作者视角例外：作者总能看到自己的评价与逐图状态（`toReviewDto` 会过滤 BLOCK）。
 */
function hasOnlyPublicImages(
  row: MyReviewRow,
  decisions: ReadonlyMap<string, ModerationDecision>,
): boolean {
  return row.imageKeys.every((key) => decisions.get(key) === 'ALLOW')
}

/**
 * 时间线一行 → `{ review, transaction }` 契约项（`GET /me/comments?kind=review|all`）。
 *
 * `transaction` 内嵌的是**查看者视角**的订单 DTO（查看者 = 评价作者本人）：
 * `role` 是作者在交易里的角色，`counterpart` / `listing` 由服务端拼好 —— 端上拿到的是
 * 真实 `transactionId` / `listingId`，行点击进订单或商品详情，不靠标题猜 ID。
 */
export function toTransactionReviewItem(
  row: ReviewTimelineRow,
  viewerId: string,
  storage: Pick<MediaStorage, 'publicUrl'>,
): TransactionReviewItem | null {
  const t = row.transaction
  // 会话缺失是 FK 不一致的历史行：订单 DTO 要求 conversationId，跳过而不是 500。
  if (t.conversationId === null) return null
  const review = toReviewDto(row, encodePublicId(PUBLIC_ID_PREFIX.transaction, t.id), storage)
  if (!review) return null

  const transaction = {
    id: review.transactionId,
    conversationId: encodePublicId(PUBLIC_ID_PREFIX.conversation, t.conversationId),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, t.listingId),
    buyerId: encodePublicId(PUBLIC_ID_PREFIX.user, t.buyerId),
    sellerId: encodePublicId(PUBLIC_ID_PREFIX.user, t.sellerId),
    role: t.buyerId === viewerId ? ('buyer' as const) : ('seller' as const),
    listing: {
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, t.listingId),
      title: t.listingTitle,
      priceCents: t.listingPriceCents,
      status: t.listingStatus,
      coverUrl: t.coverObjectKey ? storage.publicUrl(t.coverObjectKey) : null,
    },
    counterpart: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, t.counterpartId),
      nickname: t.counterpartNickname,
      avatarUrl: publicAvatarUrl(t.counterpartAvatarUrl),
    },
    amountCents: t.amountCents,
    status: t.status,
    buyerConfirmedAt: t.buyerConfirmedAt,
    sellerConfirmedAt: t.sellerConfirmedAt,
    completedAt: t.completedAt,
    cancelledAt: t.cancelledAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  }
  const parsed = TransactionReviewItemSchema.safeParse({ review, transaction })
  if (!parsed.success) {
    console.error(
      '[transaction-reviews] 跳过无法映射为契约的时间线行',
      row.id,
      parsed.error.message,
    )
    return null
  }
  return parsed.data
}

/** base64url(JSON) 游标：`(created_at 微秒, id)` + 来源档位（`comments/cursor.ts` 同构）。 */
export function encodeReviewCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: cursor.createdAt,
      id: encodePublicId(PUBLIC_ID_PREFIX.review, cursor.id),
      source: 'review',
    }),
    'utf8',
  ).toString('base64url')
}

export interface TransactionReviewService {
  /** 读「(我, 这笔交易)」这条评价边；没评过 → 404 `REVIEW_NOT_FOUND`。 */
  getMyReview(userId: string, transactionId: string): Promise<TransactionReviewResponse>
  /** 创建我的评价（仅 COMPLETED、各方一条、正文过审）。 */
  createReview(
    userId: string,
    transactionId: string,
    input: TransactionReviewCreateInput,
  ): Promise<TransactionReviewResponse>
  /** 删除我的评价（幂等：没评过 → `{ deleted: 0 }`；评价不可修改，只有删除）。 */
  deleteMyReview(userId: string, transactionId: string): Promise<TransactionReviewDeleteResponse>
  /** 一笔交易的两方评价（仅参与者；≤2 行不分页）。 */
  listReviewsOf(userId: string, transactionId: string): Promise<TransactionReviewsResponse>
  /**
   * 「我发过的评价」一页（comments 模块的 `/me/comments?kind=review` 借道这里）。
   * `cursor` 是**已解码**的评价游标：`{ createdAt, id }`（uuid），来源校验在 comments 侧。
   */
  listMine(
    userId: string,
    query: { limit: number; cursor: { createdAt: string; id: string } | null },
  ): Promise<{ items: TransactionReviewItem[]; nextCursor: string | null; total: number }>
  /** #475 配图上传链（presign/confirm）：授权门与评价边 POST 一致。 */
  media: ReviewMediaService
  /**
   * 同上，但返回**未映射的原始行** + 全量计数：`kind=all` 的合并归并在 comments 侧做
   * （两边的行要按 `(created_at, id)` 统一排序后截断，DTO 里没有游标坐标，映射后并不动）。
   */
  listMineRows(
    userId: string,
    query: { limit: number; cursor: { createdAt: string; id: string } | null },
  ): Promise<{ rows: ReviewTimelineRow[]; total: number }>
}

export function createTransactionReviewService(deps: {
  store: TransactionReviewsStore
  /**
   * 存储实例（#475 起需要 stat：写侧引用校验会现查对象是否存在/大小/MIME；
   * 上传链还需要 presignPut/readMediaBytes/writeMediaBytes）。
   */
  storage: MediaStorage
  /**
   * 公开 UGC 文本审核 provider（#694 M6）。缺省走本地词表（开发/测试）；生产装配在
   * `app.ts`，与留言共用公开评论策略号（`TENCENT_TMS_UGC_BIZ_TYPE`）。
   */
  moderationProvider?: ContentModerationProvider
  /**
   * 评价图片审核台账（#694 M5c）：confirm 落记录；写侧引用/删改可见性都靠它判定
   * 「这个 final 键确实审过、结论是什么」。缺省时含图片的请求 fail-closed 503。
   */
  moderationStore?: ReviewModerationStore
  /**
   * 评价图片送审配置（#694 M5c）：缺省本地 provider（图片恒 REVIEW，仅开发/测试）。
   * 生产装配在 `app.ts`，使用独立的 `TENCENT_IMS_UGC_BIZ_TYPE`。
   */
  reviewImageModeration?: ReviewImageModerationConfig
  /**
   * #694 M8：存量评价图的补审结论。只影响没有 `review_moderation_records` 的旧键；
   * 有台账记录时以台账为准。缺省时维持 #475 的 `reviews/*` ALLOW 兼容。
   */
  legacyMediaDecisions?: (
    objectKeys: readonly string[],
  ) => Promise<ReadonlyMap<string, ModerationDecision>>
}): TransactionReviewService {
  const { store, storage, moderationStore } = deps
  const moderationProvider = deps.moderationProvider ?? createLocalContentModerationProvider()
  const legacyMediaDecisions = deps.legacyMediaDecisions ?? (async () => new Map())

  /**
   * 评价边的所有方法都先过这一道：交易存在且我是参与者，否则 404
   * （transactions 域口径：非参与者与不存在**同码**，不给交易 id 的存在性留探针）。
   */
  async function requireParticipantTransaction(transactionId: string, userId: string) {
    const txn = await store.transactionForParticipant(transactionId, userId)
    if (!txn) throw transactionNotFound()
    return txn
  }

  /**
   * 批量解析一页评价图片的有效结论。任何台账读失败都按 503 处理：
   * 没有结论就不能判断可见性，不能默认 ALLOW。
   */
  async function decisionsOf(rows: MyReviewRow[]): Promise<Map<string, ModerationDecision>> {
    const keys = [...new Set(rows.flatMap((row) => row.imageKeys))]
    const decisions = new Map<string, ModerationDecision>()
    if (keys.length === 0) return decisions
    if (!moderationStore) throw reviewMediaUnavailable()
    let records: Awaited<ReturnType<ReviewModerationStore['findByFinalKeys']>>
    try {
      records = await moderationStore.findByFinalKeys(keys)
    } catch (error) {
      console.error('[transaction-reviews] 读取图片审核记录失败，按 503 服务故障处理', error)
      throw reviewMediaUnavailable()
    }
    for (const record of records) {
      decisions.set(record.finalKey, effectiveReviewModerationDecision(record))
    }
    // #694 M8：补审结论覆盖 #475 的「无记录即 ALLOW」。未审/PENDING/FAILED 返回 REVIEW，
    // BLOCK 返回 BLOCK，因此旧评价图在补审前不会继续以 ALLOW 展示。
    let legacyDecisions: ReadonlyMap<string, ModerationDecision>
    try {
      legacyDecisions = await legacyMediaDecisions(keys)
    } catch (error) {
      console.error('[transaction-reviews] 读取存量图补审记录失败，按 503 服务故障处理', error)
      throw reviewMediaUnavailable()
    }
    for (const key of keys) {
      const decision = legacyDecisions.get(key)
      if (!decisions.has(key) && decision) decisions.set(key, decision)
    }
    // #475 遗留公开键：审核台账上线前固化的 `reviews/` 对象没有记录。它们本来就已公开，
    // 展示按 ALLOW 兼容；**新写入**不受影响——`resolveReviewImages` 仍要求台账存在。
    for (const key of keys) {
      if (!decisions.has(key) && isReviewMediaPublicKey(key)) decisions.set(key, 'ALLOW')
    }
    return decisions
  }

  /** 把已解析的结论挂到行上：`toTransactionReviewItem` 在 comments 侧同步映射时要用。 */
  function withImageDecisions<T extends MyReviewRow>(
    row: T,
    decisions: ReadonlyMap<string, ModerationDecision>,
  ): T {
    const imageModeration: Record<string, ModerationDecision> = {}
    for (const key of row.imageKeys) {
      const decision = decisions.get(key)
      if (decision) imageModeration[key] = decision
    }
    return { ...row, imageModeration }
  }

  /**
   * #475 上传链的授权门：与评价边 POST 同一条门（参与者 → COMPLETED → 尚未评价）。
   * `hasReview` 用 `findMyReview` 现查（评价不可修改，已评过就没有再上传的语义）。
   */
  const media = createReviewMediaService({
    gate: {
      async transactionGate(transactionId, userId) {
        const txn = await store.transactionForParticipant(transactionId, userId)
        if (!txn) return null
        const existing = await store.findMyReview(transactionId, userId)
        return { id: txn.id, status: txn.status, hasReview: existing !== null }
      },
    },
    storage,
    moderationStore,
    moderation: deps.reviewImageModeration,
  })

  /**
   * 引用校验的 stat 用严格语义（#483 审查响应）：只有对象真不存在才是 422「图片无效」，
   * 存储运行错误显式 503。
   */
  async function statReviewImage(key: string) {
    if (!storage.statStrict) throw reviewMediaUnavailable()
    try {
      return await storage.statStrict(key)
    } catch (error) {
      console.error('[transaction-reviews] 引用校验 stat 失败，按 503 服务故障处理', error)
      throw reviewMediaUnavailable()
    }
  }

  /**
   * 评语送审（#694 M6）：只审正文，字段固定 `content`；评分不是文本，不送审。
   *
   * 上游失败必须 fail-closed：超时、限频、网络、配置错误一律 503，不把「没有结论」当通过。
   * 三档结论分开处理：
   * - ALLOW：放行；
   * - BLOCK：确定违规 → 422 `REVIEW_CONTENT_BLOCKED`；
   * - REVIEW：机器给不出确定结论 → 422 `REVIEW_CONTENT_REVIEW_REQUIRED`，**同样不落库**，
   *   但错误码 / 文案 / 审计与 BLOCK 区分。评价当前没有人工复审流水线，因此取「拒绝创建
   *   但保留待审语义」的兜底（#694 M6 允许）；接入队列后应改为随评价进入待审状态。
   */
  async function moderateBody(body: string): Promise<TextModerationResult> {
    try {
      return await moderatePublicUgcText(moderationProvider, { kind: 'review', content: body })
    } catch (error) {
      if (error instanceof ContentModerationError) {
        // 审计：只记原因与上游请求标识，不记评语正文。
        console.error('[transaction-reviews] 内容审核不可用，评价未落库', {
          reason: error.reason,
          retryable: error.retryable,
          requestId: error.requestId,
        })
        throw new TransactionReviewServiceError(
          503,
          'CONTENT_MODERATION_UNAVAILABLE',
          '内容审核暂时不可用，请稍后重试',
        )
      }
      throw error
    }
  }

  async function assertBodyAllowed(body: string): Promise<void> {
    const result = await moderateBody(body)

    if (result.decision === 'BLOCK') {
      throw new TransactionReviewServiceError(422, 'REVIEW_CONTENT_BLOCKED', '评价内容未通过审核', [
        { field: 'body', message: '评价内容未通过审核' },
      ])
    }
    if (result.decision === 'REVIEW') {
      throw new TransactionReviewServiceError(
        422,
        'REVIEW_CONTENT_REVIEW_REQUIRED',
        '评价内容需要人工复核，暂时无法发布，请修改后重试',
        [{ field: 'body', message: '评价内容待人工复核' }],
      )
    }
  }

  /**
   * 写侧引用校验（#694 M5c）：键必须来自本用户某次 confirm 的台账，且有效结论不是 BLOCK。
   * - ALLOW → 只认公开键；REVIEW → 只认私有待审键（键域与结论必须一致）；
   * - 台账缺行/归属不符 → 与「没审过」同码 422（不给他人对象的存在性侧信道）；
   * - 结论 BLOCK → 独立码，让端上明确「换图」而不是「重试」；
   * - 再 stat 一次挡掉被替换/损坏的对象（需求 3 的摘要在 confirm/放行时已绑定）。
   */
  async function resolveReviewImages(
    userId: string,
    imageKeys: string[],
  ): Promise<Map<string, ModerationDecision>> {
    const decisions = new Map<string, ModerationDecision>()
    if (imageKeys.length === 0) return decisions
    if (!moderationStore) throw reviewMediaUnavailable()

    let records: Awaited<ReturnType<ReviewModerationStore['findByFinalKeys']>>
    try {
      records = await moderationStore.findByFinalKeys(imageKeys)
    } catch (error) {
      console.error('[transaction-reviews] 读取图片审核记录失败，按 503 服务故障处理', error)
      throw reviewMediaUnavailable()
    }
    const byKey = new Map(records.map((record) => [record.finalKey, record]))

    for (const key of imageKeys) {
      const publicOwned =
        isReviewMediaPublicKey(key) && key.startsWith(reviewMediaPublicPrefix(userId))
      const privateOwned =
        isReviewModerationMediaKey(key) && key.startsWith(reviewModerationMediaPrefix(userId))
      if (!publicOwned && !privateOwned) throw reviewImageInvalid()

      const record = byKey.get(key)
      if (!record || record.userId !== userId) throw reviewImageInvalid()
      const decision = effectiveReviewModerationDecision(record)
      if (decision === 'BLOCK') throw reviewImageBlocked()
      // 键域与结论必须一致：公开键必须是 ALLOW，私有键必须是 REVIEW（放行后台账改公开键）。
      if (decision === 'ALLOW' && !publicOwned) throw reviewImageInvalid()
      if (decision === 'REVIEW' && !privateOwned) throw reviewImageInvalid()

      const stat = await statReviewImage(key)
      if (
        !stat ||
        stat.size > MAX_IMAGE_BYTES ||
        !(ALLOWED_IMAGE_MIME as readonly string[]).includes(stat.contentType)
      ) {
        throw reviewImageInvalid()
      }
      decisions.set(key, decision)
    }
    return decisions
  }

  return {
    media,
    async getMyReview(userId, transactionId) {
      await requireParticipantTransaction(transactionId, userId)
      const row = await store.findMyReview(transactionId, userId)
      if (!row) throw reviewNotFound()
      const decisions = await decisionsOf([row])
      const dto = toReviewDto(
        row,
        encodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId),
        storage,
        decisions,
      )
      if (!dto) throw reviewNotFound()
      return dto
    },

    async createReview(userId, transactionId, input) {
      const txn = await requireParticipantTransaction(transactionId, userId)
      // 冻结口径：只有 COMPLETED 可评。409 而不是 422 —— 请求本身合法，是交易当前状态不允许；
      // 终态不可逆，客户端重试无意义。
      if (txn.status !== 'COMPLETED') throw notCompleted()

      // 评语：trim 后空 = 没写评语（落库 null）。router 已按契约 trim，这里自兜一遍
      // —— service 不该依赖「上游一定解析过 schema」。
      const trimmed = input.body?.trim() ?? ''
      const body = trimmed === '' ? null : trimmed
      // 没有正文的评价只校验所附图片（见下），不送文本审核；评分 / 结构化字段不送审。
      if (body !== null) await assertBodyAllowed(body)

      // #475 配图：契约已限长与去重，service 自兜一遍（不依赖「上游一定解析过 schema」）。
      const imageKeys = input.imageObjectKeys ?? []
      if (imageKeys.length > MAX_REVIEW_IMAGES) {
        throw reviewImagesInvalidInput(`最多上传 ${MAX_REVIEW_IMAGES} 张图片`)
      }
      if (new Set(imageKeys).size !== imageKeys.length) {
        throw reviewImagesInvalidInput('图片对象键不能重复')
      }
      const decisions = await resolveReviewImages(userId, imageKeys)

      const inserted = await store.insertReviewWithImages({
        transactionId,
        authorId: userId,
        rating: input.rating,
        body,
        imageKeys,
      })
      // 唯一索引兜住并发：两个「第一次评价」同时到达，只有一个插得进去，另一个 409。
      if (!inserted) throw reviewExists()
      const dto = toReviewDto(
        inserted,
        encodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId),
        storage,
        decisions,
      )
      if (!dto) throw new TransactionReviewServiceError(404, 'REVIEW_NOT_FOUND', '评价不存在')
      return dto
    },

    async deleteMyReview(userId, transactionId) {
      await requireParticipantTransaction(transactionId, userId)
      const deleted = await store.deleteOwnReview(transactionId, userId)
      return { deleted }
    },

    async listReviewsOf(userId, transactionId) {
      await requireParticipantTransaction(transactionId, userId)
      const rows: TransactionReviewRow[] = await store.listReviewsOf(transactionId)
      const decisions = await decisionsOf(rows)
      const items = rows.flatMap((row) => {
        // 对方视角：含未放行图片的评价整条不出现；作者视角：保留并逐图标注状态。
        if (row.authorId !== userId && !hasOnlyPublicImages(row, decisions)) return []
        const review = toReviewDto(
          row,
          encodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId),
          storage,
          decisions,
        )
        return review ? [{ review, authorRole: row.authorRole }] : []
      })
      return TransactionReviewsResponseSchema.parse({ items })
    },

    async listMine(userId, query) {
      // listMineRows 返回的是未截断的 limit+1 行；截断与游标在这里收口。
      const { rows, total } = await this.listMineRows(userId, query)
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const items = page
        .map((row) => toTransactionReviewItem(row, userId, storage))
        .filter((item): item is TransactionReviewItem => item !== null)
      const last = page.at(-1)
      const nextCursor = hasMore && last ? encodeReviewCursor(last) : null
      return { items, nextCursor, total }
    },

    async listMineRows(userId, query) {
      // 与 comments 的 listMine 同款：多取一行判 hasMore，截断交给调用方
      // （kind=all 的合并归并要先拿两边的原始行）。
      const rows = await store.listByAuthor(userId, query.limit + 1, query.cursor)
      const decisions = await decisionsOf(rows)
      const total = await store.countByAuthor(userId)
      // 结论挂到行上：comments 侧同步映射 `toTransactionReviewItem` 时无需再查库。
      return { rows: rows.map((row) => withImageDecisions(row, decisions)), total }
    },
  }
}
