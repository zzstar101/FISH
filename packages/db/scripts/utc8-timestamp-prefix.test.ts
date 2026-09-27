import { afterAll, expect, test } from 'bun:test'
import { applyUtc8TimestampPrefix, restoreNativeToISOString } from './utc8-timestamp-prefix'

// import 本模块就已经全局改写了 `Date.prototype.toISOString`：收尾必须还原，否则同一进程里
// 后跑的文件（`src/migrations-journal.test.ts` 的 `formatUtc8Prefix`）会拿到 +16h 的期望值。
afterAll(restoreNativeToISOString)

/**
 * `scripts/utc8-timestamp-prefix.ts` 是 `bun --preload` 注入的生成侧兜底：它把
 * `Date.prototype.toISOString` 改成「按 UTC+8 渲染」，于是 drizzle-kit 写出的迁移 tag 前缀
 * 是北京时间而不是 UTC。这里断言三件事，任何一件坏了都说明 `generate` 产出的编号不再是 UTC+8：
 *
 * 1. 打补丁后的 `toISOString()` 就是 +8h 墙钟；
 * 2. 重复调用不会叠加偏移（preload 与显式调用同时发生时不能变成 +16h），且还原后重新应用仍只 +8h；
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

test('#316 重复应用不叠加偏移（幂等守卫按函数引用判定，还原后重新应用仍只 +8h）', () => {
  const epochMs = Date.UTC(2026, 8, 27, 22, 30, 0)
  applyUtc8TimestampPrefix()
  const once = new Date(epochMs).toISOString()
  applyUtc8TimestampPrefix()
  expect(new Date(epochMs).toISOString()).toBe(once)
  // 先还原原生实现再应用：若幂等守卫失效（每次调用都再包一层），这里会变成 +16h。
  restoreNativeToISOString()
  expect(new Date(epochMs).toISOString()).toBe('2026-09-27T22:30:00.000Z')
  applyUtc8TimestampPrefix()
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
