import type { SubscribeMessageKind } from '@fish/contracts/subscribe-messages/schema'
import type { NotificationPayload, NotificationType } from '@fish/db/schema/notifications'

/**
 * 订阅消息的**纯**映射层（#462）：业务事件 → 微信模板字段。
 *
 * 为什么单独一层：三个模板的字段名（`thing4` / `phrase3` / `time8` …）与长度限制是微信侧的
 * 硬约束，改错一个字只会换来 47003（参数不合法），而那时本地已经分不清「我们写错了」与
 * 「平台故障」。把它们收口成不碰 IO 的纯函数，才能在单测里逐条钉住截断与映射。
 *
 * 三条来自 Owner 冻结口径的内容纪律：
 * 1. `thing` 类 ≤ 20 字符、`phrase` 类 ≤ 5 个汉字，超出截断加 `…`（`phrase` 不截断汉字数以外
 *    的规则，直接按字符数裁）。
 * 2. CHAT 的「消息内容」固定写「你有一条新消息」：**不推私聊正文**；发送人昵称、物品名称
 *    分别取对方昵称与会话关联商品标题 —— 这三样都不构成正文泄漏。
 * 3. 时间一律 `Asia/Shanghai`：`time` 类 `YYYY-MM-DD HH:mm`，`date` 类 `YYYY-MM-DD`。
 */

/** 微信 `thing.DATA` 的字符上限（官方：20 个以内字符，可汉字、数字、字母或符号）。 */
export const THING_MAX_CHARS = 20

/** 微信 `phrase.DATA` 的上限（官方：5 个以内汉字）。 */
export const PHRASE_MAX_CHARS = 5

/** 截断后补的省略号。它本身算一个字符，所以裁到 `max - 1` 再拼。 */
const ELLIPSIS = '…'

/**
 * 按**码点**截断（`[...value]` 而不是 `value.slice`）：`slice` 按 UTF-16 码元切，会把
 * emoji / 生僻字的代理对切成半个字符，微信侧收到孤立代理对就是 47003。
 * 另外把换行 / 制表等空白压成单个空格：多行标题塞进单行 `thing` 会渲染成奇怪的空白。
 */
function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const chars = [...normalized]
  if (chars.length <= max) return normalized
  // max 至少为 2 才有意义（1 个省略号 + 0 个字符）；调用方传的都是 5 / 20。
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}${ELLIPSIS}`
}

/** `thing` 类字段：≤20 字符，超出截断加 `…`。 */
export function truncateThing(value: string): string {
  return truncate(value, THING_MAX_CHARS)
}

/** `phrase` 类字段：≤5 个汉字，超出截断加 `…`。 */
export function truncatePhrase(value: string): string {
  return truncate(value, PHRASE_MAX_CHARS)
}

/** `thing` 类字段的兜底：截断后为空就换一个占位串，绝不给微信发空 `thing`。 */
function thingOr(value: string | null | undefined, fallback: string): string {
  const truncated = truncateThing(value ?? '')
  return truncated.length === 0 ? fallback : truncated
}

/**
 * 北京时间（`Asia/Shanghai`）的 8 小时固定偏移。
 *
 * 为什么不用 `Intl.DateTimeFormat`：1986 年后中国不再有夏令时，`+08:00` 是**恒定**偏移，
 * 手算比走 ICU 稳（不同 Bun / 系统 ICU 版本的输出格式差异会让单测在不同机器上不一致）。
 * 挪成 UTC 后只读 UTC getter，避免"本地时区"这个第二变量。
 */
const CST_OFFSET_MS = 8 * 60 * 60 * 1000

function cstParts(date: Date): { y: string; m: string; d: string; hh: string; mm: string } {
  const shifted = new Date(date.getTime() + CST_OFFSET_MS)
  return {
    y: String(shifted.getUTCFullYear()).padStart(4, '0'),
    m: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    d: String(shifted.getUTCDate()).padStart(2, '0'),
    hh: String(shifted.getUTCHours()).padStart(2, '0'),
    mm: String(shifted.getUTCMinutes()).padStart(2, '0'),
  }
}

/** `time` 类字段：`YYYY-MM-DD HH:mm`（北京时间）。 */
export function formatTimeCST(date: Date): string {
  const p = cstParts(date)
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}`
}

/** `date` 类字段：`YYYY-MM-DD`（北京时间）。 */
export function formatDateCST(date: Date): string {
  const p = cstParts(date)
  return `${p.y}-${p.m}-${p.d}`
}

/** 一条待登记的投递内容。`data` 的键就是微信模板字段名。 */
export type SubscribeDeliveryContent = {
  kind: SubscribeMessageKind
  page: string
  data: Record<string, string>
}

/**
 * 站内通知的投递映射（`TX` / `DISPUTE` → 订单模板，`MODERATION` / `ACCOUNT` → 审核模板）。
 *
 * 入参里的 ID 已经是**公开 TypeID**（`txn_` / `cnv_` / `lst_`）：库里存的是裸 UUID，
 * 编码在 store 里做（那里才拿得到行），这样本函数保持纯函数、单测不用准备 UUID。
 *
 * 返回 `null` 表示**这条通知不投递**：
 * - `MATCH` 不在首批（求购匹配，Owner 明确排除）；
 * - `TX` / `DISPUTE` 既没有交易也没有会话：拼不出任何能打开的页面，推过去只会让用户点到
 *   一个 404 —— 宁可不发（在 30 分钟扫描窗口内它只是被重扫几次，不产生投递行）。
 */
