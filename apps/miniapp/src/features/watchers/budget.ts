/**
 * 「想要的人」列表行上预算的展示文案。
 *
 * **`null`（没填）与 `0`（真的填了 0 元）是两种不同的事实**，不能混为一谈。
 * 修复前，已注销那一行写的是 `formatAmount(item.budgetCents ?? 0)`：`null` 被
 * `?? 0` 吞掉，走进和「0 元预算」完全相同的分支，渲染成「预算 ¥0」——
 * 等于替一个已经注销、什么都没填的人编了一份预算（现存 mock fixture 里那条
 * 已注销记录恰好填了 300 元，所以这个 bug 现在看不见，真实数据一到就会露出来）。
 *
 * 抽成纯函数后，「已注销」与「正常」两种行状态共用同一条口径，也能直接被单元测试锁住。
 * 金额格式化复用 mock 数据层的 `formatAmount`，与商品价格、预算中位数保持同一口径。
 */
import { formatAmount } from '@/mock/api'

/** 预算展示文案：`null` → 「未填预算」，`0` → 「预算 ¥0」，正数 → 「预算 ¥X」 */
export function watcherBudgetLabel(budgetCents: number | null): string {
  return budgetCents === null ? '未填预算' : `预算 ¥${formatAmount(budgetCents)}`
}
