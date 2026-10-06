import { describe, expect, test } from 'bun:test'
import { coolingOffLabel, coolingOffRemainingDays } from './countdown'

const REQUESTED_AT = '2026-10-01T00:00:00.000Z'
const PURGE_AT = '2026-10-08T00:00:00.000Z'

describe('coolingOffRemainingDays', () => {
  test('由 purgeScheduledAt 反算，向上取整', () => {
    const start = Date.parse(REQUESTED_AT)
    expect(coolingOffRemainingDays(PURGE_AT, start)).toBe(7)
    // 过了半天：还剩 6.5 天 → 显示 7 天，不能显示「0 天」把人吓一跳。
    expect(coolingOffRemainingDays(PURGE_AT, start + 12 * 60 * 60 * 1000)).toBe(7)
    expect(coolingOffRemainingDays(PURGE_AT, Date.parse('2026-10-07T23:00:00.000Z'))).toBe(1)
  })

  test('已到期与非法时间戳都落在 0，不会出现负数文案', () => {
    expect(coolingOffRemainingDays(PURGE_AT, Date.parse('2026-10-09T00:00:00.000Z'))).toBe(0)
    expect(coolingOffRemainingDays('not-a-date', Date.now())).toBe(0)
  })
})

describe('coolingOffLabel', () => {
  test('两端共用同一句文案：到期前报剩余天数，到期后报不可恢复', () => {
    expect(coolingOffLabel(PURGE_AT, Date.parse(REQUESTED_AT))).toBe('冷静期剩余 7 天')
    expect(coolingOffLabel(PURGE_AT, Date.parse('2026-10-09T00:00:00.000Z'))).toBe(
      '冷静期已到期，账号即将被注销',
    )
  })

  test('读不到到期时间时说「冷静期内」，不谎报「已到期」', () => {
    // 状态确实是 DELETION_REQUESTED，只是这一屏拿不到时间戳。两种情况必须同句：
    // 此前 PC 说「冷静期内」、小程序说「账号即将被注销」，同一份数据两种口径。
    expect(coolingOffLabel(null, Date.now())).toBe('冷静期内')
    expect(coolingOffLabel('not-a-date', Date.now())).toBe('冷静期内')
  })
})
