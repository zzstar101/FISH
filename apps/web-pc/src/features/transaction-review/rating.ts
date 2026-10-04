import type { TransactionReviewRating } from '@fish/contracts/transaction-reviews/schema'

/**
 * 三档评分的展示映射（#195 冻结口径：好评 / 中评 / 差评，不是 1..5 星）。
 *
 * 原先只住在「我的评论」页；订单详情的「交易评价」卡出现后有了第二个消费方，
 * 才上移成 transaction-review 域的小模块 —— 两处必须同词同色，不许各写一份。
 */
export const RATING_VIEW: Record<
  TransactionReviewRating,
  { label: string; variant: 'secondary' | 'warn' | 'success' }
> = {
  POSITIVE: { label: '好评', variant: 'success' },
  NEUTRAL: { label: '中评', variant: 'secondary' },
  NEGATIVE: { label: '差评', variant: 'warn' },
}

/** 评分选项的展示顺序（好 → 中 → 差）。 */
export const RATING_OPTIONS = [
  'POSITIVE',
  'NEUTRAL',
  'NEGATIVE',
] as const satisfies readonly TransactionReviewRating[]
