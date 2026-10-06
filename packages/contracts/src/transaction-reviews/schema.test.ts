import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  TransactionReviewBodySchema,
  TransactionReviewCreateInputSchema,
  TransactionReviewErrorCodeSchema,
  TransactionReviewRatingSchema,
  TransactionReviewSchema,
  TransactionReviewsResponseSchema,
} from './schema'

/**
 * 交易评价契约（#195 PR2）：Owner 冻结口径在 HTTP 边界的值域收口。
 *
 * 契约错误码用 `.extract()` 派生（与 favorites / comments 同手法）——信封里的 `code`
 * 一旦漂出本域枚举，这里当场断言红，而不是上线后客户端拿到未知错误码。
 */
const VALIDATED_CODES = TransactionReviewErrorCodeSchema.extract([
  'TRANSACTION_NOT_FOUND',
  'REVIEW_NOT_FOUND',
  'TRANSACTION_NOT_COMPLETED',
  'TRANSACTION_REVIEW_EXISTS',
  'REVIEW_CONTENT_BLOCKED',
] as const)

const uuid = (n: number) => `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const TXN_ID = encodePublicId(PUBLIC_ID_PREFIX.transaction, uuid(0xa1))
const REVIEW_ID = encodePublicId(PUBLIC_ID_PREFIX.review, uuid(0xb1))

const validReview = {
  id: REVIEW_ID,
  transactionId: TXN_ID,
  rating: 'NEUTRAL',
  body: null,
  images: [],
  createdAt: '2026-10-01T12:00:00.000Z',
}

describe('评价三档（#195 冻结：好评/中评/差评，不是 1..5 星）', () => {
  test('值集与 DB 枚举同源，非法档被拒', () => {
    expect(TransactionReviewRatingSchema.options).toEqual(['POSITIVE', 'NEUTRAL', 'NEGATIVE'])
    expect(TransactionReviewRatingSchema.safeParse('EXCELLENT').success).toBe(false)
  })
})

describe('评语（trim、上限 200；可空性由创建输入的 optional 承载）', () => {
  test('全空白 trim 后成空串（服务层归一为 null 落库）', () => {
    expect(TransactionReviewBodySchema.safeParse('   ').success).toBe(true)
    expect(TransactionReviewBodySchema.safeParse('   ').data).toBe('')
  })

  test('超过 200 字被拒（长度上限由契约收口，DB 是裸 text）', () => {
    expect(TransactionReviewBodySchema.safeParse('好'.repeat(200)).success).toBe(true)
    expect(TransactionReviewBodySchema.safeParse('好'.repeat(201)).success).toBe(false)
  })
})

describe('创建输入（strictObject：多余字段直接 422）', () => {
  test('rating 必填；body 可选（缺省 = 没写评语）；未知字段被拒', () => {
    expect(TransactionReviewCreateInputSchema.safeParse({ rating: 'POSITIVE' }).success).toBe(true)
    expect(
      TransactionReviewCreateInputSchema.safeParse({ rating: 'POSITIVE', body: '  ' }).success,
    ).toBe(true)
    expect(TransactionReviewCreateInputSchema.safeParse({}).success).toBe(false)
    // #475 起 imageObjectKeys 是合法字段（不再是「未知字段」）——这里改用真正的未知字段。
    expect(
      TransactionReviewCreateInputSchema.safeParse({ rating: 'POSITIVE', images: ['x'] }).success,
    ).toBe(false)
  })

  test('#475 配图键数组：缺省/空数组合法；上限 3；重复键被 refine 拒', () => {
    const parse = (imageObjectKeys: unknown) =>
      TransactionReviewCreateInputSchema.safeParse({ rating: 'POSITIVE', imageObjectKeys }).success
    expect(parse(undefined)).toBe(true)
    expect(parse([])).toBe(true)
    expect(parse(['reviews/usr_a/med_b.png'])).toBe(true)
    expect(parse(['a', 'b', 'c'])).toBe(true)
    expect(parse(['a', 'b', 'c', 'd'])).toBe(false)
    expect(parse(['reviews/usr_a/med_b.png', 'reviews/usr_a/med_b.png'])).toBe(false)
    expect(parse('not-an-array')).toBe(false)
  })
})

describe('DTO 读模型', () => {
  test('评语可空、配图是拼好的 URL 列表；id 必须是 rvw_ 前缀', () => {
    expect(TransactionReviewSchema.safeParse(validReview).success).toBe(true)
    expect(
      TransactionReviewSchema.safeParse({
        ...validReview,
        images: [{ url: 'https://cdn.example/transaction-review-media/x.jpg' }],
        body: '很好',
      }).success,
    ).toBe(true)
    expect(
      TransactionReviewSchema.safeParse({
        ...validReview,
        id: encodePublicId(PUBLIC_ID_PREFIX.comment, uuid(0xb1)),
      }).success,
    ).toBe(false)
  })

  test('两方评价列表各行带 authorRole（值集 = buyer|seller）', () => {
    expect(
      TransactionReviewsResponseSchema.safeParse({
        items: [
          { review: validReview, authorRole: 'buyer' },
          {
            review: { ...validReview, id: encodePublicId(PUBLIC_ID_PREFIX.review, uuid(0xb2)) },
            authorRole: 'seller',
          },
        ],
      }).success,
    ).toBe(true)
    expect(
      TransactionReviewsResponseSchema.safeParse({
        items: [{ review: validReview, authorRole: 'admin' }],
      }).success,
    ).toBe(false)
  })
})

describe('错误码值域', () => {
  test('五个错误码被契约枚举收口', () => {
    expect(VALIDATED_CODES.options).toEqual([
      'TRANSACTION_NOT_FOUND',
      'REVIEW_NOT_FOUND',
      'TRANSACTION_NOT_COMPLETED',
      'TRANSACTION_REVIEW_EXISTS',
      'REVIEW_CONTENT_BLOCKED',
    ])
  })
})
