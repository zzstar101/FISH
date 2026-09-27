/**
 * 会话列表游标编解码（#9 契约：cursor 对前端不透明，只原样回传）。
 *
 * 语义与 listings/cursor.ts 相同（base64url(JSON) 承载 `(排序键, id)`，解码失败一律
 * null → 路由层 422），刻意不 import 那边的实现：那是 #6 的模块内部，契约未承诺稳定。
 * 会话列表的排序键是 `last_message_at`（每条新消息都会 bump），这是它必须用 cursor
 * 而不是 offset 的原因（契约注释已冻结）。
 */
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
} from '@fish/shared/public-id'

export type ConversationCursor = { sortKey: string; id: string }
type CursorPrefix = typeof PUBLIC_ID_PREFIX.conversation | typeof PUBLIC_ID_PREFIX.transaction

/** 微秒精度的 UTC ISO 时间戳形状（DB 是 timestamptz 微秒精度，毫秒截断会让边界行消失）。 */
const CURSOR_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

/**
 * 不能只查形状：手写正则放得过 `2026-13-45T99:99:99.999999Z`，随后被 PG 的
 * `::timestamptz` 拒绝 → 500（listings/cursor.ts 实测），而契约要求 422。
 * Date 会把越界日历值静默滚动（02-31 → 03-03），所以再做一次 round-trip 比对；
 * Date 只有毫秒，因此只比对秒级前的字段，微秒段交给 PG。
 */
export function isCursorTimestamp(value: string): boolean {
  if (!CURSOR_TIMESTAMP_RE.test(value)) return false
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return false
  return date.toISOString().slice(0, 19) === value.slice(0, 19)
}

export function encodeCursor(
  cursor: ConversationCursor,
  prefix: CursorPrefix = PUBLIC_ID_PREFIX.conversation,
): string {
  return Buffer.from(
    JSON.stringify({ ...cursor, id: encodePublicId(prefix, cursor.id) }),
    'utf8',
  ).toString('base64url')
}

export function decodeCursor(
  raw: string,
  prefix: CursorPrefix = PUBLIC_ID_PREFIX.conversation,
): ConversationCursor | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const { sortKey, id } = parsed as Record<string, unknown>
  // Transaction lists share this cursor shape but must not accept cnv_ IDs (or bare UUIDs).
  if (!isPublicId(prefix, id)) return null
  if (typeof sortKey !== 'string' || !isCursorTimestamp(sortKey)) return null

  return { sortKey, id: decodePublicId(prefix, id) }
}
