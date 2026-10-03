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
import { ReviewIdSchema } from '@fish/contracts/system/public-id'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { CommentCursor } from './store'

/**
 * 「我发过的」时间线的来源档位（#195 PR2）：游标里带 `source`，因为合并时间线的
 * 下一页可能从另一张表取行 —— id 前缀（`cmt_` / `rvw_`）必须按来源校验与解码。
 * PR1 时代签出的旧游标没有 `source`，按 `comment` 解释（那些游标只可能来自留言页）。
 */
export type MyCommentsCursorSource = 'comment' | 'review'

export function encodeCommentCursor(
  cursor: CommentCursor,
  source: MyCommentsCursorSource = 'comment',
): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      source,
      id: encodePublicId(
        source === 'review' ? PUBLIC_ID_PREFIX.review : PUBLIC_ID_PREFIX.comment,
        cursor.id,
      ),
    }),
    'utf8',
  ).toString('base64url')
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

  return { createdAt, id: decodePublicId(PUBLIC_ID_PREFIX.comment, id) }
}

/**
 * 「我发过的」时间线（`GET /me/comments`）的游标解码：按 `kind` 校验来源。
 *
 * - `kind=comment` 只认留言游标（含 PR1 旧游标），`kind=review` 只认评价游标 ——
 *   拿错来源的游标翻页等于在错误的表里 seek，宁可 422 也不静默错乱；
 * - `kind=all` 两种都认（合并时间线的翻页游标由上一页最后一行的来源决定）。
 *
 * 返回的 `id` 已解码为 uuid，`source` 告诉调用方去哪张表 seek。
 */
export function decodeMyCommentsCursor(
  raw: string,
  kind: 'all' | 'comment' | 'review',
): { createdAt: string; id: string; source: MyCommentsCursorSource } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { createdAt, id, source: rawSource } = parsed as Record<string, unknown>

  // 来源判定：缺 `source` 的是 PR1 旧游标（只可能来自留言页，kind=review 直接拒）。
  if (rawSource === undefined) {
    if (kind === 'review') return null
  } else if (rawSource === 'comment' || rawSource === 'review') {
    if (kind !== 'all' && kind !== rawSource) return null
  } else {
    return null
  }
  const source: MyCommentsCursorSource = rawSource === undefined ? 'comment' : rawSource

  if (typeof id !== 'string' || typeof createdAt !== 'string') return null
  if (!CommentCursorTimestampSchema.safeParse(createdAt).success) return null

  const idSchema = source === 'review' ? ReviewIdSchema : CommentIdSchema
  if (!idSchema.safeParse(id).success) return null
  const prefix = source === 'review' ? PUBLIC_ID_PREFIX.review : PUBLIC_ID_PREFIX.comment

  return { createdAt, id: decodePublicId(prefix, id), source }
}
