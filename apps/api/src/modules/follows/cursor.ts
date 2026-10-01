/**
 * 关注列表的游标编解码（#188）。
 *
 * 与 `listings/cursor.ts` 同一形状（base64url(JSON) 承载 `(排序键, id)`），差别只有一个：
 * 这里的 tie-break id 是**用户**的 Public ID（`usr_…`），不是商品 id。因此不复用那边
 * 硬编码 `PUBLIC_ID_PREFIX.listing` 的实现，另写一份同构的。
 *
 * 排序键是 `follows.created_at`（微秒级 timestamptz，`to_char` 出来的 UTC ISO 文本）：
 * JS `Date` 只有毫秒，截断会让同一毫秒内排在边界行之后的人**两个分支都不成立**、翻页时
 * 永久消失（listings 的实测结论，见 `listings/cursor.ts`）。
 *
 * 解码失败一律返回 `null`（路由层报 422），不做宽容解析：伪造/截断的游标被当成合法起点
 * 会静默错乱列表，比直接报错难查得多。
 */
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
} from '@fish/shared/public-id'
import { isCursorTimestamp } from '../listings/cursor'

export type FollowingCursor = { createdAt: string; id: string }

export function encodeFollowingCursor(cursor: FollowingCursor): string {
  return Buffer.from(
    JSON.stringify({ ...cursor, id: encodePublicId(PUBLIC_ID_PREFIX.user, cursor.id) }),
    'utf8',
  ).toString('base64url')
}

export function decodeFollowingCursor(raw: string): FollowingCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { createdAt, id } = parsed as Record<string, unknown>
  // 游标只承载 usr_ Public ID：裸 UUID 与错误前缀都必须在进 uuid 列之前挡住（否则 SQL 500）。
  if (!isPublicId(PUBLIC_ID_PREFIX.user, id)) return null
  // 值域校验（zod 查月/日/时/分/秒）：形状合法但日期非法的时间戳会被 `::timestamptz` 拒绝 → 500。
  if (typeof createdAt !== 'string' || !isCursorTimestamp(createdAt)) return null

  return { createdAt, id: decodePublicId(PUBLIC_ID_PREFIX.user, id) }
}
