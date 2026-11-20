import {
  CHAT_MEDIA_CREATE_PER_ACCOUNT,
  CHAT_MEDIA_PRESIGN_PER_ACCOUNT,
  CHAT_SEND_PER_ACCOUNT,
  CHAT_SEND_PER_CONVERSATION,
  NEW_SELLER_CONTACTS,
  RATE_LIMIT_BUCKETS,
} from './limits'
import type { RateLimitDecision, RateLimitStore } from './store'

/**
 * 聊天域的服务端限流入口（#694 M3）。
 *
 * 所有方法是「真实新请求」的计数点：调用方必须先处理幂等重放（重放不是新请求），
 * 且必须先过封禁/拉黑守卫（被拒绝的写入不该消耗受害者的额度）。
 */
export interface ChatRateLimiter {
  takeTextSend(userId: string, conversationId: string): Promise<RateLimitDecision>
  takeMediaPresign(userId: string, conversationId: string): Promise<RateLimitDecision>
  takeMediaCreate(userId: string, conversationId: string): Promise<RateLimitDecision>
  takeNewSellerContact(buyerId: string, sellerId: string): Promise<RateLimitDecision>
}

export function createChatRateLimiter({ store }: { store: RateLimitStore }): ChatRateLimiter {
  return {
    takeTextSend(userId, conversationId) {
      return store.takeAll([
        {
          bucket: RATE_LIMIT_BUCKETS.chatSendConversation,
          subject: conversationId,
          ...CHAT_SEND_PER_CONVERSATION,
        },
        { bucket: RATE_LIMIT_BUCKETS.chatSendAccount, subject: userId, ...CHAT_SEND_PER_ACCOUNT },
      ])
    },
    takeMediaPresign(userId, conversationId) {
      // 预签名单独计数（与文本额度互不挤占），但仍按账号维度累计，防止跨会话绕过。
      return store.takeAll([
        {
          bucket: RATE_LIMIT_BUCKETS.chatMediaPresignAccount,
          subject: userId,
          ...CHAT_MEDIA_PRESIGN_PER_ACCOUNT,
        },
        {
          bucket: RATE_LIMIT_BUCKETS.chatSendConversation,
          subject: conversationId,
          ...CHAT_SEND_PER_CONVERSATION,
        },
      ])
    },
    takeMediaCreate(userId, conversationId) {
      return store.takeAll([
        {
          bucket: RATE_LIMIT_BUCKETS.chatMediaCreateAccount,
          subject: userId,
          ...CHAT_MEDIA_CREATE_PER_ACCOUNT,
        },
        {
          bucket: RATE_LIMIT_BUCKETS.chatSendConversation,
          subject: conversationId,
          ...CHAT_SEND_PER_CONVERSATION,
        },
      ])
    },
    takeNewSellerContact(buyerId, _sellerId) {
      // 口径是「同一买家 10 分钟内最多主动联系 10 个**新**卖家」：计数主体是买家，
      // 调用方保证只在「没有既有会话」时才走到这里，所以重复点同一商品不会消耗额度。
      return store.takeAll([
        {
          bucket: RATE_LIMIT_BUCKETS.chatNewSellerContact,
          subject: buyerId,
          ...NEW_SELLER_CONTACTS,
        },
      ])
    },
  }
}
