import { describe, expect, test } from 'bun:test'
import {
  RECOMMENDATION_MAX_POSITION,
  RecommendationEventInputSchema,
} from '@fish/contracts/recommendation/schema'
import {
  buildListingDetailUrl,
  readFeedAttribution,
} from '../src/features/recommendation/attribution'

/**
 * 详情页归因的读取（#323 R1 review 应修项 P2）。
 *
 * `position` 的上界不是「越界就丢了这条归因」这么简单：越界的 position 会被
 * `queue.ts` 发送前的 `isSendable`（`RecommendationEventInputSchema.safeParse`）判为不合格，
 * 于是这次浏览的 DETAIL_VIEW / LONG_VIEW **整条**被静默丢弃（不是 422，客户端日志里只有
 * 一条「丢弃不合格的埋点事件」）。正常路径不可达（下标 0..49），但手改或被分享的 `?pos=`
 * 链接能造出来 —— 所以越界只能退化成「没有归因」，不能留下脏 position。
 */

const REQUEST_ID = '3f1c8a4e-6b1d-4c2a-9e7f-0a5b8c3d2e1f'
const LISTING_ID = 'lst_01jc000000e00800000000001a'

/** 与 `track.ts` 里 DETAIL_VIEW 的字段构造一致（这里只关心归因那两个字段） */
function detailViewEvent(attribution: ReturnType<typeof readFeedAttribution>) {
  return {
    eventId: crypto.randomUUID(),
    listingId: LISTING_ID,
    eventType: 'DETAIL_VIEW' as const,
    requestId: attribution?.requestId ?? null,
    position: attribution?.position ?? null,
  }
}

describe('readFeedAttribution —— 位置序号范围', () => {
  test('合法归因原样读回，0 是合法序号（推荐流第一件）', () => {
    expect(readFeedAttribution({ rid: REQUEST_ID, pos: '0' })).toEqual({
      requestId: REQUEST_ID,
      position: 0,
    })
    expect(readFeedAttribution({ rid: REQUEST_ID, pos: '7' })).toEqual({
      requestId: REQUEST_ID,
      position: 7,
    })
  })

  test('上界本身仍然合法', () => {
    expect(
      readFeedAttribution({ rid: REQUEST_ID, pos: String(RECOMMENDATION_MAX_POSITION) }),
    ).toEqual({ requestId: REQUEST_ID, position: RECOMMENDATION_MAX_POSITION })
  })

  test('超过上界的 pos 退化为「没有归因」，而不是留下越界值', () => {
    // 修复前返回 { requestId, position: 10001 } —— 正是这个值让整条事件被 isSendable 丢掉
    expect(readFeedAttribution({ rid: REQUEST_ID, pos: '10001' })).toBeNull()
    expect(readFeedAttribution({ rid: REQUEST_ID, pos: '99999999999' })).toBeNull()
  })

  test('负数 / 非数字同样当没有归因', () => {
    expect(readFeedAttribution({ rid: REQUEST_ID, pos: '-1' })).toBeNull()
    expect(readFeedAttribution({ rid: REQUEST_ID, pos: 'abc' })).toBeNull()
  })

  test('缺 rid 或 pos 当没有归因（宁可没有归因，也不要脏归因）', () => {
    expect(readFeedAttribution({ pos: '3' })).toBeNull()
    expect(readFeedAttribution({ rid: REQUEST_ID })).toBeNull()
    expect(readFeedAttribution({ rid: '', pos: '3' })).toBeNull()
  })
})

describe('越界 pos 的后果（契约层面）', () => {
  test('退化后这次浏览的 DETAIL_VIEW 仍能通过契约校验 —— 事件照发', () => {
    const attribution = readFeedAttribution({ rid: REQUEST_ID, pos: '10001' })
    const parsed = RecommendationEventInputSchema.safeParse(detailViewEvent(attribution))

    expect(parsed.success).toBe(true)
  })

  test('反之，留下越界 position 会让整条事件不合格 —— 这就是要退化的原因', () => {
    const attribution = readFeedAttribution({ rid: REQUEST_ID, pos: '10001' })
    const withDirtyPosition = { ...detailViewEvent(attribution), position: 10_001 }

    expect(RecommendationEventInputSchema.safeParse(withDirtyPosition).success).toBe(false)
  })
})

describe('buildListingDetailUrl', () => {
  test('没有归因只带 id', () => {
    expect(buildListingDetailUrl(LISTING_ID, null)).toBe(
      `/pkg-browse/pages/listing-detail/index?id=${LISTING_ID}`,
    )
  })

  test('带归因时 position 0 也要带上（真值判断会把它丢掉）', () => {
    expect(buildListingDetailUrl(LISTING_ID, { requestId: REQUEST_ID, position: 0 })).toBe(
      `/pkg-browse/pages/listing-detail/index?id=${LISTING_ID}&rid=${REQUEST_ID}&pos=0`,
    )
  })
})
