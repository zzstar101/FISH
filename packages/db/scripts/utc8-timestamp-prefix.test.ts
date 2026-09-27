import { expect, test } from 'bun:test'
import { applyUtc8TimestampPrefix } from './utc8-timestamp-prefix'

/**
 * `scripts/utc8-timestamp-prefix.ts` 是 `bun --preload` 注入的生成侧兜底：它把
 * `Date.prototype.toISOString` 改成「按 UTC+8 渲染」，于是 drizzle-kit 写出的迁移 tag 前缀
 * 是北京时间而不是 UTC。这里断言三件事，任何一件坏了都说明 `generate` 产出的编号不再是 UTC+8：
 *
 * 1. 打补丁后的 `toISOString()` 就是 +8h 墙钟；
 * 2. 重复调用不会叠加偏移（preload 与显式调用同时发生时不能变成 +16h）；
 * 3. 时间点本身没被改（journal 的 `when` 取自 `+new Date()`，必须仍是真实 epoch 毫秒）。
 */

const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000

test('#316 toISOString 按 UTC+8 渲染：北京时间 2026-09-28 06:30:00 → 06:30:00Z', () => {
  applyUtc8TimestampPrefix()
  const epochMs = Date.UTC(2026, 8, 27, 22, 30, 0)
  expect(new Date(epochMs).toISOString()).toBe('2026-09-28T06:30:00.000Z')
  // 生成器的取法：先去掉所有非数字字符，再取前 14 位 → 正好是 UTC+8 墙钟时间。
  expect(new Date(epochMs).toISOString().replace(/\D/g, '').slice(0, 14)).toBe('20260928063000')
})

test('#316 重复应用不叠加偏移', () => {
  applyUtc8TimestampPrefix()
  applyUtc8TimestampPrefix()
  const epochMs = Date.UTC(2026, 8, 27, 22, 30, 0)
  expect(new Date(epochMs).toISOString()).toBe('2026-09-28T06:30:00.000Z')
})

test('#316 时间点本身不变：+new Date() 仍是真实 epoch 毫秒', () => {
  applyUtc8TimestampPrefix()
  const when = 1790546582603
  expect(+new Date(when)).toBe(when)
  expect(new Date(when).getTime()).toBe(when)
})

test('#316 UTC+8 偏移量就是 8 小时', () => {
  applyUtc8TimestampPrefix()
  const epochMs = Date.UTC(2026, 0, 1, 0, 0, 0)
  expect(new Date(epochMs).getTime() + UTC8_OFFSET_MS).toBe(Date.parse('2026-01-01T08:00:00.000Z'))
  expect(new Date(epochMs).toISOString()).toBe('2026-01-01T08:00:00.000Z')
})
