import { describe, expect, test } from 'bun:test'
import {
  initialAmountValue,
  proposalAmountCents,
  proposalAmountError,
} from '../src/features/transaction/propose-model'

/**
 * 「立即购买」确认弹层的金额模型（对齐 PC buy-dialog；纯逻辑，无 Taro）。
 *
 * 锁三件接弹层时最容易做错的事：
 * 1. **初值口径**：非免费送按挂价补两位小数；免费送锁 `'0'`（输入框禁用）；
 * 2. **免费送恒 0 分**：0 元送没有可议的价，不能让输入框里的数字把「0 元送」提成任意数
 *    （`parsePriceToCents` 的 free 分支，与发布页同一把尺）；
 * 3. **非法输入**：金额正则（整数或最多两位小数）之外一律 `null`，由字段错误文案兜住，
 *    绝不把 `NaN` 分发去提案。
 */
describe('propose-model —「立即购买」金额模型', () => {
  test('initialAmountValue：非免费送按挂价补两位小数', () => {
    expect(initialAmountValue(76000, false)).toBe('760.00')
    expect(initialAmountValue(8900, false)).toBe('89.00')
    expect(initialAmountValue(0, false)).toBe('0.00')
  })

  test('initialAmountValue：免费送恒 0', () => {
    expect(initialAmountValue(4500, true)).toBe('0')
    expect(initialAmountValue(0, true)).toBe('0')
  })

  test('proposalAmountCents：合法输入按分收口', () => {
    expect(proposalAmountCents('760.00', false)).toBe(76000)
    expect(proposalAmountCents('88.5', false)).toBe(8850)
    expect(proposalAmountCents('0', false)).toBe(0)
  })

  test('proposalAmountCents：非法输入返回 null（负数/字母/三位小数/空串）', () => {
    expect(proposalAmountCents('abc', false)).toBeNull()
    expect(proposalAmountCents('', false)).toBeNull()
    expect(proposalAmountCents('-1', false)).toBeNull()
    expect(proposalAmountCents('12.345', false)).toBeNull()
  })

  test('proposalAmountCents：免费送恒 0，输入框内容不参与', () => {
    expect(proposalAmountCents('999', true)).toBe(0)
    expect(proposalAmountCents('', true)).toBe(0)
  })

  test('proposalAmountCents：超契约上限（¥100,000）按非法处理（对齐 PC）', () => {
    expect(proposalAmountCents('100000', false)).toBe(10_000_000)
    expect(proposalAmountCents('100000.01', false)).toBeNull()
    expect(proposalAmountCents('200000', false)).toBeNull()
  })

  test('proposalAmountError：免费送不校验输入', () => {
    expect(proposalAmountError('???', true)).toBeNull()
  })

  test('proposalAmountError：合法返回 null，非法给口径文案', () => {
    expect(proposalAmountError('760.00', false)).toBeNull()
    expect(proposalAmountError('abc', false)).toBe('请填写正确金额（最多两位小数）')
  })
})
