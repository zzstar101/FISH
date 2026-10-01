import {
  type CommentAuthor,
  type CommentCreateInput,
  type CommentDeleteResponse,
  type CommentDto,
  CommentDtoSchema,
  type CommentErrorCode,
  type CommentListQuery,
  type CommentListResponse,
  type CommentReply,
  CommentReplySchema,
  type MyCommentItem,
  MyCommentItemSchema,
  type MyCommentsQuery,
  type MyCommentsResponse,
  MyCommentsResponseSchema,
} from '@fish/contracts/comments/schema'
import type { ApiErrorDetail, SystemErrorCode } from '@fish/contracts/system/error'
import { isForeignKeyViolation } from '@fish/db/pg-errors'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { toListingCard } from '../listings/card'
import { createModerationService, type ModerationService } from '../moderation/service'
import { publicAvatarUrl } from '../uploads/avatar-url'
import type { MediaStorage } from '../uploads/storage'
import { decodeCommentCursor, encodeCommentCursor } from './cursor'
import type { CommentRow, CommentStore, MyCommentRow } from './store'

/**
 * 留言业务失败 → HTTP 语义。
 *
 * `code` 取值域由契约的 `CommentErrorCodeSchema` 收窄（`CommentErrorCode`）；`VALIDATION_FAILED`
 * 直接取 system 的 `SystemErrorCode` 成员（不是重写字面量），重命名会在这里编译失败。
 * `details` 让 422 能定位到具体字段（与 listings 的 422 同一口径）。
 */
export class CommentServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: CommentErrorCode | Extract<SystemErrorCode, 'VALIDATION_FAILED'>,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'CommentServiceError'
  }
}

const listingNotFound = () => new CommentServiceError(404, 'LISTING_NOT_FOUND', '商品不存在')
const commentNotFound = () => new CommentServiceError(404, 'COMMENT_NOT_FOUND', '留言不存在')

export interface CommentService {
  listComments(listingId: string, query: CommentListQuery): Promise<CommentListResponse>
  createComment(userId: string, listingId: string, input: CommentCreateInput): Promise<CommentDto>
  createReply(userId: string, commentId: string, input: CommentCreateInput): Promise<CommentDto>
  /** 「我发过的留言」（#195）：**本人作用域**，作者由路由从可信 context 取，不接受请求参数。 */
  listMine(userId: string, query: MyCommentsQuery): Promise<MyCommentsResponse>
  /**
   * 删除自己的留言（#195）。
   *
   * - **存在但不是本人的** → 404 `COMMENT_NOT_FOUND`（403 会确认「它存在且是别人的」）；
   * - **不存在 / 已经被删过** → `{ deleted: 0 }`，**幂等成功**而不是错误。
   *
   *   这两条**不是同码**：留言 id 本来就能通过匿名 `GET /listings/:id/comments` 公开枚举，
   *   所以这里不做「不泄漏存在性」的混淆取舍 —— 404 只表示「存在，但不是你的」。
   * - 删顶层留言会级联删掉其回复，`deleted` 回**实际删除的 DB 行数**（含他人写的回复），
   *   且是尽力而为的近似值；端上**不得**用它减「我发过的留言」总数，
   *   见 `CommentDeleteResponseSchema` 的注释。
   */
  deleteMine(userId: string, commentId: string): Promise<CommentDeleteResponse>
}

/**
 * `users.avatar_url` 是无约束 `text`，契约声明它是 `z.url().nullable()`：
 * 值域外的历史值降级为 `null`，不让一个用户的脏头像把整页留言打成 500
 * （与 listings 的 `toSeller` 同一取舍）。
 */
function toAuthor(row: CommentRow): CommentAuthor {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, row.authorId),
    nickname: row.authorNickname,
    avatarUrl: publicAvatarUrl(row.authorAvatarUrl),
  }
}

/**
 * 「我发过的留言」一行 → 契约项（#195）。
 *
 * 卡片交给共享投影 `toListingCard`，且**不传**审核态三参数 —— 收藏/留言列表都是买家视角，
 * `moderationStatus` / `governanceDelisted` 恒为 `null`。
 * 组装失败（脏行）返回 `null`，由调用方跳过，不让一条脏数据把整页打不开（决策 C）。
 */
