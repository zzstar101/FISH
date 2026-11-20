/**
 * #694 M3 的初始限流策略（冻结在代码里并写进部署文档，改动需同步文档与测试）。
 *
 * 口径：滑动窗口，按「主体 + bucket」计数；幂等重放不消耗配额（在重放快速路径之后才计数）。
 */
export const CHAT_SEND_PER_CONVERSATION = { limit: 30, windowSeconds: 60 } as const
export const CHAT_SEND_PER_ACCOUNT = { limit: 120, windowSeconds: 60 } as const
export const CHAT_MEDIA_PRESIGN_PER_ACCOUNT = { limit: 30, windowSeconds: 60 } as const
export const CHAT_MEDIA_CREATE_PER_ACCOUNT = { limit: 30, windowSeconds: 60 } as const
/** 「10 分钟主动联系新卖家」：同一买家在窗口内新建会话的不同卖家数上限。 */
export const NEW_SELLER_CONTACTS = { limit: 10, windowSeconds: 600 } as const

export const RATE_LIMIT_BUCKETS = {
  chatSendConversation: 'chat:send:conversation',
  chatSendAccount: 'chat:send:account',
  chatMediaPresignAccount: 'chat:media:presign:account',
  chatMediaCreateAccount: 'chat:media:create:account',
  chatNewSellerContact: 'chat:new-seller-contact',
} as const
