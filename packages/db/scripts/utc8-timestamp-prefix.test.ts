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

test('#316 重复应用不叠加偏移（幂等守卫按标记判定，还原后重新应用仍只 +8h）', () => {
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

test('#316 幂等守卫按标记判定：补丁函数带 utc8Patched 标记（跨模块实例也不会叠成 +16h）', () => {
  applyUtc8TimestampPrefix()
  const patched = Date.prototype.toISOString as (() => string) & { utc8Patched?: true }
  expect(patched.utc8Patched).toBe(true)
})

type PrefixModule = {
  applyUtc8TimestampPrefix: () => void
  restoreNativeToISOString: () => void
}

/** 带 query 的 specifier 会解析成**第二份模块记录**（无 query 的写法与 `.ts` 去重为同一实例）。 */
async function loadSecondInstance(query: string): Promise<PrefixModule> {
  return (await import(`./utc8-timestamp-prefix?${query}`)) as PrefixModule
}

test('#316 第二个模块实例再次 apply 仍只 +8h：补丁不会套在补丁上', async () => {
  const epochMs = Date.UTC(2026, 8, 27, 22, 30, 0)
  const second = await loadSecondInstance('second-instance')
  second.applyUtc8TimestampPrefix()
  // 这条覆盖「重复 apply 不叠加」：标记守卫会让第二次 apply 直接返回。
  // 能证伪 fdd0848 旧写法（模块求值捕获 + 按函数引用判幂等）的是下一条 —— 先 restore 清掉标记、
  // 再由第二实例 apply，stale-native 才会在那里叠成 +16h。
  expect(new Date(epochMs).toISOString()).toBe('2026-09-28T06:30:00.000Z')
})

test('#316 任一实例的 restore 都回到真·原生实现：还原后再由另一实例 apply 仍只 +8h', async () => {
  const epochMs = Date.UTC(2026, 8, 27, 22, 30, 0)
  const second = await loadSecondInstance('third-instance')
  restoreNativeToISOString()
  expect(new Date(epochMs).toISOString()).toBe('2026-09-27T22:30:00.000Z')
  second.applyUtc8TimestampPrefix()
  expect(new Date(epochMs).toISOString()).toBe('2026-09-28T06:30:00.000Z')
  // 第二个实例导出的「原生实现」必须是真·原生函数，否则它的 restore 会还原不回去。
  second.restoreNativeToISOString()
  expect(new Date(epochMs).toISOString()).toBe('2026-09-27T22:30:00.000Z')
})

test('#316 时间点本身不变：`+new Date()` / `getTime()` 仍是真实 epoch 毫秒', () => {
  // 补丁只换渲染、不换时间值：journal 的 `when` 取自 `+new Date()`，被改写会让 drizzle 误判"已应用"而静默跳过迁移。
  // 断言用字面量 `when`（不是 apply 前后自比较），并在「原生实现」与「补丁生效」两种状态下都成立。
  const when = 1790546582603
  restoreNativeToISOString()
  expect(+new Date(when)).toBe(when)
  applyUtc8TimestampPrefix()
  expect(+new Date(when)).toBe(when)
  expect(new Date(when).getTime()).toBe(when)
})

test('#316 偏移量就是 8 小时：补丁渲染与原生渲染相差正好 8h', () => {
  const epochMs = Date.UTC(2026, 0, 1, 0, 0, 0)
  restoreNativeToISOString()
  const native = new Date(epochMs).toISOString()
  applyUtc8TimestampPrefix()
  const patched = new Date(epochMs).toISOString()
  // 可证伪：+16h、偏移 0、或换成了别的时区，都会在这里红。
  expect(Date.parse(patched) - Date.parse(native)).toBe(UTC8_OFFSET_MS)
  expect(native).toBe('2026-01-01T00:00:00.000Z')
  expect(patched).toBe('2026-01-01T08:00:00.000Z')
})