function toMyCommentItem(
  row: MyCommentRow,
  storage: Pick<MediaStorage, 'publicUrl'>,
): MyCommentItem | null {
  const listing = toListingCard(row, row.coverObjectKey, storage)
  if (listing === null) return null

  // 与 `listComments` 同款（决策 C）：**逐条**校验，脏行记日志后跳过，而不是让一条越界数据
  // （例如 `content` 超过契约上限的历史行）把整页 parse 失败成 500。
  const parsed = MyCommentItemSchema.safeParse({
    comment: {
      id: encodePublicId(PUBLIC_ID_PREFIX.comment, row.commentId),
      listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.id),
      parentId:
        row.commentParentId === null
          ? null
          : encodePublicId(PUBLIC_ID_PREFIX.comment, row.commentParentId),
      content: row.commentContent,
      createdAt: row.commentCreatedAt,
    },
    listing,
  })
  if (!parsed.success) {
    console.error('[comments] 跳过无法映射为契约的本人留言', row.commentId, parsed.error.message)
    return null
  }
  return parsed.data
}

/** 回复 DTO：`replies` 恒为空数组（契约只嵌套一层，`CommentReplySchema` 强制）。 */
function toReplyDto(row: CommentRow, sellerId: string): CommentReply | null {
  const parsed = CommentReplySchema.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.comment, row.id),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
    author: toAuthor(row),
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    isSeller: row.authorId === sellerId,
    replies: [],
  })
  return parsed.success ? parsed.data : null
}

/**
 * 顶层留言 DTO。`sellerId` 是该 listing 的卖家，`isSeller` 由服务端比较得出。
 */
function toTopLevelDto(
  row: CommentRow,
  sellerId: string,
  replies: CommentReply[],
): CommentDto | null {
  const parsed = CommentDtoSchema.safeParse({
    id: encodePublicId(PUBLIC_ID_PREFIX.comment, row.id),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
    author: toAuthor(row),
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    isSeller: row.authorId === sellerId,
    replies,
  })
  return parsed.success ? parsed.data : null
}

