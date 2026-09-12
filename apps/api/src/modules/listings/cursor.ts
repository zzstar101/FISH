/**
 * feed 游标编解码（#6 契约 §2.1）。
 *
 * 契约规定 cursor 对前端是**不透明字符串**：前端只原样回传，不得解析或构造。
 * 这里用 base64url(JSON) 承载 `(排序键, id)`：
 *
 * - 用 cursor 而不是 offset —— 新商品会插到列表最前，offset 翻页必然重复/漏项；
 * - 排序键之外还要带 id 做 tie-break —— 同一毫秒创建或同一价格的商品必须有确定顺序，
 *   否则 `LIMIT/OFFSET` 式的比较会在边界上跳项。
 *
 * 解码失败一律返回 `null`（路由层报 422），不做"宽容解析"：一个伪造或截断的游标如果被
 * 当成合法起点，用户会看到静默错乱的列表，比直接报错难查得多。
 */
import { ListingIdSchema } from '@fish/contracts/listings/schema'

export type FeedCursor = { sortKey: string | number; id: string }

/**
 * `newest` 排序的 sortKey 形态：**带微秒**的 UTC ISO 时间。
 *
 * 不能用 `Date.toISOString()`：JS `Date` 只有毫秒，而 `created_at` 是 timestamptz（微秒）。
 * 截断后再比较会让同一毫秒内排在边界行之后的商品**两个分支都不成立**，从而在翻页里永久消失
 * （实测：`.123700` 与 `.123300` 同毫秒，第二页为空）。契约 §2.1 明确承诺"同毫秒不重不漏"。
 */
export const CURSOR_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export function encodeCursor(cursor: FeedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): FeedCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { sortKey, id } = parsed as Record<string, unknown>
  // id 会被绑到 `listings.id`（uuid 列）：非 UUID 会变成 SQL 类型错误 → 500，
  // 而契约要求这种情况是 422（§2.1"非法 cursor → 422"）。
  if (typeof id !== 'string' || !ListingIdSchema.safeParse(id).success) return null
  if (typeof sortKey !== 'string' && typeof sortKey !== 'number') return null
  // NaN / Infinity 无法与 SQL 参数比较，必须在入口挡掉
  if (typeof sortKey === 'number' && !Number.isFinite(sortKey)) return null

  return { sortKey, id }
}
