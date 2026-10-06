import {
  type NotifyPrefs,
  readStoredPrefs,
  resolveNotifyPrefs,
  SETTINGS_STORAGE_KEY,
} from '@/features/settings/preferences'

/**
 * 底栏「消息」徽标的红点闸门：把通知偏好翻译成「未读快照的哪一部分要熄掉」。
 *
 * 为什么与偏好读写分成两个模块：偏好那块变的是**白名单与存储格式**（加一个开关、
 * 兼容一个旧短键），这里变的是**红点怎么算**（哪几档合并、关掉给 `0` 还是 `null`）。
 * 两件事的评审口径不同，混在一个文件里改一侧要读懂另一侧（#470 review：Divergent Change）。
 */

/** 底栏徽标要闸门的两项未读 —— 恒成对出现，所以给个名字，别再逐处拆成两个参数 */
export type UnreadCounts = {
  conversations: number | null
  notifications: number | null
}

/**
 * 设置页写了通知开关后广播的事件：底栏实例常驻每个 Tab 页，不会因设置页的
 * state 变化重渲染，靠这个事件把自己的徽标重算一遍（同 `lib/tabbar-sync` 的
 * `TABBAR_ROUTE_EVENT` 模式：订阅方在挂载时注册、卸载时注销）。
 */
export const NOTIFY_PREFS_EVENT = 'fish:notify-prefs-changed'

/**
 * 从本机存储读通知偏好。
 *
 * `Taro.getStorageSync` 只能在端上跑，读函数由调用方注入（也让本函数可单测）；
 * 存储读失败按「没存过」处理。抽出来的原因：此前每个消费方都要自己拼
 * `resolveNotifyPrefs(readStoredPrefs(Taro.getStorageSync(...)))` 这条链
 * （#470 review：Feature Envy + Message Chains）。
 */
export function readNotifyPrefsFromStorage(read: (key: string) => unknown): NotifyPrefs {
  try {
    return resolveNotifyPrefs(readStoredPrefs(read(SETTINGS_STORAGE_KEY)))
  } catch {
    return resolveNotifyPrefs({})
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
export function gateUnreadForNotifyPrefs(input: UnreadCounts, prefs: NotifyPrefs): UnreadCounts {
  return {
    conversations: prefs.notifyChat ? input.conversations : 0,
    notifications:
      prefs.notifyWish || prefs.notifyDeal || prefs.notifyNews ? input.notifications : 0,
  }
}
