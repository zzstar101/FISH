import { describe, expect, test } from 'bun:test'
import { isScanTicketExpired, nextScanPollDelayMs } from './scan-poll'

describe('扫码状态轮询退避', () => {
  test('1s 起，2s 后到 3s，封顶后不再增长', () => {
    expect([0, 1, 2, 3, 10].map(nextScanPollDelayMs)).toEqual([1_000, 2_000, 3_000, 3_000, 3_000])
  })

  test('非法 attempt 直接报错，不产生 NaN 定时器', () => {
    expect(() => nextScanPollDelayMs(-1)).toThrow('非负整数')
    expect(() => nextScanPollDelayMs(0.5)).toThrow('非负整数')
  })

  test('到达 expiresAt 即判过期；非法时间 fail closed', () => {
    expect(
      isScanTicketExpired('2026-09-25T16:00:00.000Z', Date.parse('2026-09-25T15:59:59.999Z')),
    ).toBe(false)
    expect(
      isScanTicketExpired('2026-09-25T16:00:00.000Z', Date.parse('2026-09-25T16:00:00.000Z')),
    ).toBe(true)
    expect(isScanTicketExpired('not-a-date', 0)).toBe(true)
  })
})
