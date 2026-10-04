import { expect, mock, test } from 'bun:test'
import type { ConversationDto } from '@fish/contracts/chat/schema'
import { applyReadPoll, messageReadLabel } from '../src/pkg-social/pages/conversation/view'

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

/**
 * 读位轮询的落地判据（#359 四 审查回合）。
 *
 * 服务端读位单调只前进，但 HTTP 响应会乱序 —— 20s 间隔下两次轮询可以同时在飞，
 * 先发的后到就会把「已读」打回「未读」。这条判据是那个修复的本体，必须有用例。
 */
function conversation(readAt: string | null): ConversationDto {
  return {
    id: 'cnv_01jc000000e0080000000000c1',
    listingId: 'lst_01jc000000e00800000000000t',
    role: 'buyer',
    listing: {
      id: 'lst_01jc000000e00800000000000t',
      title: '九成新自行车',
      priceCents: 12000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    unreadCount: 0,
    counterpartLastReadAt: readAt,
    lastMessage: null,
    lastMessageAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

test('applyReadPoll：更晚的读位写回，更早的不写回（返回原对象，避免无谓重渲染）', () => {
  const EARLY = '2026-01-01T00:00:05.000Z'
  const LATE = '2026-01-01T00:00:09.000Z'

  // 乱序：先发的（较晚）已经落地，后到的旧快照不许把它打回去
  const current = conversation(LATE)
  const stale = applyReadPoll(current, conversation(EARLY))
  expect(stale).toBe(current)
  expect(stale.counterpartLastReadAt).toBe(LATE)

  // 正向：更新的读位要写进去
  const advanced = applyReadPoll(conversation(EARLY), conversation(LATE))
  expect(advanced).not.toBe(conversation(EARLY))
  expect(advanced.counterpartLastReadAt).toBe(LATE)
})

test('applyReadPoll：null 只在「从无到有」时被覆盖，反向不覆盖（读位只前进）', () => {
  expect(
    applyReadPoll(conversation(null), conversation('2026-01-01T00:00:09.000Z'))
      .counterpartLastReadAt,
  ).toBe('2026-01-01T00:00:09.000Z')
  expect(
    applyReadPoll(conversation('2026-01-01T00:00:09.000Z'), conversation(null))
      .counterpartLastReadAt,
  ).toBe('2026-01-01T00:00:09.000Z')
})

test('applyReadPoll：时间戳解析不了的一方让位，而不是把结论写坏', () => {
  expect(
    applyReadPoll(conversation('not-a-date'), conversation('2026-01-01T00:00:09.000Z'))
      .counterpartLastReadAt,
  ).toBe('2026-01-01T00:00:09.000Z')
  // 候选值坏掉时保留原值（宁可不前进，也不能写进一个解析不了的读位）
  expect(
    applyReadPoll(conversation('2026-01-01T00:00:09.000Z'), conversation('not-a-date'))
      .counterpartLastReadAt,
  ).toBe('2026-01-01T00:00:09.000Z')
})
