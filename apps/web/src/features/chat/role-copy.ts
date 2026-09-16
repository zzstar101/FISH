import type { ConversationRole } from '@fish/contracts/chat/schema'

export type ConversationRoleCopy = {
  selfLabel: string
  counterpartLabel: string
}

export const conversationRoleCopy: Record<ConversationRole, ConversationRoleCopy> = {
  buyer: {
    selfLabel: '我在买',
    counterpartLabel: '卖家',
  },
  seller: {
    selfLabel: '我在卖',
    counterpartLabel: '买家',
  },
}
