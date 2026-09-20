/**
 * 「想要的人」的统计口径（共 N 人想要 / 预算中位）。
 *
 * 抽成纯函数是为了**让页面与 mock 用同一份算法**：此前页面从 `mock/api` 的
 * `watchersSummary()` 旁路取数、而那份实现排除了已注销的人，于是页面会同时出现
 * 「列表 8 行 / 共 7 人想要 / 已显示全部 7 人」三种互相打脸的数字，
 * 加载失败时还会出现「共 7 人想要 + 列表加载失败」（#139 review 两条 P1）。
 *
 * 现在的口径（本次冻结）：
 * - **已注销的人仍计入人数**。他们是历史「想要的人」，与商品卡上的
 *   `wantsOf()`（数的就是全部行）必须说同一个数；注销只影响该行的动作与视觉降级。
 * - **中位数只按「已填预算」的人算**，未填的人不计入分母也不参与排序（稿子原文：
 *   「中位数按已填预算的 12 人计算 · 6 人未填预算不计入」）。一个人都没填时返回
 *   `null`，页面显示「暂缺」——这不是错误态，是正常结果。
 */
import type { MockWatcher } from '@/mock/types'

export type WatcherStats = {
  /** 想要的人数（= 列表行数） */
  count: number
  /** 预算中位数（分）；没人填预算时为 `null` */
  medianCents: number | null
  /** 填了预算的人数（中位数的分母） */
  budgetFilled: number
}

export function watcherStatsOf(list: MockWatcher[]): WatcherStats {
  const budgets = list
    .map((item) => item.budgetCents)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b)
  const count = list.length
  if (budgets.length === 0) return { count, medianCents: null, budgetFilled: 0 }
  const mid = Math.floor(budgets.length / 2)
  const median =
    budgets.length % 2 === 0
      ? Math.round(((budgets[mid - 1] ?? 0) + (budgets[mid] ?? 0)) / 2)
      : (budgets[mid] ?? 0)
  return { count, medianCents: median, budgetFilled: budgets.length }
}
