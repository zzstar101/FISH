import type { NotificationDto } from '@fish/contracts/notifications/schema'
import { ApiError } from '../../lib/api-client'

export type NotificationTarget =
  | { kind: 'listing'; listingId: string }
  | { kind: 'wish'; wishId: string }
  /** TX：会话详情（`/messages/:conversationId`），PC 有这一页 */
  | { kind: 'conversation'; conversationId: string }
  /** MODERATION：我的发布（`/mylist`）—— 未通过时原因在那里 */
  | { kind: 'mylist' }
  | { kind: 'none' }

/**
 * 点击通知跳到哪。**按 `type` 分流**：payload 里的 `listingId` 不是万能落点 ——
 * TX / MODERATION 的 payload 也带 `listingId`，一律跳商品详情会与文案承诺的落点
 * 打架（TX 的进展在会话里、MODERATION 的原因在「我的发布」），且未通过审核的商品
 * 详情页本身打不开。空字符串不当作有效目标。
 */
export function notificationTarget(item: NotificationDto): NotificationTarget {
  switch (item.type) {
    case 'TX': {
      const conversationId = item.payload.conversationId?.trim()
      return conversationId ? { kind: 'conversation', conversationId } : { kind: 'none' }
    }
    case 'MODERATION':
      return { kind: 'mylist' }
    // ACCOUNT：PC 没有认证页，文案只陈述结果，不给死链接。
    case 'ACCOUNT':
      return { kind: 'none' }
    case 'MATCH': {
      const listingId = item.payload.listingId?.trim()
      if (listingId) return { kind: 'listing', listingId }
      const wishId = item.payload.wishId?.trim()
      if (wishId) return { kind: 'wish', wishId }
      return { kind: 'none' }
    }
    // DISPUTE（#465）：用户侧争议页排在小程序（PR C，本分支未交付），PC 新增的
    // `/admin/disputes` 是管理端页面、普通用户不可达，所以这里仍给不了可用落点 ——
    // 与 ACCOUNT 同一处理，只陈述结果、不给死链接。
    case 'DISPUTE':
      return { kind: 'none' }
  }
}

export function notificationCopy(item: NotificationDto): {
  emoji: string
  title: string
  description: string
} {
  switch (item.type) {
    case 'MATCH':
      return {
        emoji: '🎯',
        title: '许愿有匹配结果',
        description: '找到了一件可能符合你愿望的闲置。',
      }
    // 任务一扩展的三类：文案与 `notificationTarget` 的落点必须一致（见那里的注释）。
    case 'TX':
      return {
        emoji: '🤝',
        title: '交易有新的进展',
        description: txEventCopy(item.payload.event),
      }
    case 'MODERATION':
      /*
       * 落点是 `/mylist`，文案只能说那里**真的**有的东西：PC「我的发布」对未通过的商品
       * 只给一个「审核未通过」标记，既没有未通过原因、也不给编辑入口（`BLOCKED` 的
       * `actionEnabled` / `editEnabled` 都是 `false`）。写「查看原因并编辑重发」会把用户
       * 送到一个什么都没有的页面 —— 小程序端那句成立，是因为那边两样都有。
       *
       * `outcome` 契约里可选（历史行 / 脏 payload 读不到）：缺省或非法值**不能**落进
       * 「未通过」分支，那等于替服务端宣布商品被拒审。只有明确的 `REJECTED` 才这么说。
       */
      switch (item.payload.outcome) {
        case 'APPROVED':
          return { emoji: '✅', title: '商品审核通过', description: '你的闲置已重新上架可见。' }
        case 'REJECTED':
          return {
            emoji: '⚠️',
            title: '商品未通过审核',
            description: '到「我的发布」可以看到这条商品。',
          }
        default:
          return {
            emoji: '🔔',
            title: '商品审核有更新',
            description: '到「我的发布」可以看到这条商品。',
          }
      }
    case 'ACCOUNT':
      // 同 MODERATION：缺省 / 非法 `outcome` 只给中性结果，不谎称认证未通过。
      switch (item.payload.outcome) {
        case 'APPROVED':
          return { emoji: '🎓', title: '校园认证通过', description: '已完成校园认证。' }
        case 'REJECTED':
          return { emoji: '⚠️', title: '校园认证未通过', description: '可以重新提交验证。' }
        default:
          return { emoji: '🔔', title: '认证结果有更新', description: '可以到认证页查看当前状态。' }
      }
    // DISPUTE（#465）：与 `notificationTarget` 一致——PC 暂无争议页，只陈述结果。
    case 'DISPUTE':
      return {
        emoji: '⚖️',
        title: '交易争议有更新',
        description: disputeEventCopy(item.payload.disputeEvent, item.payload.resolution),
      }
  }
}

