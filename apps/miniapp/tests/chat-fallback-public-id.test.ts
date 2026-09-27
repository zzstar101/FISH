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

const { loadConversations, loadConversation, loadMessagePage } = await import(
  '../src/features/fetchers'
)
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
