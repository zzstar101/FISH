import { sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './ids'

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

type ForeignKey = { child_table: string; name: string; originally_deferrable: boolean }
type Reference = { child_table: string; parent_table: string; child_column: string }

const payloadFields: Record<string, string[]> = {
  users: ['userId'],
  listings: ['listingId'],
  wishes: ['wishId'],
  matches: ['matchId'],
  conversations: ['conversationId'],
  messages: ['messageId'],
  transactions: ['transactionId'],
}

const auditTargets: Record<string, string> = {
  users: 'USER',
  listings: 'LISTING',
  reports: 'REPORT',
  listing_moderation_records: 'MODERATION_RECORD',
  user_restrictions: 'USER_RESTRICTION',
}

/**
 * Stop API/worker writes before calling. Rekey all non-v7 UUID primary keys in one transaction;
 * the mapping remains available for immutable audit and system-message payload projections.
 * Foreign keys are made temporarily deferrable and restored before commit. No rows are deleted.
 */
export async function rekeyLegacyIds(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const tables = rowsOf(
      await tx.execute(sql`
      SELECT c.relname AS table_name
      FROM pg_constraint pk
      JOIN pg_class c ON c.oid = pk.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = pk.conkey[1]
      WHERE n.nspname = 'public' AND pk.contype = 'p'
        AND cardinality(pk.conkey) = 1 AND a.attname = 'id' AND a.atttypid = 'uuid'::regtype
      ORDER BY c.relname
    `),
    ).map((row) => String(row.table_name))
    const pending: { table: string; oldId: string; newId: string }[] = []
    for (const table of tables) {
      const oldRows = rowsOf(
        await tx.execute(sql`
        SELECT id FROM ${sql.identifier(table)} WHERE substring(id::text, 15, 1) <> '7'
      `),
      )
      for (const row of oldRows) pending.push({ table, oldId: String(row.id), newId: newId() })
    }
    if (pending.length === 0) return

    const constraints = rowsOf(
      await tx.execute(sql`
      SELECT child.relname AS child_table, fk.conname AS name,
             fk.condeferrable AS originally_deferrable
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      WHERE fk.contype = 'f' AND n.nspname = 'public'
    `),
    ) as ForeignKey[]
    const references = rowsOf(
      await tx.execute(sql`
      SELECT child.relname AS child_table, parent.relname AS parent_table,
             child_column.attname AS child_column
      FROM pg_constraint fk
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace n ON n.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = fk.confrelid
      JOIN LATERAL unnest(fk.conkey, fk.confkey) AS keys(child_num, parent_num) ON true
      JOIN pg_attribute child_column ON child_column.attrelid = child.oid
        AND child_column.attnum = keys.child_num
      JOIN pg_attribute parent_column ON parent_column.attrelid = parent.oid
        AND parent_column.attnum = keys.parent_num
      WHERE fk.contype = 'f' AND n.nspname = 'public' AND parent_column.attname = 'id'
    `),
    ) as Reference[]

    for (const fk of constraints.filter((row) => !row.originally_deferrable)) {
      await tx.execute(sql`ALTER TABLE ${sql.identifier(fk.child_table)}
        ALTER CONSTRAINT ${sql.identifier(fk.name)} DEFERRABLE INITIALLY DEFERRED`)
    }
    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`)
    for (const { table, oldId, newId: replacement } of pending) {
      await tx.execute(sql`INSERT INTO id_rekeys (resource_table, old_id, new_id)
        VALUES (${table}, ${oldId}::uuid, ${replacement}::uuid)`)
      await tx.execute(sql`UPDATE ${sql.identifier(table)} SET id = ${replacement}::uuid
        WHERE id = ${oldId}::uuid`)
      for (const ref of references.filter((item) => item.parent_table === table)) {
        await tx.execute(sql`UPDATE ${sql.identifier(ref.child_table)}
          SET ${sql.identifier(ref.child_column)} = ${replacement}::uuid
          WHERE ${sql.identifier(ref.child_column)} = ${oldId}::uuid`)
      }
      if (table === 'listings') {
        await tx.execute(sql`UPDATE listing_numbers SET listing_id = ${replacement}::uuid
          WHERE listing_id = ${oldId}::uuid`)
      }
      if (table === 'users') {
        // These seller IDs are covered by composite FKs to (listings.id, listings.seller_id),
        // not direct FKs to users.id. The catalog scan above cannot discover them.
        for (const child of ['conversations', 'transactions']) {
          await tx.execute(sql`UPDATE ${sql.identifier(child)} SET seller_id = ${replacement}::uuid
            WHERE seller_id = ${oldId}::uuid`)
        }
      }
      if (table === 'listings' || table === 'users') {
        const targetType = auditTargets[table]
        await tx.execute(sql`UPDATE reports SET target_id = ${replacement}::uuid
          WHERE target_type::text = ${targetType} AND target_id = ${oldId}::uuid`)
      }
      const auditType = auditTargets[table]
      if (auditType) {
        await tx.execute(sql`UPDATE admin_audit_logs SET target_id = ${replacement}::uuid
          WHERE target_type::text = ${auditType} AND target_id = ${oldId}::uuid`)
      }
      for (const field of payloadFields[table] ?? []) {
        for (const payloadTable of ['jobs', 'notifications']) {
          await tx.execute(sql`UPDATE ${sql.identifier(payloadTable)}
            SET payload = jsonb_set(payload, ARRAY[${field}], to_jsonb(${replacement}::text))
            WHERE jsonb_typeof(payload) = 'object' AND payload->>${field} = ${oldId}`)
        }
      }
    }
    // Force immediate validation while still inside the transaction, then restore all FK modes.
    await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`)
    for (const fk of constraints.filter((row) => !row.originally_deferrable)) {
      await tx.execute(sql`ALTER TABLE ${sql.identifier(fk.child_table)}
        ALTER CONSTRAINT ${sql.identifier(fk.name)} NOT DEFERRABLE`)
    }
  })
}
