import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema',
  out: './src/migrations',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  // 迁移 tag 前缀 = 生成时刻的 **UTC+8 墙钟时间**（例：北京时间 2026-09-28 06:30:00 → `20260928063000_<slug>`），
  // 取代「按合入顺序分配的 4 位序号」——并行分支各自生成必然撞号，时间戳天然不撞。
  // drizzle-kit 的 `timestamp` 前缀内部走 `Date.prototype.toISOString()`（永远 UTC，`TZ` 改不动），
  // UTC+8 由 `scripts/utc8-timestamp-prefix.ts` 经 `bun --preload` 注入，见 `package.json` 的 `generate` 脚本。
  migrations: { prefix: 'timestamp' },
})
