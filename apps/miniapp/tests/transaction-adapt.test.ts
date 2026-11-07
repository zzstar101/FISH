import { describe, expect, test } from 'bun:test'
import type { TransactionDto } from '@fish/contracts/transactions/schema'
import { toOrderCard } from '@/features/transaction/adapt'

/**
 * `features/transaction/adapt.ts` 的 `toOrderCard` 头像判据（#618）。
 *
 * 契约 `transactionUserSchema` 的 `counterpart` 本来就带 `avatarUrl`（可空）。此前这一层投影
 * 只捞 `nickname`，订单卡的头像位就只能画兜底 —— 用户在订单页永远看不到对方的真头像，
 * 而 PC 站同一位置（`apps/web-pc/src/features/profile/orders-page.tsx`）显示的是真图。
 * 现在原样透传：`null` 留给视图层落统一默认头像，有值就渲真图。
 *
 * 这两条用例在改动前会失败（那时 `OrderCardView.counterpart` 里根本没有这个字段）。
 */
function dto(overrides: Partial<TransactionDto> = {}): TransactionDto {
  return {
    id: 'tx-1',
    conversationId: 'conv-1',
    listingId: 'l-1',
    buyerId: 'u-buyer',
    sellerId: 'u-seller',
    role: 'BUYER',
    listing: {
      id: 'l-1',
      title: '高等数学 同济第七版',
      priceCents: 3800,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'u-seller', nickname: '阿星', avatarUrl: null },
    amountCents: 3800,
    status: 'PENDING_MEETUP',
    buyerConfirmedAt: null,
    sellerConfirmedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  } as TransactionDto
}

describe('toOrderCard / counterpart.avatarUrl', () => {
  test('契约给 null 就保持 null（视图层据此落统一默认头像）', () => {
    expect(toOrderCard(dto()).counterpart.avatarUrl).toBeNull()
  })

  test('契约给了真头像就原样透传', () => {
    const card = toOrderCard(
      dto({
        counterpart: {
          id: 'u-seller',
          nickname: '阿星',
          avatarUrl: 'https://cdn.example.com/a.png',
        },
      } as Partial<TransactionDto>),
    )
    expect(card.counterpart.avatarUrl).toBe('https://cdn.example.com/a.png')
  })
})
