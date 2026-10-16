import { describe, expect, test } from 'bun:test'
import {
  ratingViewOf,
  splitReviews,
} from '../src/pkg-trade/pages/transaction-meetup/review-block-view'

/**
 * 面交页「交易评价」块的纯视图映射。最容易漏的错是**角色归属**：把对方的评价
 * 画成「我的」（或反过来）在代码里看不出来 —— 这里按 `authorRole` 与查看者角色
 * 两个方向都钉住。
 */

type Row = {
  review: {
    rating: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'
    body: string | null
    images: readonly { url: string }[]
  }
  authorRole: 'buyer' | 'seller'
}

const row = (authorRole: Row['authorRole'], over: Partial<Row['review']> = {}): Row => ({
  review: { rating: 'POSITIVE', body: null, images: [], ...over },
  authorRole,
})

describe('交易评价块 · 两方拆分（splitReviews）', () => {
  test('双方都评了：authorRole === myRole 的是「我的」，另一行是「对方的」', () => {
    const items = [row('buyer', { body: '卖家很爽快' }), row('seller', { body: '买家准时到场' })]
    // 买家视角：buyer 行是我的
    const asBuyer = splitReviews(items, 'buyer')
    expect(asBuyer.mine?.body).toBe('卖家很爽快')
    expect(asBuyer.theirs?.body).toBe('买家准时到场')
    // 卖家视角：同一份数据，归属对调
    const asSeller = splitReviews(items, 'seller')
    expect(asSeller.mine?.body).toBe('买家准时到场')
    expect(asSeller.theirs?.body).toBe('卖家很爽快')
  })

  test('只评了一半：没评的一侧是 null（我的 null → 页面给「写评价」入口）', () => {
    const items = [row('seller', { body: '买家准时到场' })]
    const asBuyer = splitReviews(items, 'buyer')
    expect(asBuyer.mine).toBeNull()
    expect(asBuyer.theirs?.body).toBe('买家准时到场')
    expect(splitReviews([], 'buyer')).toEqual({ mine: null, theirs: null })
  })

  test('body 为 null（只打分没写字）折成空串；配图 URL 原样透传', () => {
    const items = [
      row('buyer', {
        body: null,
        images: [{ url: 'https://api.example.com/api/uploads/media/t1' }],
      }),
    ]
    const { mine } = splitReviews(items, 'buyer')
    expect(mine?.body).toBe('')
    expect(mine?.images).toEqual(['https://api.example.com/api/uploads/media/t1'])
  })

  test('防御性：同一侧多行（不该出现）只取第一行，不画成两块', () => {
    const items = [row('buyer', { body: '第一行' }), row('buyer', { body: '不该出现的第二行' })]
    const asBuyer = splitReviews(items, 'buyer')
    expect(asBuyer.mine?.body).toBe('第一行')
    expect(asBuyer.theirs).toBeNull()
  })
})

describe('交易评价块 · 三档胶囊', () => {
  test('三档各自的文案与色调类（红绿灯语义，字面量钉住）', () => {
    expect(ratingViewOf('POSITIVE')).toEqual({ label: '好评', cls: 'is-pos' })
    expect(ratingViewOf('NEUTRAL')).toEqual({ label: '中评', cls: 'is-mid' })
    expect(ratingViewOf('NEGATIVE')).toEqual({ label: '差评', cls: 'is-neg' })
  })
})
