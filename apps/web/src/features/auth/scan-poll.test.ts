import { describe, expect, test } from 'bun:test'
import { nextScanPollDelayMs } from './scan-poll'

describe('扫码状态轮询退避', () => {
  test('1s 起，2s 后到 3s，封顶后不再增长', () => {
    expect([0, 1, 2, 3, 10].map(nextScanPollDelayMs)).toEqual([1_000, 2_000, 3_000, 3_000, 3_000])
  })

  test('非法 attempt 直接报错，不产生 NaN 定时器', () => {
    expect(() => nextScanPollDelayMs(-1)).toThrow('非负整数')
    expect(() => nextScanPollDelayMs(0.5)).toThrow('非负整数')
  })
})
