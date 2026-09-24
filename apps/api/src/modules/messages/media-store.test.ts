import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { MediaMessageInput } from '@fish/contracts/chat/schema'
import { createDb } from '@fish/db/client'
import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import {
  MessageIdempotencyConflictError,
  mediaRequestHash,
  messageSendKey,
  textRequestHash,
} from './idempotency'
import { createSqlMediaMessageStore } from './media-store'
import { createSqlMessageStore } from './store'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)

/**
 * 与 store.test.ts 同一 scratch 库模式，但库名必须不同：`bun test`（非 isolate）下
 * 两个文件共用同一进程，同名库的 `create database` 会撞车。
 */
const scratchDatabase = `fish_media_store_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const messageStore = createSqlMessageStore(db)
const mediaStore = createSqlMediaMessageStore(db)

const buyer = '01991000-0000-7000-8000-0000000000a1'
const seller = '01991000-0000-7000-8000-0000000000a2'
const listingA = '01991000-0000-7000-8000-0000000000b1'
const conversationA = '01991000-0000-7000-8000-0000000000c1'

/** `message_media.object_key` 有唯一约束，所以每个用例各用自己的预签名 key。 */
const imageFor = (suffix: string): MediaMessageInput => ({
  kind: 'IMAGE',
  objectKey: `chat-media/${conversationA}/${buyer}/photo-${suffix}.webp`,
  contentType: 'image/webp',
  sizeBytes: 1024,
  width: 800,
  height: 600,
})

/**
 * 这里覆盖的是**真实 SQL**（`mediaByRequestQuery` / 媒体侧 advisory lock / 部分唯一索引）：
 * media-service.test.ts 全程用假 store，够不到这一层。
 */
async function countByRequestId(clientRequestId: string, table: 'messages' | 'message_media') {
  const result = await db.execute(
    table === 'messages'
      ? sql`SELECT count(*)::int AS count FROM messages WHERE client_request_id = ${clientRequestId}`
      : sql`SELECT count(*)::int AS count FROM message_media mm
            JOIN messages m ON m.id = mm.message_id
            WHERE m.client_request_id = ${clientRequestId}`,
  )
  const row = (Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]) as {
    count: number
  }
  return row.count
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  for (const [i, uid] of [buyer, seller].entries()) {
    await db.execute(sql`
      INSERT INTO users (id, student_no, password_hash, nickname)
      VALUES (${uid}, ${`media${process.pid}_${i}`}, 'test-hash', '媒体测试')
    `)
  }
  await db.execute(sql`
    INSERT INTO listings (id, seller_id, title, description, price_cents, category, condition, status)
    VALUES (${listingA}, ${seller}, 'K380', '测试商品', 16000, 'DIGITAL', 'GOOD', 'ACTIVE')
  `)
  await db.execute(sql`
    INSERT INTO conversations (id, listing_id, buyer_id, seller_id)
    VALUES (${conversationA}, ${listingA}, ${buyer}, ${seller})
  `)
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

describe('media message store (integration)', () => {
  test('create 落一条 MEDIA 消息 + message_media 行并 bump last_message_at', async () => {
    const image = imageFor('base')
    const created = await mediaStore.create(conversationA, buyer, image)
    expect(created.kind).toBe('IMAGE')
    expect(created.object_key).toBe(image.objectKey)
    expect(created.media_id).toBeTruthy()

    const result = await db.execute(
      sql`SELECT last_message_at FROM conversations WHERE id = ${conversationA}`,
    )
    const conversation = (
      Array.isArray(result) ? result[0] : (result as { rows: unknown[] }).rows[0]
    ) as { last_message_at: Date | string }
    expect(new Date(conversation.last_message_at).getTime()).toBe(
      new Date(created.created_at).getTime(),
    )
  })

  test('findByRequestKey 对没发过的键返回 null', async () => {
    const image = imageFor('miss')
    const key = messageSendKey('01991000-0000-7000-8000-0000000000e9', mediaRequestHash(image))
    if (!key) throw new Error('unreachable')
    expect(await mediaStore.findByRequestKey(conversationA, buyer, key)).toBeNull()
  })

  test('同键同指纹重放：返回既有媒体，messages/message_media 各只落一行（#67 验收①）', async () => {
    const clientRequestId = '01991000-0000-7000-8000-0000000000e1'
    const image = imageFor('e1')
    const key = messageSendKey(clientRequestId, mediaRequestHash(image))
    if (!key) throw new Error('unreachable')

    const first = await mediaStore.create(conversationA, buyer, image, key)
    const retry = await mediaStore.create(conversationA, buyer, image, key)

    expect(retry.message_id).toBe(first.message_id)
    expect(retry.media_id).toBe(first.media_id)
    expect(await countByRequestId(clientRequestId, 'messages')).toBe(1)
    expect(await countByRequestId(clientRequestId, 'message_media')).toBe(1)
  })

  test('同键不同指纹 → MessageIdempotencyConflictError，且不落新行', async () => {
    const clientRequestId = '01991000-0000-7000-8000-0000000000e2'
    const image = imageFor('e2')
    const other = imageFor('e2-other')
    const firstKey = messageSendKey(clientRequestId, mediaRequestHash(image))
    const secondKey = messageSendKey(clientRequestId, mediaRequestHash(other))
    if (!firstKey || !secondKey) throw new Error('unreachable')

    await mediaStore.create(conversationA, buyer, image, firstKey)
    expect(mediaStore.create(conversationA, buyer, other, secondKey)).rejects.toBeInstanceOf(
      MessageIdempotencyConflictError,
    )
    expect(await countByRequestId(clientRequestId, 'messages')).toBe(1)
  })

  test('同一 clientRequestId 先 TEXT 后 MEDIA → 冲突而非撞唯一索引（500 回归）', async () => {
    // 唯一的 (sender_id, conversation_id, client_request_id) 索引不区分消息类型：
    // 媒体侧判重若 JOIN 掉 TEXT 行就会 miss，INSERT 撞 23505 → 500。
    const clientRequestId = '01991000-0000-7000-8000-0000000000e3'
    const image = imageFor('e3')
    const textKey = messageSendKey(clientRequestId, textRequestHash('先发的文字'))
    if (!textKey) throw new Error('unreachable')
    await messageStore.insertText(conversationA, buyer, '先发的文字', textKey)

    const mediaKey = messageSendKey(clientRequestId, mediaRequestHash(image))
    if (!mediaKey) throw new Error('unreachable')

    const lookup = await mediaStore.findByRequestKey(conversationA, buyer, mediaKey)
    expect(lookup).not.toBeNull()
    expect(lookup?.matchedHash).toBe(false)

    expect(mediaStore.create(conversationA, buyer, image, mediaKey)).rejects.toBeInstanceOf(
      MessageIdempotencyConflictError,
    )
    expect(await countByRequestId(clientRequestId, 'messages')).toBe(1)
  })

  test('反序：先 MEDIA 后 TEXT 的同一 clientRequestId 同样冲突', async () => {
    const clientRequestId = '01991000-0000-7000-8000-0000000000e4'
    const image = imageFor('e4')
    const mediaKey = messageSendKey(clientRequestId, mediaRequestHash(image))
    const textKey = messageSendKey(clientRequestId, textRequestHash('后来的文字'))
    if (!mediaKey || !textKey) throw new Error('unreachable')

    await mediaStore.create(conversationA, buyer, image, mediaKey)
    expect(
      messageStore.insertText(conversationA, buyer, '后来的文字', textKey),
    ).rejects.toBeInstanceOf(MessageIdempotencyConflictError)
    expect(await countByRequestId(clientRequestId, 'messages')).toBe(1)
  })
})