export function notificationDeliveryContent(input: {
  type: NotificationType
  payload: NotificationPayload
  createdAt: Date
  /** 关联商品的标题（`payload.listingId` 或交易指向的商品），查不到为 `null`。 */
  listingTitle: string | null
  transactionId: string | null
  conversationId: string | null
  listingId: string | null
}): SubscribeDeliveryContent | null {
  if (input.type === 'TX' || input.type === 'DISPUTE') {
    const phrase = orderStatusPhrase(input)
    if (phrase === null) return null
    // 交易详情优先；没有交易（`PROPOSED` 阶段提案不落表）时退到会话页。
    const page =
      input.transactionId !== null
        ? `pkg-trade/pages/transaction-meetup/index?id=${encodeURIComponent(input.transactionId)}`
        : input.conversationId !== null
          ? `pkg-social/pages/conversation/index?id=${encodeURIComponent(input.conversationId)}`
          : null
    if (page === null) return null
    return {
      kind: 'TX',
      page,
      data: {
        thing6: thingOr(input.listingTitle, '交易商品'),
        phrase3: truncatePhrase(phrase),
        time8: formatTimeCST(input.createdAt),
        thing5: '点击查看交易详情',
      },
    }
  }

  if (input.type === 'MODERATION') {
    if (input.listingId === null) return null
    return {
      kind: 'REVIEW',
      page: `pkg-browse/pages/listing-detail/index?id=${encodeURIComponent(input.listingId)}`,
      data: {
        thing2: thingOr(input.listingTitle, '商品审核'),
        phrase1: reviewOutcomePhrase(input.payload.outcome, '审核'),
        date3: formatDateCST(input.createdAt),
        thing7: '点击查看商品详情',
      },
    }
  }

  if (input.type === 'ACCOUNT') {
    // P1 只有校园认证一颗（`subject = VERIFICATION`）：其它主题不猜文案，直接不投。
    if (input.payload.subject !== 'VERIFICATION') return null
    return {
      kind: 'REVIEW',
      page: 'pkg-auth/pages/verify/index',
      data: {
        thing2: '校园认证',
        phrase1: reviewOutcomePhrase(input.payload.outcome, '认证'),
        date3: formatDateCST(input.createdAt),
        thing7: '点击查看认证状态',
      },
    }
  }

  // `MATCH`：不在首批（Owner 冻结范围里明确排除求购匹配）。
  return null
}

/** `TX` 六个事件 + `DISPUTE` 三个事件 → 订单状态短语（都 ≤5 个汉字）。 */
function orderStatusPhrase(input: {
  type: NotificationType
  payload: NotificationPayload
}): string | null {
  if (input.type === 'TX') {
    switch (input.payload.event) {
      case 'PROPOSED':
        return '待接受'
      case 'ACCEPTED':
        return '已接受'
      case 'REJECTED':
        return '已拒绝'
      case 'CONFIRMED':
        return '已确认'
      case 'COMPLETED':
        return '已完成'
      case 'CANCELLED':
        return '已取消'
      default:
        // 事件缺失或值集外的脏 payload：不猜文案（猜错会把"已取消"推成"已完成"）。
        return null
    }
  }
  switch (input.payload.disputeEvent) {
    case 'FILED':
      return '纠纷处理中'
    case 'WITHDRAWN':
      return '纠纷已撤回'
    case 'RESOLVED':
      return '纠纷已处理'
    default:
      return null
  }
}

/** 审核结论短语：`审核通过` / `审核未通过`（后者 5 个汉字，正好在 `phrase` 上限内）。 */
function reviewOutcomePhrase(
  outcome: NotificationPayload['outcome'],
  subject: '审核' | '认证',
): string {
  if (outcome === 'APPROVED') return `${subject}通过`
  if (outcome === 'REJECTED') return `${subject}未通过`
  // 结论缺失：`phrase` 不能空着发，给一个中性词（总比整条不发更接近事实）。
  return `${subject}有结果`
}

/**
 * 聊天未读提醒（CHAT）的内容。
 *
 * 「消息内容」固定「你有一条新消息」—— 私聊正文一个字都不进微信（Owner 冻结）。
 * 发送时间取**触发这条投递的那条消息**的时间，不是投递时间。
 */
export function chatDeliveryContent(input: {
  conversationId: string
  senderNickname: string
  listingTitle: string
  messageCreatedAt: Date
}): SubscribeDeliveryContent {
  return {
    kind: 'CHAT',
    page: `pkg-social/pages/conversation/index?id=${encodeURIComponent(input.conversationId)}`,
    data: {
      thing4: thingOr(input.senderNickname, '对方'),
      thing2: '你有一条新消息',
      thing28: thingOr(input.listingTitle, '会话商品'),
      time3: formatTimeCST(input.messageCreatedAt),
    },
  }
}
