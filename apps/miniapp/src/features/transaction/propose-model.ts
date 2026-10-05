/**
 * 「立即购买」确认弹层的纯逻辑：金额输入 ↔ 整数分。
 *
 * 口径与 PC 站 `apps/web-pc/src/features/listing-detail/propose-model.ts` 对齐（本 PR 的
 * 对齐对象）：金额输入框默认带挂价、买家可改成与卖家商定的成交价、免费送锁 0。
 * 抽成纯函数与本仓库其余交互一致 —— 判断类逻辑不写在组件里，`bun test` 直接加载本模块。
 *
 * 金额解析与发布 / 编辑商品共用 `parsePriceToCents`（同一条 `PRICE_PATTERN` 边界），
 * 不在这里另写一份正则，避免两处对「最多两位小数」的理解漂移。
 */
import { parsePriceToCents } from '@/pages/sell/form'

/** 金额输入框初值：免费送恒 `'0'`；其余按挂价，两位小数（PC 同款写法）。 */
export function initialAmountValue(priceCents: number, free: boolean): string {
  if (free) return '0'
  return (priceCents / 100).toFixed(2)
}

/**
 * 输入框内容 → 提案金额（整数分）。非法返回 `null`。
 *
 * 免费送的商品金额恒为 0（`parsePriceToCents` 同口径）：挂价 0 时买家没有可议的价，
 * 让输入框里的数字决定金额会让「0 元送」被提成任意数。
 *
 * 上限与 PC 同一条：契约 `PriceCentsSchema` 的 ¥100,000（10_000_000 分），超限同样按
 * 非法处理。miniapp 的发布页解析器没有这条本地校验（超限靠服务端 422）—— 本弹层在
 * 自己这一步收口、不动发布页，全端统一另案。
 */
export function proposalAmountCents(amount: string, free: boolean): number | null {
  const cents = parsePriceToCents(amount, free)
  if (cents === null) return null
  return cents > 10_000_000 ? null : cents
}

/** 金额字段的错误文案；合法返回 `null`。 */
export function proposalAmountError(amount: string, free: boolean): string | null {
  if (free) return null
  return proposalAmountCents(amount, free) === null ? '请填写正确金额（最多两位小数）' : null
}
