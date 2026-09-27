/**
 * drizzle-kit 的 `migrations.prefix = 'timestamp'` 用 `new Date().toISOString()` 生成 tag 前缀
 * （`drizzle-kit/bin.cjs` 里的 `prepareMigrationMetadata`），而 `toISOString()` 永远按 UTC 渲染，
 * 无法用 `TZ` 环境变量影响。本仓要求迁移编号是 **UTC+8 墙钟时间**，因此在 drizzle-kit 启动前
 * 把 `Date.prototype.toISOString` 统一改成「按 UTC+8 渲染」：
 *
 * - 时间点本身不变，只是叠加 +8h 偏移后再输出 ISO 字符串，于是 tag 前缀 = 北京时间
 *   （例：北京时间 2026-09-28 06:30:00 → `20260928063000_<slug>`）；
 * - journal 的 `when` 取自 `+new Date()`（`bin.cjs`），不经过 `toISOString`，仍是真实 epoch 毫秒。
 *
 * 由 `packages/db/package.json` 的 `generate` 脚本用 `bun --preload` 注入（必须显式指向
 * `./node_modules/drizzle-kit/bin.cjs`：`bun --preload … drizzle-kit generate` 这种「按 bin 名启动」
 * 的形态不会应用 preload，产出的仍是 UTC 前缀），只作用于生成迁移这一条命令，不进入运行时（api / worker）。
 * `packages/db/src/migrations-journal.test.ts` 会断言「tag 前缀 == `when` 的 UTC+8 墙钟时间」，
 * 因此若 drizzle-kit 升级导致本文件失效，CI 会直接变红。
 */
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000
const originalToISOString = Date.prototype.toISOString

function toUtc8ISOString(this: Date): string {
  return originalToISOString.call(new Date(this.getTime() + UTC8_OFFSET_MS))
}

/** 幂等：重复调用（例如同时存在 preload 与显式调用）不会叠加偏移。 */
export function applyUtc8TimestampPrefix(): void {
  if (Date.prototype.toISOString === toUtc8ISOString) return
  Date.prototype.toISOString = toUtc8ISOString
}

applyUtc8TimestampPrefix()
