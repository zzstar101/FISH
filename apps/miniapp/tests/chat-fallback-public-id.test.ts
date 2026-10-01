import { expect, mock, test } from 'bun:test'
import { conversationDtoSchema, messageDtoSchema } from '@fish/contracts/chat/schema'

Object.assign(globalThis, { __DEMO_AUTH__: true, __ALLOW_MOCK_FALLBACK__: true })
const unavailable = () => Promise.reject(new Error('demo offline'))
mock.module('@/lib/request', () => ({
  apiRequest: unavailable,
  isApiError: () => false,
  isUnauthenticatedError: () => false,
  ApiError: Error,
}))
mock.module('@/features/chat/api', () => ({
  fetchConversationPage: unavailable,
  fetchConversation: unavailable,
  fetchMessagePage: unavailable,
  fetchNotifications: unavailable,
  markNotificationRead: unavailable,
  fetchUnreadNotificationCount: unavailable,
  fetchConversationUnreadCount: unavailable,
  createConversation: unavailable,
  sendMessage: unavailable,
  markConversationRead: unavailable,
  fetchConversations: unavailable,
}))

const {
  loadConversations,
  loadConversation,
  loadMessagePage,
  loadCounterpartListings,
  loadMyListings,
} = await import('../src/features/fetchers')
const { DEMO_USER } = await import('../src/features/auth/demo')
const { mockPublicId } = await import('../src/mock/public-id')

test('断网演示会话列表 → 详情 → 历史消息全程使用同一组规范公开 ID', async () => {
  const page = await loadConversations()
  expect(page.failed).toBe(false)
  expect(page.items.length).toBeGreaterThan(0)
  for (const row of page.items) {
    expect(conversationDtoSchema.safeParse(row).success).toBe(true)
  }

  const id = page.items[0]?.id ?? ''
  const detail = await loadConversation(id)
  expect(detail.status).toBe('ok')
  if (detail.status !== 'ok') return
  expect(detail.conversation.id).toBe(id)
  expect(conversationDtoSchema.safeParse(detail.conversation).success).toBe(true)

  const history = await loadMessagePage(id)
  expect(history.failed).toBe(false)
  expect(history.items.length).toBeGreaterThan(0)
  for (const message of history.items) {
    expect(messageDtoSchema.safeParse(message).success).toBe(true)
    expect(message.conversationId).toBe(id)
  }
})

test('演示身份的最后一条消息发送者在摘要、详情与历史中一致', async () => {
  const id = mockPublicId('cnv', 'c-002')
  const row = (await loadConversations()).items.find((item) => item.id === id)
  const detail = await loadConversation(id)
  const history = await loadMessagePage(id)

  expect(row?.lastMessage?.senderId).toBe(DEMO_USER.id)
  expect(detail.status).toBe('ok')
  if (detail.status !== 'ok') return
  expect(detail.conversation.lastMessage?.senderId).toBe(DEMO_USER.id)
  const last = history.items.find((message) => message.createdAt === row?.lastMessage?.createdAt)
  expect(last?.senderId).toBe(DEMO_USER.id)
})

test('发送商品选择页：两侧回退都按同一套公开 ID 空间查，不是假空态', async () => {
  // 会话里的 counterpart.id 是 `usr_…`（mockPublicId），fixture 的 sellerId 是原始键；
  // 回退若直接拿公开 id 去比原始键，恒为空 —— 表现就是「TA 暂无在售商品」的假空态，
  // 而买家进页面默认看的就是这一侧。
  const id = mockPublicId('cnv', 'c-001')
  const row = (await loadConversations()).items.find((item) => item.id === id)
  expect(row).toBeDefined()
  const counterpartId = row?.counterpart.id ?? ''
  expect(counterpartId.startsWith('usr_')).toBe(true)

  const theirs = await loadCounterpartListings(counterpartId)
  expect(theirs.failed).toBe(false)
  expect(theirs.items.length).toBeGreaterThan(0)
  // 与真实端点同口径：只给在售
  expect(theirs.items.every((item) => item.status === 'ACTIVE')).toBe(true)
  // 回退是整份 fixture，没有「下一页」
  expect(theirs.hasMore).toBe(false)

  const mine = await loadMyListings(DEMO_USER.id)
  expect(mine.failed).toBe(false)
  expect(mine.items.length).toBeGreaterThan(0)
})
