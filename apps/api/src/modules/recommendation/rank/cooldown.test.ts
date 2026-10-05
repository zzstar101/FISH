import { describe, expect, test } from 'bun:test'
import {
  RANK_REPEATED_EXPOSURE_COOLDOWN_MS,
  RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD,
} from '@fish/contracts/recommendation/rank'
import { cooldownListingIds, type ExposureHistoryEntry } from './cooldown'

/**
 * 冷却判据单测（#323 M6）。
 *
 * 判据的每个输入都是边界敏感的量（阈值、24 小时、有没有互动过），所以这里逐条穷举**单条件不满足**
 * 的情形，而不是只测"命中/不命中"两种：冷却多做一轮是少推一件商品，漏做一轮就是用户又看到那件
 * 他反复没点的东西 —— 两个方向的错误都要能被这些用例挡住。
 */

const NOW = new Date('2026-10-02T12:00:00.000Z')

function history(
  entries: Record<string, Partial<ExposureHistoryEntry>>,
): Map<string, ExposureHistoryEntry> {
  return new Map(
    Object.entries(entries).map(([listingId, entry]) => [
      listingId,
      {
        exposureCount: RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD,
        lastExposedAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
        engagedCount: 0,
        ...entry,
      },
    ]),
  )
}

describe('cooldownListingIds', () => {
  test('没有历史 → 空集合', () => {
    expect(cooldownListingIds({ history: new Map(), now: NOW })).toEqual(new Set())
  })

  test('未达曝光阈值（阈值 - 1 次）→ 不进冷却', () => {
    expect(
      cooldownListingIds({
        history: history({ a: { exposureCount: RANK_REPEATED_EXPOSURE_COOLDOWN_THRESHOLD - 1 } }),
        now: NOW,
      }),
    ).toEqual(new Set())
  })

  test('刚好达到阈值、且没互动、且没过 24 小时 → 进冷却', () => {
    expect(cooldownListingIds({ history: history({ a: {} }), now: NOW })).toEqual(new Set(['a']))
  })

  test('窗口内有过互动（engagedCount > 0）→ 不进冷却', () => {
    expect(cooldownListingIds({ history: history({ a: { engagedCount: 1 } }), now: NOW })).toEqual(
      new Set(),
    )
  })

  test('恰好 24 小时 → 冷却已结束（边界放行）', () => {
    expect(
      cooldownListingIds({
        history: history({
          a: { lastExposedAt: new Date(NOW.getTime() - RANK_REPEATED_EXPOSURE_COOLDOWN_MS) },
        }),
        now: NOW,
      }),
    ).toEqual(new Set())
  })

  test('超过 24 小时 → 冷却已结束', () => {
    expect(
      cooldownListingIds({
        history: history({
          a: { lastExposedAt: new Date(NOW.getTime() - RANK_REPEATED_EXPOSURE_COOLDOWN_MS - 1) },
        }),
        now: NOW,
      }),
    ).toEqual(new Set())
  })

  test('`lastExposedAt` 为 null → 不进冷却（曝光次数>0 却没有时间，属于数据缺失，不惩罚）', () => {
    expect(
      cooldownListingIds({ history: history({ a: { lastExposedAt: null } }), now: NOW }),
    ).toEqual(new Set())
  })

  test('最后一次曝光在未来（时钟偏移）→ 按刚曝光处理，留在冷却里', () => {
    expect(
      cooldownListingIds({
        history: history({ a: { lastExposedAt: new Date(NOW.getTime() + 60 * 1_000) } }),
        now: NOW,
      }),
    ).toEqual(new Set(['a']))
  })

  test('混合历史 → 只返回同时满足全部条件的商品', () => {
    const result = cooldownListingIds({
      history: history({
        cooling: {},
        engaged: { engagedCount: 2 },
        belowThreshold: { exposureCount: 2 },
        expired: {
          lastExposedAt: new Date(NOW.getTime() - RANK_REPEATED_EXPOSURE_COOLDOWN_MS - 1),
        },
        noExposure: { exposureCount: 0, lastExposedAt: null },
        alsoCooling: { exposureCount: 5 },
      }),
      now: NOW,
    })

    expect([...result].sort()).toEqual(['alsoCooling', 'cooling'])
  })
})
