import { getListing, LISTINGS } from './catalog'
import { productImage } from './images'
import type { MediaKind, MockConversation, MockMediaMessage, MockMessage } from './types'
import { CURRENT_USER_ID, getUser } from './users'

/**
 * 会话与消息 fixture。字段对齐 `chat/schema.ts` 的 `conversationDtoSchema` /
 * `messageDtoSchema`；`role` 是**查看者视角**（同一会话对买卖双方输出不同值）。
 *
 * 交易类 SYSTEM 消息的 content 是 `transactions/schema.ts` 的 JSON 原文
 * （`tx.proposal` / `tx.accepted` / `tx.rejected`），前端按该协议解析后渲染成中文。
 *
 * **媒体消息（D2）**：契约的 `MessageType` 只有 `TEXT | SYSTEM`，媒体是本地展示扩展
 * （见 `types.ts` 的 `MockMediaMessage`）：spec 里带 `media` 的那几条会进 `MEDIA`，
 * 不混进 `MESSAGES`。这样 `messagesOf()` 仍然只返回契约内的两种类型。
 */

const HOUR = 3600 * 1000
const MIN = 60 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

type MessageSpec = {
  senderId: string | null
  type: 'TEXT' | 'SYSTEM'
  content: string
  agoMs: number
  /** D2：媒体消息（契约外的展示扩展），带这个字段的消息不会进 MESSAGES */
  media?: {
    kind: MediaKind
    /** 图片用 catalog 的 slug 取本地资源 */
    imageSlug?: string
    durationSec?: number
    state?: MockMediaMessage['state']
    progress?: number
  }
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
  messages: MessageSpec[]
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
  /* ---- A1 订单页每笔交易各自的会话（c-007 ~ c-012）----
     为什么单独建：订单卡「查看会话」必须进**这一笔**的会话，
     不能落到同商品其他买家的会话里。原 fixture 的 c-001/c-002 是
     当前在聊的热会话，与历史订单不是同一笔，所以这里按交易逐条补齐。 */
  {
    id: 'c-007',
    listingId: 'l-047',
    counterpartId: 'u-zhangyu',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '今天',
    tag: '待面交',
    tagDone: false,
    online: false,
    lastMessageAt: isoAgo(5 * HOUR),
    messages: [
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '你好，高数上册含习题册那本还在吗',
        agoMs: 7 * HOUR,
      },
      { senderId: 'u-zhangyu', type: 'TEXT', content: '在的，可以面交', agoMs: 6.4 * HOUR },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.proposal', amountCents: 1800 }),
        agoMs: 6 * HOUR,
      },
      {
        senderId: 'u-zhangyu',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.accepted', transactionId: 't-101', amountCents: 1800 }),
        agoMs: 5.4 * HOUR,
      },
      {
        senderId: 'u-zhangyu',
        type: 'TEXT',
        content: '今晚在图书馆一楼碰面可以吗',
        agoMs: 5 * HOUR,
      },
    ],
  },
  {
    id: 'c-008',
    listingId: 'l-026',
    counterpartId: 'u-lin',
    unreadCount: 1,
    kind: 'deal',
    timeLabel: '昨天',
    tag: '待面交',
    tagDone: false,
    online: true,
    lastMessageAt: isoAgo(20 * HOUR),
    messages: [
      { senderId: 'u-alan', type: 'TEXT', content: '鼠标还在吗？接收器一起给吗', agoMs: 23 * HOUR },
      { senderId: 'u-lin', type: 'TEXT', content: '在，接收器原装的都在', agoMs: 22 * HOUR },
      {
        senderId: 'u-lin',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.accepted', transactionId: 't-102', amountCents: 8500 }),
        agoMs: 21 * HOUR,
      },
      {
        senderId: 'u-lin',
        type: 'TEXT',
        content: '明天下午在宿舍楼下给你送过去',
        agoMs: 20 * HOUR,
      },
    ],
  },
  {
    id: 'c-009',
    listingId: 'l-031',
    counterpartId: 'u-suyiran',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '5 月 11 日',
    tag: '待面交',
    tagDone: false,
    online: false,
    lastMessageAt: isoAgo(30 * 24 * HOUR),
    messages: [
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '单反快门数多少？镜头有霉吗',
        agoMs: 31 * 24 * HOUR,
      },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '快门 8000 出头，无霉无雾，可以当面验机',
        agoMs: 30.6 * 24 * HOUR,
      },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({
          type: 'tx.accepted',
          transactionId: 't-103',
          amountCents: 105000,
        }),
        agoMs: 30.2 * 24 * HOUR,
      },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '这周末我都在学校，你定时间',
        agoMs: 30 * 24 * HOUR,
      },
    ],
  },
  {
    id: 'c-010',
    listingId: 'l-037',
    counterpartId: 'u-zhouyan',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '5 月 12 日',
    tag: '已完成',
    tagDone: true,
    online: false,
    lastMessageAt: isoAgo(27 * 24 * HOUR),
    messages: [
      {
        senderId: 'u-zhouyan',
        type: 'TEXT',
        content: '台灯我要了，可调色温那款对吧',
        agoMs: 28 * 24 * HOUR,
      },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.accepted', transactionId: 't-104', amountCents: 4500 }),
        agoMs: 27.5 * 24 * HOUR,
      },
      { senderId: 'u-zhouyan', type: 'TEXT', content: '已收到，谢谢！', agoMs: 27 * 24 * HOUR },
    ],
  },
  {
    id: 'c-011',
    listingId: 'l-038',
    counterpartId: 'u-hexu',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '5 月 9 日',
    tag: '已取消',
    tagDone: true,
    online: false,
    lastMessageAt: isoAgo(31 * 24 * HOUR),
    messages: [
      { senderId: 'u-hexu', type: 'TEXT', content: '键盘能 100 出吗', agoMs: 32 * 24 * HOUR },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.proposal', amountCents: 10000 }),
        agoMs: 31.6 * 24 * HOUR,
      },
      {
        senderId: 'u-hexu',
        type: 'SYSTEM',
        content: JSON.stringify({ type: 'tx.rejected' }),
        agoMs: 31 * 24 * HOUR,
      },
    ],
  },
  {
    id: 'c-012',
    listingId: 'l-039',
    counterpartId: 'u-xuche',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '5 月 6 日',
    tag: '已完成',
    tagDone: true,
    online: false,
    lastMessageAt: isoAgo(34 * 24 * HOUR),
    messages: [
      { senderId: 'u-xuche', type: 'TEXT', content: '球拍双拍装还有吗', agoMs: 35 * 24 * HOUR },
      {
        senderId: 'u-alan',
        type: 'SYSTEM',
        content: JSON.stringify({
          type: 'tx.accepted',
          transactionId: 't-106',
          amountCents: 16000,
        }),
        agoMs: 34.5 * 24 * HOUR,
      },
      { senderId: 'u-xuche', type: 'TEXT', content: '拍子很好用，谢谢学长', agoMs: 34 * 24 * HOUR },
    ],
  },
  /* ---- D2 会话页的媒体消息会话 ----
     为什么单独建一条：D2 稿子的对象是「苏亦然 + 罗技 MX Keys 键盘 + 我卖出的商品」，
     而 fixture 里 MX Keys（l-044）此前没有任何会话。媒体消息要能连同「对方已认证、
     商品在售、交易已接受」的上下文一起复现，所以按稿子建这一条，而不是把媒体
     硬塞进别的会话里（那会让原本已验收的会话串味）。
     末几条故意留着 UPLOADING / FAILED：稿子第 03 帧画的正是这两种状态。 */
  {
    id: 'c-013',
    listingId: 'l-044',
    counterpartId: 'u-suyiran',
    unreadCount: 0,
    kind: 'deal',
    timeLabel: '今天',
    tag: '交易',
    tagDone: false,
    online: true,
    lastMessageAt: isoAgo(2 * HOUR),
    messages: [
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '键盘我挂出来了，你要是还想要就直接拍，别砍太狠就行。',
        agoMs: 4 * HOUR,
      },
      { senderId: 'u-alan', type: 'TEXT', content: '好，我先看看成色。', agoMs: 3.9 * HOUR },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: JSON.stringify({ type: 'tx.accepted', amountCents: 32000 }),
        agoMs: 3.8 * HOUR,
      },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '',
        agoMs: 3.6 * HOUR,
        media: { kind: 'IMAGE', imageSlug: 'digital-mxkeys' },
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '',
        agoMs: 3.5 * HOUR,
        media: { kind: 'VOICE', durationSec: 7 },
      },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '',
        agoMs: 3.4 * HOUR,
        media: { kind: 'VOICE', durationSec: 12 },
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '',
        agoMs: 3.3 * HOUR,
        media: { kind: 'IMAGE', imageSlug: 'digital-mxkeys' },
      },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '收到，今晚 7 点在图书馆一楼大厅可以吗？我带充电线和包装盒。',
        agoMs: 3.2 * HOUR,
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '',
        agoMs: 3 * HOUR,
        media: { kind: 'IMAGE', imageSlug: 'digital-mxkeys', state: 'UPLOADING', progress: 62 },
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '',
        agoMs: 2.4 * HOUR,
        media: { kind: 'IMAGE', imageSlug: 'digital-mxkeys', state: 'FAILED' },
      },
      {
        senderId: 'u-alan',
        type: 'TEXT',
        content: '那我把打包盒也一起带过去，省得你找箱子。',
        agoMs: 2.2 * HOUR,
      },
      {
        senderId: 'u-suyiran',
        type: 'TEXT',
        content: '',
        agoMs: 2 * HOUR,
        media: { kind: 'VOICE', durationSec: 3 },
      },
    ],
  },
]

