import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb } from './client'
import { migrateWithBackfill } from './migrate'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('迁移集成测试需要 DATABASE_URL')
const folder = join(import.meta.dir, 'migrations')

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

test('#217 旧数据无损补号、v4 愿望及引用迁到 v7，空档中断重跑安全', async () => {
  const admin = createDb(databaseUrl)
  const databaseName = `fish_217_migration_${process.pid}`
  const url = new URL(databaseUrl)
  url.pathname = `/${databaseName}`
  const scratchUrl = url.toString()
  const staging = await mkdtemp(join(tmpdir(), 'fish-217-old-schema-'))
  let scratch: ReturnType<typeof createDb> | undefined
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${databaseName}"`)
    scratch = createDb(scratchUrl)
    await mkdir(join(staging, 'meta'))
    const journal = (await Bun.file(join(folder, 'meta/_journal.json')).json()) as {
      entries: { idx: number; tag: string }[]
    }
    const entries = journal.entries.filter((entry) => entry.idx <= 19)
    await Bun.write(join(staging, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }))
    for (const entry of entries) {
      await symlink(join(folder, `${entry.tag}.sql`), join(staging, `${entry.tag}.sql`))
    }
    await migrate(scratch, { migrationsFolder: staging })

    const userId = crypto.randomUUID()
    const listingId = crypto.randomUUID()
    const oldWishId = crypto.randomUUID()
    const oldConversationId = crypto.randomUUID()
    const oldMessageId = crypto.randomUUID()
    const oldTransactionId = crypto.randomUUID()
    const buyerId = '01930000-0000-7000-8000-0000000000b1'
    await scratch.execute(sql`INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${userId}, '217-migration', 'test-hash', '迁移用户')`)
    await scratch.execute(sql`INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${buyerId}, '217-migration-buyer', 'test-hash', '迁移买家')`)
    await scratch.execute(sql`INSERT INTO listings
      (id, seller_id, title, description, price_cents, category, condition)
      VALUES (${listingId}, ${userId}, '旧商品', '需要补号', 100, 'OTHER', 'GOOD')`)
    await scratch.execute(sql`INSERT INTO listing_images (id, listing_id, object_key, sort_order)
      VALUES ('01930000-0000-7000-8000-0000000000a1', ${listingId},
        ${`listings/${userId}/old.webp`}, 0)`)
    await scratch.execute(sql`INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
      VALUES (${oldConversationId}, ${listingId}, ${buyerId}, ${userId})`)
    await scratch.execute(sql`INSERT INTO messages (id, conversation_id, sender_id, type, content)
      VALUES (${oldMessageId}, ${oldConversationId}, ${buyerId}, 'TEXT', '保留的旧消息')`)
    await scratch.execute(sql`INSERT INTO transactions
      (id, listing_id, buyer_id, seller_id, amount_cents)
      VALUES (${oldTransactionId}, ${listingId}, ${buyerId}, ${userId}, 100)`)
    await scratch.execute(sql`INSERT INTO messages (id, conversation_id, type, content)
      VALUES ('01930000-0000-7000-8000-0000000000b2', ${oldConversationId}, 'SYSTEM',
        ${JSON.stringify({ type: 'tx.accepted', transactionId: oldTransactionId, amountCents: 100 })})`)
    await scratch.execute(sql`INSERT INTO wishes (id, user_id, keyword, category)
      VALUES (${oldWishId}, ${userId}, '旧愿望', 'OTHER')`)
    await scratch.execute(sql`INSERT INTO matches
      (id, listing_id, wish_id, score, category_score, keyword_score, price_score)
      VALUES ('01930000-0000-7000-8000-0000000000a3', ${listingId}, ${oldWishId}, 80, 20, 20, 20)`)
    await scratch.execute(sql`INSERT INTO jobs (id, type, payload)
      VALUES ('01930000-0000-7000-8000-0000000000a4', 'MATCH_WISH',
        jsonb_build_object('wishId', ${oldWishId}::text))`)
    await scratch.execute(sql`INSERT INTO notifications (id, user_id, type, payload)
      VALUES ('01930000-0000-7000-8000-0000000000a5', ${userId}, 'MATCH',
        jsonb_build_object('wishId', ${oldWishId}::text))`)

    await migrateWithBackfill(scratchUrl)
    await migrateWithBackfill(scratchUrl)
    const mappings = rowsOf(
      await scratch.execute(sql`
      SELECT resource_table, old_id, new_id FROM id_rekeys
      WHERE old_id IN (${listingId}::uuid, ${userId}::uuid, ${oldWishId}::uuid,
        ${oldConversationId}::uuid, ${oldMessageId}::uuid, ${oldTransactionId}::uuid)
    `),
    )
    expect(mappings).toHaveLength(6)
    const mapped = (table: string) =>
      String(mappings.find((row) => row.resource_table === table)?.new_id)
    for (const table of [
      'users',
      'listings',
      'wishes',
      'conversations',
      'messages',
      'transactions',
    ]) {
      expect(mapped(table)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    }
    const [listing] = rowsOf(
      await scratch.execute(sql`
      SELECT l.listing_no::text AS number, n.listing_id AS owner
      FROM listings l JOIN listing_numbers n ON n.listing_no = l.listing_no
      WHERE l.id = ${mapped('listings')}::uuid
    `),
    )
    expect(listing?.number).toMatch(/^[1-9][0-9]{11}$/)
    expect(listing?.owner).toBe(mapped('listings'))
    const [image] = rowsOf(
      await scratch.execute(sql`
      SELECT li.object_key, l.seller_id FROM listing_images li
      JOIN listings l ON l.id = li.listing_id WHERE li.listing_id = ${mapped('listings')}::uuid
    `),
    )
    expect(image).toMatchObject({
      object_key: `listings/${userId}/old.webp`,
      seller_id: mapped('users'),
    })
    const [message] = rowsOf(
      await scratch.execute(sql`
      SELECT m.id, m.content, m.conversation_id, c.listing_id
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = ${mapped('messages')}::uuid
    `),
    )
    expect(message).toMatchObject({
      content: '保留的旧消息',
      conversation_id: mapped('conversations'),
      listing_id: mapped('listings'),
    })
    const [systemMessage] = rowsOf(
      await scratch.execute(sql`
      SELECT content FROM messages WHERE id = '01930000-0000-7000-8000-0000000000b2'::uuid
    `),
    )
    expect(JSON.parse(String(systemMessage?.content))).toMatchObject({
      transactionId: oldTransactionId,
    })
    const [transaction] = rowsOf(
      await scratch.execute(sql`
      SELECT id, listing_id FROM transactions WHERE id = ${mapped('transactions')}::uuid
    `),
    )
    expect(transaction).toMatchObject({
      id: mapped('transactions'),
      listing_id: mapped('listings'),
    })
    const [wish] = rowsOf(
      await scratch.execute(sql`SELECT id FROM wishes WHERE user_id = ${mapped('users')}::uuid`),
    )
    const replacement = String(wish?.id)
    expect(replacement).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
    expect(replacement).not.toBe(oldWishId)
    expect(mapped('wishes')).toBe(replacement)
    for (const query of [
      sql`SELECT wish_id AS id FROM matches WHERE listing_id = ${mapped('listings')}::uuid`,
      sql`SELECT payload->>'wishId' AS id FROM jobs WHERE type = 'MATCH_WISH'`,
      sql`SELECT payload->>'wishId' AS id FROM notifications WHERE type = 'MATCH'`,
    ]) {
      expect(rowsOf(await scratch.execute(query))[0]?.id).toBe(replacement)
    }
    const [databaseDefault] = rowsOf(
      await scratch.execute(sql`
      SELECT column_default AS value FROM information_schema.columns
      WHERE table_name = 'listings' AND column_name = 'id'
    `),
    )
    expect(databaseDefault?.value).toBe('uuidv7()')
  } finally {
    if (scratch) await scratch.$client.close()
    await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
    await admin.$client.close()
    await rm(staging, { recursive: true, force: true })
  }
})
