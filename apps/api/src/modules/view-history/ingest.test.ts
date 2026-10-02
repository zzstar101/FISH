import { describe, expect, test } from 'bun:test'
import { viewRecordsFromEvents } from './ingest'

const user = '01930000-0000-7000-8000-0000000000a1'
const other = '01930000-0000-7000-8000-0000000000a2'
const listingA = '01930000-0000-7000-8000-0000000000b1'
const listingB = '01930000-0000-7000-8000-0000000000b2'

const at = (iso: string) => new Date(iso)

describe('viewRecordsFromEvents', () => {
  test('只认 DETAIL_VIEW，其余事件类型不进足迹', () => {
    const records = viewRecordsFromEvents([
      {
        userId: user,
        listingId: listingA,
        eventType: 'IMPRESSION',
        occurredAt: at('2026-10-01T00:00:00Z'),
      },
      {
        userId: user,
        listingId: listingA,
        eventType: 'LONG_VIEW',
        occurredAt: at('2026-10-01T00:01:00Z'),
      },
      {
        userId: user,
        listingId: listingA,
        eventType: 'FAVORITE',
        occurredAt: at('2026-10-01T00:02:00Z'),
      },
      {
        userId: user,
        listingId: listingA,
        eventType: 'DETAIL_VIEW',
        occurredAt: at('2026-10-01T00:03:00Z'),
      },
    ])

    expect(records).toEqual([
      { userId: user, listingId: listingA, viewedAt: at('2026-10-01T00:03:00Z') },
    ])
  })

  test('匿名（userId 为空）不写足迹', () => {
    expect(
      viewRecordsFromEvents([
        {
          userId: null,
          listingId: listingA,
          eventType: 'DETAIL_VIEW',
          occurredAt: at('2026-10-01T00:00:00Z'),
        },
      ]),
    ).toEqual([])
  })

  test('同 (用户, 商品) 只留一条，取最新时间（同一批里也不能出现两行）', () => {
    const records = viewRecordsFromEvents([
      {
        userId: user,
        listingId: listingA,
        eventType: 'DETAIL_VIEW',
        occurredAt: at('2026-10-01T02:00:00Z'),
      },
      {
        userId: user,
        listingId: listingA,
        eventType: 'DETAIL_VIEW',
        occurredAt: at('2026-10-01T01:00:00Z'),
      },
      {
        userId: user,
        listingId: listingB,
        eventType: 'DETAIL_VIEW',
        occurredAt: at('2026-10-01T01:30:00Z'),
      },
      {
        userId: other,
        listingId: listingA,
        eventType: 'DETAIL_VIEW',
        occurredAt: at('2026-10-01T01:45:00Z'),
      },
    ])

    expect(records).toHaveLength(3)
    expect(records).toContainEqual({
      userId: user,
      listingId: listingA,
      viewedAt: at('2026-10-01T02:00:00Z'),
    })
    // 不同用户看同一件商品是各自独立的两行。
    expect(records).toContainEqual({
      userId: other,
      listingId: listingA,
      viewedAt: at('2026-10-01T01:45:00Z'),
    })
  })
})
