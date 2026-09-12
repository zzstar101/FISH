import { type SQL, sql } from 'drizzle-orm'

/**
 * 写 jsonb 列时用它包一层：`values({ payload: jsonParam({ ... }) })`。
 *
 * 直接用裸对象（`values({ payload: { ... } })`）在 **drizzle-orm 0.45.2 + `bun-sql`** 下会被
 * stringify 两次，落库成为「JSON 字符串套 JSON」（`jsonb_typeof = 'string'`）。这种行：
 *
 * - 用 drizzle 读回来**正常**（读路径会 parse 两次，正好抵消），所以 drizzle 单测发现不了；
 * - 但 `payload->>'listingId'` 之类的 SQL 访问**恒为 NULL** —— #8 的匹配 worker、#9 的通知
 *   只要按 payload 过滤/取值就永远匹配不到，而这是最自然的写法。
 *
 * 用 `sql` 模板传对象则只编码一次。对照实测（同一个库、同一份 drizzle 版本）：
 *
 * ```text
 * values({ payload: obj })              → jsonb_typeof = 'string'，payload->>'listingId' = NULL
 * values({ payload: jsonParam(obj) })   → jsonb_typeof = 'object'，payload->>'listingId' = '...'
 * ```
 *
 * 回归用例：`seed.test.ts` 断言 seed 写出的 jobs / notifications payload 是 object 且可按 key 取值。
 */
export function jsonParam(value: unknown): SQL {
  return sql`${value}::jsonb`
}
