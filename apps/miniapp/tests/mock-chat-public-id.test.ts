import { expect, test } from 'bun:test'
import { transactionSystemEventSchema } from '@fish/contracts/transactions/schema'
import { isPublicId } from '@fish/shared/public-id'
import { getListing, LISTINGS, similarListings } from '../src/mock/catalog'
import {
  CONVERSATIONS,
  conversationsOf,
  FAILED_TEXT_IDS,
  MESSAGES,
  messagesOf,
} from '../src/mock/chat'
import { mockPublicId } from '../src/mock/public-id'
import { getUser, USERS } from '../src/mock/users'

test('演示会话与消息的公开 ID 可用于聊天页跳转和历史查找', () => {
  const rows = conversationsOf().filter((row) => row.kind !== 'system')
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    expect(isPublicId('cnv', row.id)).toBe(true)
    expect(isPublicId('lst', row.listing.id)).toBe(true)
    expect(isPublicId('usr', row.counterpart.id)).toBe(true)
    expect(getUser(row.counterpart.id).nickname).toBe(row.counterpart.nickname)
    expect(getListing(row.listing.id)?.title).toBe(row.listing.title)
    expect(
      similarListings(row.listing.id).some((item) => item.id === getListing(row.listing.id)?.id),
    ).toBe(false)
    if (row.lastMessage?.senderId) expect(isPublicId('usr', row.lastMessage.senderId)).toBe(true)
    const history = messagesOf(row.id)
    expect(history.length).toBeGreaterThan(0)
    for (const message of history) {
      expect(isPublicId('msg', message.id)).toBe(true)
      expect(message.conversationId).toBe(row.id)
      if (message.senderId) expect(isPublicId('usr', message.senderId)).toBe(true)
    }
  }
  expect(MESSAGES.every((item) => isPublicId('msg', item.id))).toBe(true)
  expect(FAILED_TEXT_IDS.every((id) => MESSAGES.some((item) => item.id === id))).toBe(true)
  expect(new Set(MESSAGES.map((item) => item.id)).size).toBe(MESSAGES.length)
  expect(new Set(CONVERSATIONS.map((item) => item.id)).size).toBe(CONVERSATIONS.length)
  expect(new Set(LISTINGS.map((item) => mockPublicId('lst', item.id))).size).toBe(LISTINGS.length)
  expect(new Set(USERS.map((item) => mockPublicId('usr', item.id))).size).toBe(USERS.length)
})

test('演示 tx.accepted 消息正文使用规范 txn_ ID', () => {
  const accepted = MESSAGES.filter(
    (item) => item.type === 'SYSTEM' && item.content.includes('"tx.accepted"'),
  )
  expect(accepted.length).toBeGreaterThan(0)
  for (const message of accepted) {
    expect(transactionSystemEventSchema.safeParse(JSON.parse(message.content)).success).toBe(true)
  }
})