export function createCommentService(deps: {
  store: CommentStore
  moderation?: ModerationService
  /** 只取 `publicUrl`：「公开 URL 怎么拼」只允许有一个实现（#6 契约 §7.8）。 */
  storage: Pick<MediaStorage, 'publicUrl'>
}): CommentService {
  const { store, storage } = deps
  const moderation = deps.moderation ?? createModerationService()

  /**
   * 正文敏感词校验。
   *
   * 复用 #74 的规则库（`moderation/rules.ts`），把留言正文当作 `title` 传入
   * （规则只按字段名回填 `matches[].field`，这里只关心结论）。
   *
   * **BLOCK 与 REVIEW 都拒绝**：留言没有「人工复审」这条流水线（列表页不渲染待审状态），
   * 放行 REVIEW 等于让「加微信 / 二维码」这类外联文案直接可见。命中即 422，
   * `details` 指到 `content` 字段，前端能把它定位到输入框。
   */
  function assertContentAllowed(content: string): void {
    const result = moderation.moderate({ title: content, description: '' })
    if (result.decision !== 'ALLOW') {
      throw new CommentServiceError(422, 'COMMENT_CONTENT_BLOCKED', '留言内容未通过审核', [
        { field: 'content', message: '留言内容未通过审核' },
      ])
    }
  }

  /** 商品不存在时列表 / 写接口都 404（写操作先判存在性再校验内容，避免为不存在的商品泄露规则）。 */
  async function requireSellerId(listingId: string): Promise<string> {
    const sellerId = await store.findListingSellerId(listingId)
    if (!sellerId) throw listingNotFound()
    return sellerId
  }

  /**
   * 写留言 / 回复的落库，把「商品在写入的一瞬间被删掉」翻成 404。
   *
   * 存在性检查（`requireSellerId`）与 INSERT 不在同一个事务里，而 #74 给商品加了**物理删除**：
   * 两步之间商品被删掉时，`comments_listing_id_listings_id_fk` 会拒绝这次写入。
   * 那是并发下的正常结果（商品没了），不是服务端故障 —— 不接住的话 23503 走 `app.onError`
   * 变成 500，而契约要求 404 `LISTING_NOT_FOUND`。
   *
   * 回复路径（`createReply`）也走这里：它先读父留言拿到 `listingId`，父留言能读到说明当时
   * 商品还在，但同样的窗口存在（父留言随商品级联删除）。
   */
  async function insertComment(input: {
    listingId: string
    authorId: string
    parentId: string | null
    content: string
  }): Promise<string> {
    try {
      return await store.insert(input)
    } catch (error) {
      if (isForeignKeyViolation(error)) throw listingNotFound()
      throw error
    }
  }

  return {
    async listComments(listingId, query) {
      const sellerId = await requireSellerId(listingId)

      // 非法 / 伪造的游标一律 422，不宽容解析（与 listings feed §2.1 同口径）。
      const cursor = query.cursor ? decodeCommentCursor(query.cursor) : null
      if (query.cursor && !cursor) {
        throw new CommentServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
          { field: 'cursor', message: 'cursor 无效' },
        ])
      }

      // 多取一行判断还有没有下一页（契约不另给 hasMore）。
      const rows = await store.listTopLevel(listingId, query.limit + 1, cursor)
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      const repliesByParent = new Map<string, CommentReply[]>()
      if (page.length > 0) {
        const replies = await store.listReplies(page.map((row) => row.id))
        for (const reply of replies) {
          if (!reply.parentId) continue
          const dto = toReplyDto(reply, sellerId)
          if (!dto) {
            console.error('[comments] 跳过无法映射为契约的回复', reply.id)
            continue
          }
          const list = repliesByParent.get(reply.parentId)
          if (list) list.push(dto)
          else repliesByParent.set(reply.parentId, [dto])
        }
      }

      const items = page.flatMap((row) => {
        const dto = toTopLevelDto(row, sellerId, repliesByParent.get(row.id) ?? [])
        if (!dto) {
          console.error('[comments] 跳过无法映射为契约的留言', row.id)
          return []
        }
        return [dto]
      })

      const last = page.at(-1)
      // 游标基于**最后一条已返回**的行，而不是 limit+1 那一条，否则会漏掉一条留言。
      const nextCursor =
        hasMore && last
          ? encodeCommentCursor({ createdAt: last.createdAtCursor, id: last.id })
          : null

      return { items, nextCursor }
    },

    async createComment(userId, listingId, input) {
      const sellerId = await requireSellerId(listingId)
      assertContentAllowed(input.content)

      const id = await insertComment({
        listingId,
        authorId: userId,
        parentId: null,
        content: input.content,
      })

      const row = await store.findById(id)
      const dto = row ? toTopLevelDto(row, sellerId, []) : null
      if (!dto) throw new CommentServiceError(404, 'COMMENT_NOT_FOUND', '留言不存在')
      return dto
    },

    async createReply(userId, commentId, input) {
      const parent = await store.findById(commentId)
      if (!parent) throw commentNotFound()

      // 契约只允许嵌套一层：回复一条回复会被拒，而不是静默压平成顶层回复。
      if (parent.parentId !== null) {
        throw new CommentServiceError(422, 'VALIDATION_FAILED', '只能回复顶层留言', [
          { field: 'commentId', message: '只能回复顶层留言' },
        ])
      }

      const sellerId = await requireSellerId(parent.listingId)
      assertContentAllowed(input.content)

      const id = await insertComment({
        listingId: parent.listingId,
        authorId: userId,
        parentId: commentId,
        content: input.content,
      })

      const row = await store.findById(id)
      const dto = row ? toReplyDto(row, sellerId) : null
      if (!dto) throw new CommentServiceError(404, 'COMMENT_NOT_FOUND', '留言不存在')
      return dto
    },

    async listMine(userId, query) {
      const cursor = query.cursor === undefined ? null : decodeCommentCursor(query.cursor)
      // 非法游标 → 422（不宽容解析：被当成合法起点会让列表静默错乱）。
      if (query.cursor !== undefined && cursor === null) {
        throw new CommentServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
          { field: 'cursor', message: 'cursor 无效' },
        ])
      }

      const [rows, total] = await Promise.all([
        // 与 listTopLevel 同款：多取一行判 hasMore，返回前丢掉。
        store.listByAuthor(userId, query.limit + 1, cursor),
        store.countByAuthor(userId),
      ])

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)

      return MyCommentsResponseSchema.parse({
        items: page
          .map((row) => toMyCommentItem(row, storage))
          .filter((item): item is MyCommentItem => item !== null),
        nextCursor:
          hasMore && last
            ? encodeCommentCursor({ createdAt: last.commentCreatedAtCursor, id: last.commentId })
            : null,
        total,
      })
    },

    async deleteMine(userId, commentId) {
      const row = await store.findById(commentId)
      // 不存在（含「自己刚删过」）→ 幂等成功：不报错，也不假装删掉了东西。
      if (row === null) return { deleted: 0 }
      // 存在但不是本人的 → 404（403 会确认「它存在且是别人的」）。注意这与上一条**不同码**：
      // 留言 id 可由匿名接口公开枚举，这里不做存在性混淆，404 的语义就是「不是你的」。
      if (row.authorId !== userId) throw commentNotFound()

      // 级联删掉的回复不出现在 `DELETE ... RETURNING` 里，先数一遍再删。
      // 两次往返之间无锁：`deleted` 因此是**尽力而为的近似值**（差 1 的量级），
      // 它不参与鉴权也不参与计数口径，不值得为它引入事务。
      const replies = row.parentId === null ? await store.countReplies(commentId) : 0
      const deleted = await store.deleteOwn(userId, commentId)
      // 并发下被人抢先删掉 → 0，仍然是幂等语义。
      if (deleted === 0) return { deleted: 0 }
      return { deleted: deleted + replies }
    },
  }
}
