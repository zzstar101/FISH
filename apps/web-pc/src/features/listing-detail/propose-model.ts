/**
 * 「我想要」（买家发起交易确认）的金额口径（#676）：**成交价 = 卖家设定的挂价，买家只读**。
 *
 * 改价权归卖家：确认弹层只展示挂价，没有金额输入框 —— 买家在下单流程里没有任何可改价的
 * 入口。服务端 `POST /transactions/proposals` 同步强制
 * `amountCents === listing.priceCents`（不等即 422 `PROPOSAL_AMOUNT_MISMATCH`），所以即使
 * 有人绕过端上展示直接发请求，也提不出别的金额。
 *
 * 免费送的商品金额恒 0：契约 §1 的 `free ⟹ priceCents === 0` 由 DB 约束
 * `listings_free_price_cents_zero` 保证，这里仍按 `free` 位收口，不依赖上游数据是否干净。
 *
 * 与小程序端 `apps/miniapp/src/features/transaction/propose-model.ts` 同一口径（#676 之后两端
 * 一致）。抽成纯函数与本端其余交互一致：本端**没有 jsdom**，判断类逻辑一律放纯函数里测。
 */

/** 提案金额（整数分）：挂价本身；免费送恒 0（与服务端校验同一条口径）。 */
export function proposalAmountCents(priceCents: number, free: boolean): number {
  return free ? 0 : priceCents
}