export const CONVERSATIONS: MockConversation[] = SPECS.map((spec) => {
  const listing = getListing(spec.listingId) ?? LISTINGS[0]
  const isSeller = listing ? listing.sellerId === CURRENT_USER_ID : false
  /**
   * `lastMessage` 取**最后一条契约内消息**（媒体不算，见 types.ts 的
   * `MockMediaMessage`）：否则列表预览会拿到空字符串。
   * 最后一条恰是媒体时，由 `mediaPreview` 给出 `[图片]` / `[语音] 12"`。
   */
  const normal = spec.messages.filter((message) => !message.media)
  const last = normal[normal.length - 1]
  const tail = spec.messages[spec.messages.length - 1]
  const mediaPreview = tail?.media
    ? tail.media.kind === 'IMAGE'
      ? '[图片]'
      : `[语音] ${tail.media.durationSec ?? 0}"`
    : null
  return {
    id: spec.id,
    role: isSeller ? 'seller' : 'buyer',
    /**
     * 契约 `ConversationDto` 是**服务端组装**好的读模型（商品摘要 + 对方摘要内嵌），
     * 所以这里也在数据层一次组装完，页面不再拿 id 自己查表。
     */
    listing: {
      // 契约对这张卡片的取值口径是「与 #6 的商品卡片一致（脏数据不 500）」，
      // 所以商品缺失时降级成占位值，而不是让整条会话渲染不出来。
      id: listing?.id ?? spec.listingId,
      title: listing?.title ?? '商品已下架',
      priceCents: listing?.priceCents ?? 0,
      status: listing?.status ?? 'OFFLINE',
      coverUrl: listing?.coverUrl ?? null,
    },
    counterpart: (() => {
      const user = getUser(spec.counterpartId)
      return {
        id: user.id,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        // mock 专属：契约的 ConversationUser 没有 authStatus，列表行徽章要用
        authStatus: user.authStatus,
      }
    })(),
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
    mediaPreview,
  }
})

