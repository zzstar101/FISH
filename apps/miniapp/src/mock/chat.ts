import { getListing, LISTINGS } from './catalog'
import type { MockConversation, MockMessage } from './types'
import { CURRENT_USER_ID } from './users'

/**
 * 会话与消息 fixture。字段对齐 `chat/schema.ts` 的 `conversationDtoSchema` /
 * `messageDtoSchema`；`role` 是**查看者视角**（同一会话对买卖双方输出不同值）。
 *
 * 交易类 SYSTEM 消息的 content 是 `transactions/schema.ts` 的 JSON 原文
 * （`tx.proposal` / `tx.accepted` / `tx.rejected`），前端按该协议解析后渲染成中文。
 */

const HOUR = 3600 * 1000
const MIN = 60 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

type ConversationSpec = {
  id: string
  listingId: string
  /** 对话另一方 */
  counterpartId: string
  unreadCount: number
  kind: MockConversation['kind']
  timeLabel: string
  tag: string
  tagDone: boolean
  online: boolean
  lastMessageAt: string
  /** 消息按时间升序；senderId 为 null 表示 SYSTEM */
  messages: { senderId: string | null; type: 'TEXT' | 'SYSTEM'; content: string; agoMs: number }[]
}

const SPECS: ConversationSpec[] = [
  {
    id: 'c-001',
    listingId: 'l-001',
    counterpartId: 'u-xiaobei',
    unreadCount: 2,
    kind: 'deal',
    timeLabel: '刚刚',
    tag: '交易',
    tagDone: false,
    online: true,
    lastMessageAt: isoAgo(2 * MIN),
    messages: [
      { senderId: 'u-xiaobei', type: 'TEXT', content: '你好，这个还在吗？', agoMs: 52 * MIN },
      { senderId: 'u-alan', type: 'TEXT', content: '在的，成色很好，白色那款', agoMs: 48 * MIN },
      { senderId: 'u-xiaobei', type: 'TEXT', content: '能便宜一点吗，150 可以吗', agoMs: 40 * MIN },
      { senderId: 'u-alan', type: 'TEXT', content: '150 有点低了，155 自提可以', agoMs: 33 * MIN },
      {
        senderId: 'u-xiaobei',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.proposal', amountCents: 15000 }),
        agoMs: 20 * MIN,
      },
      {
        senderId: 'u-xiaobei',
        type: 'TEXT',
        content: '键盘还在吗？今晚方便在图书馆面交吗',
        agoMs: 2 * MIN,
      },
    ],
  },
  {
    id: 'c-002',
    listingId: 'l-002',
    counterpartId: 'u-linyi',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '12 分钟前',
    tag: '待面交',
    tagDone: false,
    online: false,
    lastMessageAt: isoAgo(12 * MIN),
    messages: [
      {
        senderId: 'u-linyi',
        type: 'TEXT',
        content: '老师，这本 X280 电池还能用多久？',
        agoMs: 5 * HOUR,
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '打字能撑 4 小时左右，跑代码大概 2 小时',
        agoMs: 4.6 * HOUR,
      },
      {
        senderId: 'u-linyi',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.proposal', amountCents: 150000 }),
        agoMs: 2 * HOUR,
      },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({
          type: 'tx.accepted',
          transactionId: 't-001',
          amountCents: 150000,
        }),
        agoMs: 90 * MIN,
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '接受了，今晚 7 点图书馆一楼交接可以吗',
        agoMs: 12 * MIN,
      },
    ],
  },
  {
    id: 'c-003',
    listingId: 'l-004',
    counterpartId: 'u-susu',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '昨天',
    tag: '已完成',
    tagDone: true,
    online: false,
    lastMessageAt: isoAgo(26 * HOUR),
    messages: [
      { senderId: 'u-alan', type: 'TEXT', content: '你好，高数上下册还在吗', agoMs: 30 * HOUR },
      {
        senderId: 'u-susu',
        type: 'TEXT',
        content: '在的，笔记不多，可以当面试书',
        agoMs: 29 * HOUR,
      },
      { senderId: 'u-alan', type: 'TEXT', content: '太好了，我下午去拿', agoMs: 28 * HOUR },
      {
        senderId: 'u-susu',
        type: 'TEXT',
        content: '书已交付，谢谢，有需要再找我～',
        agoMs: 26 * HOUR,
      },
    ],
  },
  {
    id: 'c-004',
    listingId: 'l-003',
    counterpartId: 'u-qiqi',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '周三',
    tag: '交易',
    tagDone: false,
    online: false,
    lastMessageAt: isoAgo(3 * 24 * HOUR),
    messages: [
      {
        senderId: 'u-qiqi',
        type: 'TEXT',
        content: '小米 12 能再便宜 20 吗？我马上下单',
        agoMs: 3 * 24 * HOUR + 8 * MIN,
      },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.rejected' }),
        agoMs: 3 * 24 * HOUR + 4 * MIN,
      },
    ],
  },
  {
    id: 'c-005',
    listingId: 'l-004',
    counterpartId: 'u-soda',
    unreadCount: 0,
    kind: 'wish',
    timeLabel: '周一',
    tag: '许愿',
    tagDone: false,
    online: true,
    lastMessageAt: isoAgo(4 * 24 * HOUR),
    messages: [
      {
        senderId: 'u-soda',
        type: 'TEXT',
        content: '我正好有一本你要的结构化笔记，可以出给你～',
        agoMs: 4 * 24 * HOUR,
      },
    ],
  },
  {
    id: 'c-006',
    listingId: 'l-001',
    counterpartId: 'u-alan',
    unreadCount: 0,
    kind: 'system',
    timeLabel: '周一',
    tag: '系统',
    tagDone: true,
    online: false,
    lastMessageAt: isoAgo(5 * 24 * HOUR),
    messages: [
      {
        senderId: null,
        type: 'SYSTEM',
        content: '你的学号认证已通过，信用分提升至 96',
        agoMs: 5 * 24 * HOUR,
      },
    ],
  },
]