/**
 * 争议通知一句话。`disputeEvent` 缺席（历史行 / 脏 payload）时退回不含事件信息的通用句，
 * 与 `txEventCopy` 同一姿态——不编一个可能不对的进展。
 *
 * `RESOLVED` **必须带上结论**：处理结果只写进 `disputes` 表和管理端页面，普通用户
 * 看不到管理端，通知是当事人目前唯一的可见出口（票面「结果可见范围」）。措辞对双方
 * 都成立（发件人不区分角色），所以不写「你的反馈」这类有视角的说法。
 */
function disputeEventCopy(
  event: NotificationDto['payload']['disputeEvent'],
  resolution: NotificationDto['payload']['resolution'],
): string {
  switch (event) {
    case 'FILED':
      return '对方就这笔交易发起了争议。'
    case 'WITHDRAWN':
      return '对方撤回了这笔交易的争议。'
    case 'RESOLVED':
      return `平台已处理这笔交易的争议：${resolutionCopy(resolution)}，该结论为最终结论。`
    default:
      return '这笔交易的争议状态有变化。'
  }
}

/** 结论一句话。脏 payload（结论字段缺席或非枚举值）退回中性说法，不猜结论。 */
function resolutionCopy(resolution: NotificationDto['payload']['resolution']): string {
  switch (resolution) {
    case 'UPHELD':
      return '认定反馈成立'
    case 'DISMISSED':
      return '认定反馈不成立'
    case 'INCONCLUSIVE':
      return '无法认定责任'
    default:
      return '结论已记录'
  }
}

/**
 * TX 一行里说给**收件人**听的那句。收件人由产生点决定（契约注释），事件本身即视角：
 * `PROPOSED` 只发卖家、`ACCEPTED` / `REJECTED` 只发买家、`CONFIRMED` / `COMPLETED` /
 * `CANCELLED` 只发对方 —— 所以按事件写死措辞是安全的，不需要再区分角色。
 *
 * 六种事件各给一句：`event` 缺席（历史行 / 脏 payload）时退回不含事件信息的通用句，
 * 而不是留空行或编一个可能不对的进展。
 */
function txEventCopy(event: NotificationDto['payload']['event']): string {
  switch (event) {
    case 'PROPOSED':
      return '买家发起了交易确认，等你接受。'
    case 'ACCEPTED':
      return '卖家接受了你的交易确认，去安排面交吧。'
    case 'REJECTED':
      return '卖家拒绝了你的交易确认。'
    case 'CONFIRMED':
      return '对方已确认面交，等你确认。'
    case 'COMPLETED':
      return '交易已完成。'
    case 'CANCELLED':
      return '交易已取消。'
    default:
      return '打开会话查看这笔交易的当前状态。'
  }
}

export function notificationReadErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'NOTIFICATION_NOT_FOUND') {
    return '通知不存在或已失效'
  }
  return '标记已读失败，请重试'
}

export function notificationTargetErrorMessage(target: NotificationTarget): string | null {
  switch (target.kind) {
    case 'listing':
      return '目标商品已不存在，已留在通知列表'
    case 'wish':
      // `/wish/$wishId` 已上线（#446）；这句只在「预检发现愿望已删/不可见」时出现。
      return '该愿望不存在或不可见，已留在通知列表'
    case 'conversation':
    case 'mylist':
    case 'none':
      return null
  }
}
