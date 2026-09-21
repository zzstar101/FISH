/**
 * 「从我的发布进编辑」的一次性交接位。
 *
 * 为什么需要它：**出物页是 Tab 页**，而小程序禁止 `navigateTo` / `redirectTo` 到 tabBar 页，
 * `switchTab` 又不接受 query（`docs` 与实测都如此）。所以编辑目标不能走 URL，
 * 只能走一次性的模块级交接：
 *
 * ```
 * 我的发布页：requestSellEdit(id) → Taro.switchTab('/pages/sell/index')
 * 出物页：    useDidShow 里 takeSellEdit() → 取到就进编辑态
 * ```
 *
 * **取一次就失效**（`takeSellEdit` 立即清空）是刻意的：否则用户之后再从底栏点「出物」
 * 会莫名其妙又进上一次的编辑态，把「新建」和「改某一件」搅在一起。
 * 出物页对「这次是新建但没有待取目标」的处理见 `pages/sell/index.tsx` 的 `syncEditTarget`。
 */
let pending: string | null = null

/** 我的发布页调用：请求出物页进入这条商品的编辑态 */
export function requestSellEdit(id: string): void {
  pending = id
}

/** 出物页调用：取走并清空待编辑目标；没有则返回 `null` */
export function takeSellEdit(): string | null {
  const id = pending
  pending = null
  return id
}
