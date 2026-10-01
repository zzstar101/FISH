/**
 * 收藏列表的游标编解码（#190）。
 *
 * 与 `listings/cursor.ts` 同一形状（base64url(JSON) 承载 `(排序键, id)`），
 * 差别在**排序键来自收藏行、tie-break id 来自商品**：
 *
 * - 排序键是 `favorites.created_at`（微秒级 timestamptz，`to_char` 出来的 UTC ISO 文本）。
 *   JS `Date` 只有毫秒，截断会让同一毫秒内的边界行**两个分支都不成立**、翻页时永久消失。
 * - tie-break 用**商品 Public ID**（`lst_…`）而不是 `favorites.id`（内部行 uuid）：
 *   游标虽然是给端上的不透明串，但 base64url 是可解的，里面不该出现内部行 id
 *   （与 `listings/cursor.ts` 用 `lst_` 同一取向）。`(user_id, listing_id)` 唯一，
 *   所以 `(created_at, listing_id)` 是全序，翻页不重不漏。
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

export type FavoritesCursor = { createdAt: string; listingId: string }

export function encodeFavoritesCursor(cursor: FavoritesCursor): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, cursor.listingId),
    }),
    'utf8',
  ).toString('base64url')
}

export function decodeFavoritesCursor(raw: string): FavoritesCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { createdAt, listingId } = parsed as Record<string, unknown>
  // 游标只承载 lst_ Public ID：裸 UUID 与错误前缀都必须在进 uuid 列之前挡住（否则 SQL 500）。
  if (!isPublicId(PUBLIC_ID_PREFIX.listing, listingId)) return null
  // 值域校验（zod 查月/日/时/分/秒）：形状合法但日期非法的时间戳会被 `::timestamptz` 拒绝 → 500。
  if (typeof createdAt !== 'string' || !isCursorTimestamp(createdAt)) return null

  return { createdAt, listingId: decodePublicId(PUBLIC_ID_PREFIX.listing, listingId) }
}
