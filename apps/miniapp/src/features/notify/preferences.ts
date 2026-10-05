import type { MockSettings } from '@/mock/types'

/**
 * 设置页偏好项的本机持久化（纯函数部分）。
 *
 * 页面把偏好落 `Taro.setStorageSync`（`BLOCKED: #66`，不写后端），本模块负责
 * **读回**：挂载时把存过的值合并到默认值上，persist 时把存量与增量合并。
 * `Taro.getStorageSync` 只能在端上跑，所以解析/校验抽在这里单测
 * （与 `pages/feedback/draft.ts` 的 `parseFeedbackDraft` 同一口径）。
 *
 * 消费方有两处：设置页自己（写 + 挂载读回）与 `custom-tab-bar`（底栏「消息」徽标
 * 按 `resolveNotifyPrefs` / `gateUnreadForNotifyPrefs` 消费通知开关）。放在
 * `features/notify` 而不是设置页目录里，就是为了这条「写侧与读侧同一份白名单」的
 * 依赖方向（组件 → features，而不是组件反向 import 页面模块）。
 *
 * 只认清单内的键与类型：存储损坏、写了垃圾值时**按字段丢弃**、回默认值，
 * 不整份丢（用户改过的开关比整份默认值值钱），也不让垃圾值上屏。
 */

export const SETTINGS_STORAGE_KEY = 'fish:settings'

/** 「谁可以给我留言」的三个档位（页面 ActionSheet 的选项与此同源） */
export const COMMENT_POLICIES = ['已认证用户', '所有人', '仅好友'] as const

/** 从存储读出的合法偏好（只含认得出的键） */
type StoredPrefs = Partial<MockSettings>

/**
 * 通知明细四行的存储键 = `MockSettings` 的 notify* 字段。
 *
 * 页面的明细行、本模块的读回白名单、底栏的闸门共用这一份；`satisfies` 对契约字段锁定，
 * 改名/删字段即编译错，写读两侧不可能再各写各的。
 */
export const NOTIFY_KEYS = [
  'notifyChat',
  'notifyWish',
  'notifyDeal',
  'notifyNews',
] as const satisfies readonly (keyof MockSettings)[]

export type NotifyKey = (typeof NOTIFY_KEYS)[number]

/**
 * 旧版设置页的短键（`'chat'` 等）→ 现行 `notify*` 字段。
 *
 * 旧实现 `persist({ [item.key]: !item.value })` 里的 `item.key` 曾经就是这些短键，
 * 已在用户本机存下；只认新键会让老用户升级后 4 个通知项**回默认**，且下一次
 * `persist()` 的 base（即本函数的返回值）不含短键、写入时把它们彻底冲掉。
 * 读回时新键优先、旧键兜底，读出即是新形态，写回自然完成替换。
 */
export const legacyNotifyKeys: Record<NotifyKey, string> = {
  notifyChat: 'chat',
  notifyWish: 'wish',
  notifyDeal: 'deal',
  notifyNews: 'news',
}

const isCommentPolicy = (value: unknown): value is MockSettings['commentPolicy'] =>
  typeof value === 'string' && (COMMENT_POLICIES as readonly string[]).includes(value)

/**
 * 存储原始值 → 合法偏好。
 *
 * weapp 的 `getStorageSync` 原样返回存进去的对象；H5 形态返回 JSON 字符串
 * （同 `parseFeedbackDraft` 的坑）。两形态都收，其余（空串 / null / 数组 /
 * 坏 JSON）一律视为「没存过」。
 */
export function readStoredPrefs(raw: unknown): StoredPrefs {
  let source: unknown = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      return {}
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {}
  const stored = source as Record<string, unknown>
  const prefs: StoredPrefs = {}
  for (const key of NOTIFY_KEYS) {
    // 新键优先、旧短键兜底。判据是「新键本身是不是一个 boolean」，不是 `??`：
    // 新键存了损坏值（非 boolean）时应回落到仍然合法的旧短键，而不是把这一项一起丢；
    // 也不能写成 `||`，那会把合法的新键 `false` 当成缺省、让旧短键把它顶掉。
    const next: unknown = stored[key]
    const value: unknown = typeof next === 'boolean' ? next : stored[legacyNotifyKeys[key]]
    if (typeof value === 'boolean') prefs[key] = value
  }
  if (isCommentPolicy(stored.commentPolicy)) prefs.commentPolicy = stored.commentPolicy
  return prefs
}

/** 挂载时的初始偏好：存量偏好盖在默认值上 */
export function parseStoredPrefs(raw: unknown, defaults: MockSettings): MockSettings {
  return { ...defaults, ...readStoredPrefs(raw) }
}

/**
 * 设置页写了通知开关后广播的事件：底栏实例常驻每个 Tab 页，不会因设置页的
 * state 变化重渲染，靠这个事件把自己的徽标重算一遍（同 `lib/tabbar-sync` 的
 * `TABBAR_ROUTE_EVENT` 模式：订阅方在挂载时注册、卸载时注销）。
 */
export const NOTIFY_PREFS_EVENT = 'fish:notify-prefs-changed'

/** 底栏闸门用的通知偏好（只含四个通知键，缺省 = 开） */
export type NotifyPrefs = Record<NotifyKey, boolean>

/** 通知偏好默认值：四类全开 —— 「没存过」与「存了垃圾」都按默认放行红点 */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  notifyChat: true,
  notifyWish: true,
  notifyDeal: true,
  notifyNews: true,
}

/**
 * 存量偏好 → 闸门用的四布尔。读回白名单（`readStoredPrefs`）已经把非 boolean
 * 的垃圾值丢掉了，这里只补「没存过 = 开」的默认。
 */
export function resolveNotifyPrefs(stored: StoredPrefs): NotifyPrefs {
  return {
    notifyChat: stored.notifyChat ?? DEFAULT_NOTIFY_PREFS.notifyChat,
    notifyWish: stored.notifyWish ?? DEFAULT_NOTIFY_PREFS.notifyWish,
    notifyDeal: stored.notifyDeal ?? DEFAULT_NOTIFY_PREFS.notifyDeal,
    notifyNews: stored.notifyNews ?? DEFAULT_NOTIFY_PREFS.notifyNews,
  }
}

/**
 * 按通知偏好**关掉**未读快照的对应分量（底栏「消息」徽标的闸门）。
 *
 * 语义是「用户关了这类提醒，这类未读**不计入**红点」，所以关掉的分量给 `0`
 * （明确的「不计入」），而不是 `null`（「不知道」，会触发 `unreadBadgeText`
 * 的保持上一帧规则）；开着的分量原样透传（包括 `null` —— 闸门不该把
 * 「还没拿到」偷换成「没有」）。
 *
 * 通知类三档（许愿命中 / 交易提醒 / 活动与公告）在服务端是同一个未读计数
 * （`GET /notifications/unread-count` 不分种类），本地无法按行拆分，所以取
 * 「任一开着就计入」：全关才熄通知分量。逐类过滤通知**列表**不在闸门的职责里 ——
 * 列表是用户主动打开的界面，显示真实未读；闸门只管被动亮着的红点。
 */
export function gateUnreadForNotifyPrefs(
  input: { conversations: number | null; notifications: number | null },
  prefs: NotifyPrefs,
): { conversations: number | null; notifications: number | null } {
  return {
    conversations: prefs.notifyChat ? input.conversations : 0,
    notifications:
      prefs.notifyWish || prefs.notifyDeal || prefs.notifyNews ? input.notifications : 0,
  }
}
