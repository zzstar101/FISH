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
 * **数组必须走 `JSON.stringify` 再转型**（不能写 `sql\`${arr}::jsonb\``）：
 * drizzle 的 `sql` 模板把**数组当作多个绑定参数**展开，于是 `['a','b']` 会变成
 * `($1, $2)::jsonb`（语法错），空数组更会变成 `()::jsonb`。实测：
 *
 * ```text
 * sql`${['a']}::jsonb`                  → $1 是 'a'（单个字符串）→ jsonb_typeof = 'string'
 * sql`${[]}::jsonb`                     → ()::jsonb → ERROR 语法错
 * sql`${JSON.stringify(['a'])}::text::jsonb` → jsonb_typeof = 'array'，@> / jsonb_array_length 可用
 * ```
 *
 * 回归用例：按 `payload->>'...'` 在 SQL 层过滤的路径都守着它——`apps/worker/.../engine.test.ts`
 * 用 `payload->>'wishId'` 断言通知；`seed.test.ts` 断言 seed 写出的 jobs payload 是 object；
 * `apps/api/src/modules/listings/store.test.ts` 断言审核记录的 `matched_rules` 是 jsonb 数组。
 */
export function jsonParam(value: unknown): SQL {
  // `::text::jsonb` 而不是直接 `::jsonb`：先把值作为**单个字符串参数**绑定（`JSON.stringify`
  // 让数组/对象都不会被模板展开成参数列表），再交给 PG 解析。
  return sql`${JSON.stringify(value)}::text::jsonb`
}
