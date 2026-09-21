import { describe, expect, test } from 'bun:test'
import { watcherBudgetLabel } from '../src/features/watchers/budget'

/**
 * 「想要的人」行上预算文案的回归测试 —— 锁住「没填预算」被显示成「预算 ¥0」的那个 bug。
 *
 * 修复前，已注销那一行写的是 `formatAmount(item.budgetCents ?? 0)`：`null`（用户没填）
 * 被 `?? 0` 吞掉，走进和「真的填了 0 元」完全相同的分支。mock fixture 里那条已注销记录
 * 恰好填了 300 元，所以这个 bug 在演示里看不见；真实数据一旦出现「已注销 + 未填预算」，
 * 页面就会替用户编一份他没填过的 0 元预算。
 *
 * 三条用例把 `null` / `0` / 正数三种输入分开钉住：**前两者必须是两种不同的文案**。
 */
describe('想要的人预算文案', () => {
  test('未填预算（null）→ 「未填预算」，不是「预算 ¥0」', () => {
    expect(watcherBudgetLabel(null)).toBe('未填预算')
  })

  test('0 元预算 → 「预算 ¥0」（真的填了 0，和「没填」是两回事）', () => {
    expect(watcherBudgetLabel(0)).toBe('预算 ¥0')
  })

  test('正数预算 → 「预算 ¥X」', () => {
    expect(watcherBudgetLabel(35000)).toBe('预算 ¥350')
  })
})
