/**
 * 会话「已读」策略。
 *
 * 只有页面可见时才允许把新消息立即标已读；后台标签页收到消息必须记账、等页面回到可见
 * 再补标。否则用户挂着会话页去干别的，未读角标会被错误清零。
 */
export type ReadReceiptState = { unreadWhileHidden: boolean }

export const INITIAL_READ_RECEIPT_STATE: ReadReceiptState = { unreadWhileHidden: false }

export type ReadReceiptDecision = { state: ReadReceiptState; markRead: boolean }

/** 收到对方新消息：可见就立即标已读；隐藏就记账、等回到可见再补。 */
export function onIncomingMessage(visibility: DocumentVisibilityState): ReadReceiptDecision {
  if (visibility === 'visible') return { state: INITIAL_READ_RECEIPT_STATE, markRead: true }
  return { state: { unreadWhileHidden: true }, markRead: false }
}

/**
 * 可见性变化 / 会话未读数变化时的统一判定。
 *
 * 隐藏时一律不标已读，只把「确有未读」记在状态里；可见时只要隐藏期间记过账或当前仍有
 * 未读，就补一次标已读。没有未读时返回 `markRead: false`，避免无意义的读回写请求。
 */
export function resolveReadReceipt(
  state: ReadReceiptState,
  visibility: DocumentVisibilityState,
  hasUnread: boolean,
): ReadReceiptDecision {
  if (visibility !== 'visible') {
    return { state: hasUnread ? { unreadWhileHidden: true } : state, markRead: false }
  }

  return {
    state: INITIAL_READ_RECEIPT_STATE,
    markRead: state.unreadWhileHidden || hasUnread,
  }
}
