import { ALLOWED_IMAGE_MIME, MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
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
import { createModerationService, type ModerationService } from '../moderation/service'
import { publicAvatarUrl } from '../uploads/avatar-url'
import type { MediaStorage } from '../uploads/storage'
import { isReviewMediaPublicKey, reviewMediaPublicPrefix } from '../uploads/storage'
import { createReviewMediaService, type ReviewMediaService } from './media-service'
import type { MyReviewRow, ReviewTimelineRow, TransactionReviewsStore } from './store'

export class TransactionReviewServiceError extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
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
): TransactionReview | null {
  const parsed = TransactionReviewSchema.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.review, row.id),
    transactionId: transactionPublicId,
    rating: row.rating,
    body: row.body,
    images: row.imageKeys.map((objectKey) => ({ url: storage.publicUrl(objectKey) })),
    createdAt: row.createdAt,
  })
  if (!parsed.success) {
    console.error('[transaction-reviews] 跳过无法映射为契约的评价', row.id, parsed.error.message)
    return null
  }
  return parsed.data
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
  moderation?: ModerationService
}): TransactionReviewService {
  const { store, storage } = deps
  const moderation = deps.moderation ?? createModerationService()

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
   * #475 上传链的授权门：与评价边 POST 同一条门（参与者 → COMPLETED → 尚未评价）。
   * `hasReview` 用 `findMyReview` 现查（评价不可修改，已评过就没有再上传的语义）。
   */
  const media = createReviewMediaService({
    gate: {
      async transactionGate(transactionId, userId) {
        const txn = await store.transactionForParticipant(transactionId, userId)
        if (!txn) return null
        const existing = await store.findMyReview(transactionId, userId)
        return { status: txn.status, hasReview: existing !== null }
      },
    },
    storage,
  })

  return {
    media,
    async getMyReview(userId, transactionId) {
      await requireParticipantTransaction(transactionId, userId)
      const row = await store.findMyReview(transactionId, userId)
      if (!row) throw reviewNotFound()
      const dto = toReviewDto(
        row,
        encodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId),
        storage,
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
      if (body !== null) {
        // 与 comments 同一规则库（#74）：正文按 `title` 传入，BLOCK 与 REVIEW 都拒绝 ——
        // 评价没有「人工复审后可见」的流水线，放行 REVIEW 等于让外联文案直接可见。
        const result = moderation.moderate({ title: body, description: '' })
        if (result.decision !== 'ALLOW') {
          throw new TransactionReviewServiceError(
            422,
            'REVIEW_CONTENT_BLOCKED',
            '评价内容未通过审核',
            [{ field: 'body', message: '评价内容未通过审核' }],
          )
        }
      }

      // #475 配图：契约已限长与去重，service 自兜一遍（不依赖「上游一定解析过 schema」）。
      const imageKeys = input.imageObjectKeys ?? []
      if (imageKeys.length > MAX_REVIEW_IMAGES) {
        throw reviewImagesInvalidInput(`最多上传 ${MAX_REVIEW_IMAGES} 张图片`)
      }
      if (new Set(imageKeys).size !== imageKeys.length) {
        throw reviewImagesInvalidInput('图片对象键不能重复')
      }
      // 逐个校验：只认本上传链 confirm 固化到**公开 final 前缀**、且归属当前用户的键。
      // presign 永不签 final 前缀 → 「键在 final 前缀下存在」即证明经过服务端 confirm；
      // 再加一次 stat（大小/MIME）挡掉被替换/损坏的对象。
      for (const key of imageKeys) {
        if (!isReviewMediaPublicKey(key) || !key.startsWith(reviewMediaPublicPrefix(userId))) {
          throw reviewImageInvalid()
        }
        const stat = await storage.stat(key)
        if (
          !stat ||
          stat.size > MAX_IMAGE_BYTES ||
          !(ALLOWED_IMAGE_MIME as readonly string[]).includes(stat.contentType)
        ) {
          throw reviewImageInvalid()
        }
      }

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
      const rows = await store.listReviewsOf(transactionId)
      const items = rows.flatMap((row) => {
        const review = toReviewDto(
          row,
          encodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId),
          storage,
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
      const total = await store.countByAuthor(userId)
      return { rows, total }
    },
  }
}