export const CONVERSATIONS: MockConversation[] = SPECS.map((spec) => {
  const listing = getListing(spec.listingId) ?? LISTINGS[0]
  const isSeller = listing ? listing.sellerId === CURRENT_USER_ID : false
  const last = spec.messages[spec.messages.length - 1]
  return {
    id: spec.id,
    listingId: spec.listingId,
    role: isSeller ? 'seller' : 'buyer',
    counterpartId: spec.counterpartId,
    unreadCount: spec.unreadCount,
    lastMessage: last
      ? {
          type: last.type,
          content: last.content,
          senderId: last.senderId,
          createdAt: isoAgo(last.agoMs),
        }
      : null,
    lastMessageAt: spec.lastMessageAt,
    kind: spec.kind,
    timeLabel: spec.timeLabel,
    tag: spec.tag,
    tagDone: spec.tagDone,
    online: spec.online,
  }
})

export const MESSAGES: MockMessage[] = SPECS.flatMap((spec) =>
  spec.messages.map((message, index) => ({
    id: `${spec.id}-m${String(index + 1).padStart(2, '0')}`,
    conversationId: spec.id,
    senderId: message.senderId,
    type: message.type,
    content: message.content,
    createdAt: isoAgo(message.agoMs),
  })),
)

export function messagesOf(conversationId: string): MockMessage[] {
  return MESSAGES.filter((message) => message.conversationId === conversationId).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )
}

export function conversationsOf(): MockConversation[] {
  return [...CONVERSATIONS].sort(
    (a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt),
  )
}

/** 消息页头部的「2 条待回复 · 1 笔待确认面交」 */
export const CHAT_SUMMARY = {
  pendingReply: 2,
  pendingMeetup: 1,
  wishHit: 3,
}
