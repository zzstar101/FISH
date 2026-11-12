/**
 * 「立即购买」确认弹层的金额口径（#676）：**成交价 = 卖家设定的挂价，买家只读**。
 *
 * 改价权归卖家：弹层只展示挂价，没有金额输入框 —— 用户在下单/购买流程里没有任何
 * 可改价的入口。服务端 `POST /transactions/proposals` 同步强制
 * `amountCents === listing.priceCents`（不等即 422 `PROPOSAL_AMOUNT_MISMATCH`），
 * 所以即使有人绕过端上展示直接发请求，也提不出别的金额。
 *
 * 免费送的商品金额恒 0：契约 §1 的 `free ⟹ priceCents === 0` 由 DB 约束
 * `listings_free_price_cents_zero` 保证，这里仍按 `free` 位收口，不依赖上游数据是否干净。
 *
 * PC 站同一口径：`apps/web-pc/src/features/listing-detail/propose-model.ts` 也只有
 * `proposalAmountCents(priceCents, free)`，弹层金额同样只读（两端在 #676 之后一致）。
 *
 * 抽成纯函数与本仓库其余交互一致 —— 判断类逻辑不写在组件里，`bun test` 直接加载本模块。
 */

/** 提案金额（整数分）：挂价本身；免费送恒 0（与服务端校验同一条口径）。 */
export function proposalAmountCents(priceCents: number, free: boolean): number {
  return free ? 0 : priceCents
}

/** 只读金额的展示文案：两位小数（免费送恒 `0.00`）。 */
export function proposalAmountText(priceCents: number, free: boolean): string {
  return (proposalAmountCents(priceCents, free) / 100).toFixed(2)
}
