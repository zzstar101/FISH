/**
 * 金额格式化。
 *
 * 为什么放在 `lib/` 而不是继续留在 `mock/api.ts`：真实接线后的页面也需要它
 * （会话列表要把 `tx.proposal` 的 `amountCents` 翻成「¥150」，见
 * `pages/chat/list-view.ts`），而真实页面不该为了一个纯函数静态 import 整包 fixture。
 * `mock/api.ts` 仍原样 re-export 这两个名字，既有 `@/mock/api` 的 import 路径不受影响。
 */

/** 带 ¥ 与千分位（`¥1,600`）。设计稿里 ¥ 和数字分开排版时用下面的 `formatAmount` */
export function formatYuan(cents: number): string {
  return `¥${formatAmount(cents)}`
}

/** 只要数字部分（设计稿里 ¥ 和数字是分开排版的） */
export function formatAmount(cents: number): string {
  const yuan = cents / 100
  const text = Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
