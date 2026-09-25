import { transactionSystemEventSchema } from '@fish/contracts/transactions/schema'
import type { Db } from '@fish/db/client'
import { sql } from 'drizzle-orm'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Project only the known tx.accepted reference; the historical message body stays unchanged in DB. */
export async function projectSystemContent(
  type: string,
  content: string,
  resolveOldTransaction: (oldId: string) => Promise<string | null>,
): Promise<string> {
  if (type !== 'SYSTEM') return content
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    return content
  }
  if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'tx.accepted') {
    return content
  }
  const parsed = transactionSystemEventSchema.safeParse(raw)
  if (!parsed.success || parsed.data.type !== 'tx.accepted') {
    return '历史交易消息无法定位订单'
  }
  const { transactionId, amountCents } = parsed.data
  const resolved = UUID_V7.test(transactionId)
    ? transactionId
    : UUID.test(transactionId)
      ? await resolveOldTransaction(transactionId)
      : null
  if (!resolved || !UUID_V7.test(resolved)) return '历史交易消息无法定位订单'
  return JSON.stringify({ type: 'tx.accepted', transactionId: resolved, amountCents })
}

export function createSystemContentProjector(db: Db) {
  return (type: string, content: string) =>
    projectSystemContent(type, content, async (oldId) => {
      const result = await db.execute(sql`
        SELECT new_id FROM id_rekeys
        WHERE resource_table = 'transactions' AND old_id = ${oldId}::uuid
        LIMIT 1
      `)
      const row = result[0]
      return row?.new_id ? String(row.new_id) : null
    })
}
