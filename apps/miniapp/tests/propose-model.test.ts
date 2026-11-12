import { describe, expect, test } from 'bun:test'
import { proposalAmountCents, proposalAmountText } from '../src/features/transaction/propose-model'

/**
 * 「立即购买」确认弹层的金额模型（纯逻辑，无 Taro）。
 *
 * 锁 #676 的改价口径时最容易做错的两件事：
 * 1. **金额来自挂价**：买家侧只读，提案金额就是商品的 `priceCents`，与服务端强制
 *    `amountCents === priceCents` 同一条口径；端上算错会被 422 打回。
 * 2. **免费送恒 0 分**：0 元送没有可议的价，`free` 位与挂价不一致时也必须提交 0，
 *    不能让脏数据把「0 元送」提成任意数。
 */
describe('propose-model —「立即购买」金额模型（#676 买家侧只读）', () => {
  test('proposalAmountCents：取挂价本身', () => {
    expect(proposalAmountCents(76000, false)).toBe(76000)
    expect(proposalAmountCents(1, false)).toBe(1)
    expect(proposalAmountCents(0, false)).toBe(0)
    expect(proposalAmountCents(10_000_000, false)).toBe(10_000_000)
  })

  test('proposalAmountCents：免费送恒 0，与挂价无关', () => {
    expect(proposalAmountCents(0, true)).toBe(0)
    expect(proposalAmountCents(4500, true)).toBe(0)
  })

  test('proposalAmountText：两位小数展示', () => {
    expect(proposalAmountText(76000, false)).toBe('760.00')
    expect(proposalAmountText(8850, false)).toBe('88.50')
    expect(proposalAmountText(0, false)).toBe('0.00')
  })

  test('proposalAmountText：免费送显示 0.00', () => {
    expect(proposalAmountText(0, true)).toBe('0.00')
    expect(proposalAmountText(4500, true)).toBe('0.00')
  })
})
