/**
 * 留言游标编解码（#111，与 listings feed §2.1 同口径）。
 *
 * 契约规定 cursor 对前端是**不透明字符串**：base64url(JSON) 承载 `(created_at, id)`。
 * 排序键之外还要带 `id` 做 tie-break —— 同一微秒写入的多条留言必须有确定顺序，
 * 否则翻页边界会重复或跳项。
 *
 * 解码失败一律 `null`（路由层报 422），不做宽容解析：伪造 / 截断的游标被当成合法起点
 * 会让人看到静默错乱的列表，比直接报错难查。
 */
import { CommentCursorTimestampSchema, CommentIdSchema } from '@fish/contracts/comments/schema'
import type { CommentCursor } from './store'

export function encodeCommentCursor(cursor: CommentCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCommentCursor(raw: string): CommentCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const { createdAt, id } = parsed as Record<string, unknown>

  // id 会被绑到 `comments.id`（uuid 列）：非 UUID 是 SQL 类型错误 → 500，而契约要求 422。
  if (typeof id !== 'string' || !CommentIdSchema.safeParse(id).success) return null
  // 值域在入口校验：形状合法但日期非法的串会被 PG 拒绝成 500，契约要 422。
  if (typeof createdAt !== 'string' || !CommentCursorTimestampSchema.safeParse(createdAt).success) {
    return null
  }

  return { createdAt, id }
}