export const MESSAGES: MockMessage[] = SPECS.flatMap((spec) =>
  spec.messages.flatMap((message, index) => {
    if (message.media) return []
    return [
      {
        id: `${spec.id}-m${String(index + 1).padStart(2, '0')}`,
        conversationId: spec.id,
        senderId: message.senderId,
        type: message.type,
        content: message.content,
        createdAt: isoAgo(message.agoMs),
      },
    ]
  }),
)

/** D2 的媒体消息（契约外，见 types.ts 的 MockMediaMessage） */
export const MEDIA: MockMediaMessage[] = SPECS.flatMap((spec) =>
  spec.messages.flatMap((message, index) => {
    if (!message.media || !message.senderId) return []
    const { kind, imageSlug, durationSec, state, progress } = message.media
    return [
      {
        id: `${spec.id}-x${String(index + 1).padStart(2, '0')}`,
        conversationId: spec.id,
        senderId: message.senderId,
        kind,
        imageUrl: imageSlug ? productImage(imageSlug, 0) : null,
        durationSec: durationSec ?? 0,
        createdAt: isoAgo(message.agoMs),
        state: state ?? 'DONE',
        progress: progress ?? 100,
      },
    ]
  }),
)

export function messagesOf(conversationId: string): MockMessage[] {
  return MESSAGES.filter((message) => message.conversationId === conversationId).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  )
}

export function mediaMessagesOf(conversationId: string): MockMediaMessage[] {
  return MEDIA.filter((item) => item.conversationId === conversationId).sort(
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
