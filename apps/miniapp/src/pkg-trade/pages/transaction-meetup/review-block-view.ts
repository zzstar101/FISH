/**
 * 面交页「交易评价」块的**纯视图映射**（#195 PR2 的 `GET /transactions/:id/reviews`）。
 *
 * 抽出来的原因与同目录 `view.ts` 同款：本页没有渲染测试基建，角色归属判错了
 * （把对方的评价画成「我的」）在代码里看不出来，只有用例能钉住。
 * 组件在 `review-block.tsx`，那边才碰 Taro。
 */
import type { TransactionReviewRating } from '@fish/contracts/transaction-reviews/schema'
import type { TransactionRole } from '@fish/contracts/transactions/schema'

/** 一侧评价的展示行（读模型已按序拼好签名 URL，端上直接渲染） */
export type ReviewRowView = {
  rating: TransactionReviewRating
  /** `body` 可空 = 「只打分没写字」；折成空串，页面整行不渲染文本 */
  body: string
  images: string[]
}

export type SplitReviews = {
  /** 我的评价；还没评过为 `null`（页面据此给「写评价」入口） */
  mine: ReviewRowView | null
  /** 对方的评价；还没评过为 `null`（页面显示「对方还没评价」） */
  theirs: ReviewRowView | null
}

/**
 * 按 `authorRole` 与查看者角色把至多两行拆成「我 / 对方」两侧。
 *
 * 契约保证至多两行、各角色最多一条；防御性取该侧的第一行，多出来的行（不该存在）
 * 不渲染 —— 宁可少显示也不把同一侧画成两块。
 */
export function splitReviews(
  items: readonly {
    review: {
      rating: TransactionReviewRating
      body: string | null
      images: readonly { url: string }[]
    }
    authorRole: TransactionRole
  }[],
  myRole: TransactionRole,
): SplitReviews {
  let mine: ReviewRowView | null = null
  let theirs: ReviewRowView | null = null
  for (const item of items) {
    const row: ReviewRowView = {
      rating: item.review.rating,
      body: item.review.body ?? '',
      images: item.review.images.map((image) => image.url),
    }
    if (item.authorRole === myRole) {
      if (mine === null) mine = row
    } else if (theirs === null) {
      theirs = row
    }
  }
  return { mine, theirs }
}

/** 三档评分的展示胶囊（红绿灯三色，与订单卡 / 我的评论页同一套语义） */
export function ratingViewOf(rating: TransactionReviewRating): { label: string; cls: string } {
  switch (rating) {
    case 'POSITIVE':
      return { label: '好评', cls: 'is-pos' }
    case 'NEUTRAL':
      return { label: '中评', cls: 'is-mid' }
    case 'NEGATIVE':
      return { label: '差评', cls: 'is-neg' }
  }
}
