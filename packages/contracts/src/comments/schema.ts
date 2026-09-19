import { z } from 'zod'

/**
 * Comment Domain Contract（Issue #111）。
 *
 * 商品详情留言 / 评论的读模型与写请求。路径常量在同目录的 `routes.ts`（随 #89 落地），
 * DB 表见 `packages/db/src/schema/comments.ts`。前端与 API 只依赖本目录的字段定义。
 *
 * 两条写进契约的决定：
 *
 * 1. **`isSeller` 由服务端判定**：作者是不是「这件商品的卖家」要拿 `comments.author_id`
 *    与该 listing 的 `seller_id` 比较。交给客户端猜等于允许伪造「卖家」标签。
 * 2. **回复只嵌套一层**（`replies` 里的 `CommentDto.replies` 恒为空数组）：设计稿的
 *    留言区只渲染一层回复；放开多层会让读模型从"列表"变成"树"，分页与计数都没了稳定口径。
 *    回复一条回复会被服务端 422 拒绝，而不是静默压平（压平会丢失"回给谁"的语义）。
 */

/** 留言正文上限（DB 是裸 `text`，长度只由契约收口）。 */
export const COMMENT_CONTENT_MAX = 200

/**
 * 留言正文。前后空白先 trim 再判长度：只由空格组成的留言必须被拒，而不是落库成一条空白。
 */
export const CommentContentSchema = z
  .string()
  .trim()
  .min(1, '留言不能为空')
  .max(COMMENT_CONTENT_MAX, `留言最多 ${COMMENT_CONTENT_MAX} 个字`)

export type CommentContent = z.infer<typeof CommentContentSchema>

/**
 * 留言作者公开信息。不含学号 / 真实姓名（与 `auth` 的 `MeSchema` 同一取舍）。
 *
 * `avatarUrl` 走 `z.url().nullable()`：库里 `users.avatar_url` 是无约束 `text`，
 * 历史脏值由服务端降级成 `null`，不允许一个用户的脏头像让整页留言 500。
 */
export const CommentAuthorSchema = z.object({
  id: z.uuid(),
  nickname: z.string(),
  avatarUrl: z.url().nullable(),
})

export type CommentAuthor = z.infer<typeof CommentAuthorSchema>

/**
 * 回复读模型：与顶层留言字段相同，但 `replies` **必须是空数组**。
 *
 * 契约只允许嵌套一层（见文件头决定 2），所以这里不能用自引用 schema 宽松接受任意深度：
 * 一个「回复的回复」或更深层的漂移响应必须在本层 parse 失败，而不是被渲染成
 * 页面不支持的评论树。`z.tuple([])` 只接受 `[]`。
 */
export type CommentReply = {
  id: string
  listingId: string
  author: CommentAuthor
  content: string
  createdAt: string
  /** 作者是否 = 该商品的卖家（页面「卖家」标签）。服务端判定，客户端不参与。 */
  isSeller: boolean
  replies: []
}

export const CommentReplySchema: z.ZodType<CommentReply> = z.object({
  id: z.uuid(),
  listingId: z.uuid(),
  author: CommentAuthorSchema,
  content: CommentContentSchema,
  createdAt: z.iso.datetime(),
  isSeller: z.boolean(),
  replies: z.tuple([]),
})

/**
 * 顶层留言读模型。`replies` 只嵌套一层，元素是**回复** schema（其 `replies` 恒为空）。
 *
 * 顶层与回复的字段集合保持一份定义（`CommentReplySchema` 的形状），避免两处漂移；
 * 差异只在 `replies` 的值域上。
 */
export type CommentDto = Omit<CommentReply, 'replies'> & {
  replies: CommentReply[]
}

export const CommentDtoSchema: z.ZodType<CommentDto> = z.object({
  id: z.uuid(),
  listingId: z.uuid(),
  author: CommentAuthorSchema,
  content: CommentContentSchema,
  createdAt: z.iso.datetime(),
  isSeller: z.boolean(),
  replies: z.array(CommentReplySchema),
})

/**
 * 留言游标里时间戳的形态：**带微秒**的 UTC ISO 时间，与 listings feed（契约 §2.1）同口径。
 *
 * 为什么不用 `Date.toISOString()`：JS `Date` 只有毫秒，而 `created_at` 是 timestamptz（微秒）。
 * 截断后同毫秒的边界行会在翻页里被跳过；用 zod 而不是手写正则，是为了让
 * `2026-13-45T…` 这类形状合法但值域非法的串在入口就被拒（否则会被 PG 拒绝成 500，而契约要 422）。
 */
export const CommentCursorTimestampSchema = z.iso.datetime({ precision: 6 })

/** 商品 id / 留言 id 的形状：路由参数与游标里的 id 都用它校验，避免非 uuid 打到 PG 变 500。 */
export const CommentIdSchema = z.uuid()

/**
 * 列表查询。`cursor` 是不透明串（服务端对 `(created_at, id)` 编码），前端禁止解析或构造，
 * 只能原样回传上一页的 `nextCursor`。`limit` 默认 20、上限 50。
 */
export const CommentListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
})

export type CommentListQuery = z.infer<typeof CommentListQuerySchema>

/**
 * 列表响应。不另给 `hasMore`（与 `nextCursor !== null` 表达同一信息），
 * 也不给 `total`：留言区不做总数分页，`total` 需要额外一次 COUNT。
 */
export const CommentListResponseSchema = z.object({
  items: z.array(CommentDtoSchema),
  nextCursor: z.string().nullable(),
})

export type CommentListResponse = z.infer<typeof CommentListResponseSchema>

/**
 * 写请求体。`.strictObject()`：多余字段直接 422，与 listings / auth 的写请求同一取舍。
 */
export const CommentCreateInputSchema = z.strictObject({
  content: CommentContentSchema,
})

export type CommentCreateInput = z.infer<typeof CommentCreateInputSchema>

/**
 * 本 domain 新增的错误码。其余复用 system 的 `VALIDATION_FAILED`（422，非法游标 /
 * 回复一条回复 / 正文未过审核）与 auth 的 `UNAUTHENTICATED`（401）。
 *
 * 422 响应携带字段级 `details`（与 listings 的 422 同口径）：非法游标报 `cursor`，
 * 回复一条回复报 `commentId`（没有同名输入框，前端按 code 提示即可）。
 */
export const CommentErrorCodeSchema = z.enum([
  /** 404：留言所属商品不存在（含非法 uuid 的路径参数，直接 404 不打到 PG）。 */
  'LISTING_NOT_FOUND',
  /** 404：要回复的留言不存在（不区分「不存在」与「已被删除」，不泄漏存在性）。 */
  'COMMENT_NOT_FOUND',
  /** 422：正文命中服务端敏感词库（判定见 `apps/api/src/modules/moderation`）。 */
  'COMMENT_CONTENT_BLOCKED',
])

export type CommentErrorCode = z.infer<typeof CommentErrorCodeSchema>
