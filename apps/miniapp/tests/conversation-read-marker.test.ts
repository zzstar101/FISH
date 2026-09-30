import { expect, mock, test } from 'bun:test'
import { messageReadLabel } from '../src/pages/conversation/view'

/**
 * 演示回退里的「对方读位」（#359 四 审查回合）。
 *
 * 修复前 `counterpartLastReadAt` 恒为 `null` → 演示构建里每条我发的消息都只能显示红
 * 「未读」，「已读」这一档在端上根本看不到；而端上门禁要求在微信开发者工具里逐页演示
 * 这个标签。这条用例把「两种标签都能演示」钉住。
 */
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

const { loadConversation, loadMessagePage } = await import('../src/features/fetchers')
const { DEMO_USER } = await import('../src/features/auth/demo')
const { mockPublicId } = await import('../src/mock/public-id')

test('演示回退：读位非空，且「已读」与「未读」两种标签都能出现', async () => {
  const id = mockPublicId('cnv', 'c-001')
  const detail = await loadConversation(id)
  expect(detail.status).toBe('ok')
  if (detail.status !== 'ok') return

  const readAt = detail.conversation.counterpartLastReadAt
  // 修复前这里是 null
  expect(readAt).not.toBeNull()

  const history = await loadMessagePage(id)
  const labels = history.items.map((message) =>
    messageReadLabel({
      mine: message.senderId === DEMO_USER.id,
      createdAt: message.createdAt,
      counterpartLastReadAt: readAt,
    }),
  )

  // 只标我发出的：至少有一条自己的消息；两种状态都要能看到（端上演示的前提）
  expect(labels.filter((label) => label !== null).length).toBeGreaterThan(0)
  expect(labels).toContain('已读')
  expect(labels).toContain('未读')
})
