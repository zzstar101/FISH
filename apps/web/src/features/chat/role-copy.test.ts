import { describe, expect, test } from 'bun:test'
import { conversationRoleCopy } from './role-copy'

describe('conversation role copy', () => {
  test('buyer sees the seller as counterpart', () => {
    expect(conversationRoleCopy.buyer).toEqual({
      selfLabel: '我在买',
      counterpartLabel: '卖家',
    })
  })

  test('seller sees the buyer as counterpart', () => {
    expect(conversationRoleCopy.seller).toEqual({
      selfLabel: '我在卖',
      counterpartLabel: '买家',
    })
  })
})
