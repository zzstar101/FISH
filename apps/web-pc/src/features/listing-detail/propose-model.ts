/**
 * 「我想要」（买家发起交易确认）的纯逻辑：金额输入 ↔ 整数分。
 *
 * 抽出来的原因与 web-pc 其余交互一致：本端**没有 jsdom**，组件只做
 * `renderToStaticMarkup` 静态渲染，判断类逻辑一律放纯函数里测。
 *
 * 金额口径与发布 / 编辑商品共用 `parsePriceToCents`（同一条 `PriceCentsSchema` 边界），
 * 不在这里另写一份正则，避免两处对「¥100,000 上限」的理解漂移。
 */
import { parsePriceToCents } from '../publish/form-model'

/** 金额输入框初值：免费送恒 `0`；其余按挂价，两位小数（与编辑弹窗同一写法）。 */
export function initialAmountValue(priceCents: number, free: boolean): string {
  if (free) return '0'
  return (priceCents / 100).toFixed(2)
}

/**
 * 输入框内容 → 提案金额（整数分）。非法返回 `null`。
 *
 * 免费送的商品金额恒为 0（`parsePriceToCents` 同口径）：挂价 0 时买家没有可议的价，
 * 让输入框里的数字决定金额会让「0 元送」被提成任意数。
 */
export function proposalAmountCents(amount: string, free: boolean): number | null {
  return parsePriceToCents(amount, free)
}

/** 金额字段的错误文案；合法返回 `null`。 */
export function proposalAmountError(amount: string, free: boolean): string | null {
  if (free) return null
  return proposalAmountCents(amount, free) === null ? '请填写正确金额（最多两位小数）' : null
}
