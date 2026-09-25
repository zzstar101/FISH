/**
 * Admin / 治理列表的游标编码 / 解码（设计 §4.2：`createdAt DESC, id DESC` 游标分页）。
 *
 * 契约对游标的承诺是**不透明字符串**（与 #6 feed 一致，不自造 `hasMore` / `total`）：
 * 前端只该把上一页的 `nextCursor` 原样回传。编码格式 `{createdAtIso}|{id}` + base64url，
 * 是**实现细节**，不写进契约。
 *
 * 解码失败一律返回 `null`（路由层报 422），不做"宽容解析"：一个伪造或截断的游标如果被
 * 当成合法起点，用户会看到静默错乱的列表，比直接报错难查得多（#6 契约 §2.1 同款取舍）。
 *
 * #73 治理（举报队列 / 我的举报）复用本文件：游标形状与 Admin 列表一致，只是排序列换成
 * `reports.created_at`，所以 `cursorCondition` 也放在这里，而不是各 store 各抄一份。
 */
import { ListingCursorTimestampSchema, ListingIdSchema } from '@fish/contracts/listings/schema'
import { type SQL, sql } from 'drizzle-orm'

export type AdminCursor = {
  /** 微秒精度的 UTC ISO 时间文本（`store` 层用 `to_char(..., 'US')` 取）。 */
  createdAt: string
  id: string
}

/** `created_at` 的微秒精度 UTC 文本（与 listings/store.ts 同一口径，供游标编码）。 */
export const createdAtCursorText = (col: SQL) =>
  sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

/** 游标条件：`(created_at, id) < (cursor.createdAt, cursor.id)`（各列表排序同构）。 */
export function cursorCondition(
  createdAtCol: SQL,
  idCol: SQL,
  cursor: { createdAt: string; id: string },
): SQL {
  return sql`(${createdAtCol}, ${idCol}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
}

function isCursorTimestamp(value: string): boolean {
  return ListingCursorTimestampSchema.safeParse(value).success
}

export function encodeCursor(createdAtMicro: string, id: string): string {
  // 只接受微秒精度的 UTC ISO 文本：与 listings `newest` 排序同款，**必须由 store 的
  // `to_char(..., 'US')` 给出**，不能用 `Date.toISOString()`（JS Date 只有毫秒，同毫秒行
  // 在翻页边界会重复/漏项）。
  return Buffer.from(`${createdAtMicro}|${id}`).toString('base64url')
}

export function decodeCursor(raw: string): AdminCursor | null {
  let decoded: string
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const separator = decoded.lastIndexOf('|')
  if (separator <= 0) return null
  const createdAt = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)

  // id 会被绑到 `users.id` / `listings.id`（uuid 列）：非 UUID 会变成 SQL 类型错误 → 500，
  // 而契约要求这种情况是 422（§2.1"非法 cursor → 422"）。
  if (!id || !ListingIdSchema.safeParse(id).success) return null
  // 时间戳校验交给契约包的 `ListingCursorTimestampSchema`：它查月/日/时/分/秒值域，
  // `2026-13-45T99:99Z` 之类会被 PG 的 ::timestamptz 拒绝成 500，必须在这里拦成 422。
  if (!createdAt || !isCursorTimestamp(createdAt)) return null

  return { createdAt, id }
}
