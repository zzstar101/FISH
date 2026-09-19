import {
  type CommentAuthor,
  CommentAuthorSchema,
  type CommentCreateInput,
  type CommentDto,
  CommentDtoSchema,
  type CommentListQuery,
  type CommentListResponse,
} from '@fish/contracts/comments/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { createModerationService, type ModerationService } from '../moderation/service'
import { decodeCommentCursor, encodeCommentCursor } from './cursor'
import type { CommentRow, CommentStore } from './store'

/**
 * 留言业务失败 → HTTP 语义。
 *
 * `code` 取值域由契约的 `CommentErrorCodeSchema` 收窄；`VALIDATION_FAILED` 是本域
 * 借用 system 通用码的场景（非法 cursor / 回复一条回复），因此类型上单列。
 * `details` 让 422 能定位到输入框（与 listings 的 422 同一口径）。
 */
export class CommentServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code:
      | 'LISTING_NOT_FOUND'
      | 'COMMENT_NOT_FOUND'
      | 'COMMENT_CONTENT_BLOCKED'
      | 'VALIDATION_FAILED',
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
}

/**
 * `users.avatar_url` 是无约束 `text`，契约声明它是 `z.url().nullable()`：
 * 值域外的历史值降级为 `null`，不让一个用户的脏头像把整页留言打成 500
 * （与 listings 的 `toSeller` 同一取舍）。
 */
function toAuthor(row: CommentRow): CommentAuthor {
  return {
    id: row.authorId,
    nickname: row.authorNickname,
    avatarUrl: CommentAuthorSchema.shape.avatarUrl.safeParse(row.authorAvatarUrl).data ?? null,
  }
}

/** 回复 DTO：`replies` 恒为空数组（契约只嵌套一层）。 */
function toReplyDto(row: CommentRow, sellerId: string): CommentDto | null {
  const parsed = CommentDtoSchema.safeParse({
    id: row.id,
    listingId: row.listingId,
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
  replies: CommentDto[],
): CommentDto | null {
  const parsed = CommentDtoSchema.safeParse({
    id: row.id,
    listingId: row.listingId,
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
}): CommentService {
  const { store } = deps
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

  return {
    async listComments(listingId, query) {
      const sellerId = await requireSellerId(listingId)

      // 非法 / 伪造的游标一律 422，不宽容解析（与 listings feed §2.1 同口径）。
      const cursor = query.cursor ? decodeCommentCursor(query.cursor) : null
      if (query.cursor && !cursor) {
        throw new CommentServiceError(422, 'VALIDATION_FAILED', 'cursor 无效')
      }

      // 多取一行判断还有没有下一页（契约不另给 hasMore）。
      const rows = await store.listTopLevel(listingId, query.limit + 1, cursor)
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      const repliesByParent = new Map<string, CommentDto[]>()
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

      const id = await store.insert({
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
        throw new CommentServiceError(422, 'VALIDATION_FAILED', '只能回复顶层留言')
      }

      const sellerId = await requireSellerId(parent.listingId)
      assertContentAllowed(input.content)

      const id = await store.insert({
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
  }
}
