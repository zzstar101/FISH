/**
 * SQL 侧逐字复刻 `contentHashOf(buildListingEmbeddingText() / buildWishEmbeddingText())`（#322 M4）。
 *
 * 为什么要复刻：读路径对**目标向量**的闸门（`apps/worker/src/jobs/matching/engine.ts` 的
 * `loadTargetVector()`）除了 `model` / 维度 / 毫秒级版本号，还比
 * `contentHash === contentHashOf(text)`。观测脚本（`apps/worker/scripts/obs-summary.ts`）用
 * "版本号 + 维度"算出来的覆盖率只是**上界**——把指纹那一腿也搬进 SQL，覆盖率才等于真正"可召回"。
 *
 * 与 TS 侧逐条对应（`packages/contracts/src/embedding/text.ts`）：
 *   * `normalizeValue()`：`\r\n?` → `\n`，再去掉 `String.prototype.trim()` 语义的白空格；
 *     空串与 NULL 等价 ⇒ `nullif(btrim(...), '')`；
 *   * `compose()`：`标签: 值` 逐行拼接、值为空**整行省略** ⇒ `||` 遇 NULL 得 NULL，
 *     `concat_ws` 跳过 NULL；
 *   * `contentHashOf()`：`sha256("<格式版本>:<文本>")` 取小写十六进制 ⇒
 *     `encode(sha256(convert_to(concat(...), 'UTF8')), 'hex')`。
 *
 * 偏差方向：任何字符级差异都只会把**其实新鲜**的行算成不新鲜（分子偏小），不会把陈旧向量算成
 * 可召回。等价性由 `content-hash-sql.test.ts` 对边界值（制表符 / CRLF / 全角空格 / NBSP / 空串 /
 * emoji / `null` 分类）逐例对照 TS 实现钉住。
 */

import { EMBEDDING_TEXT_FORMAT_VERSION } from '@fish/contracts/embedding/text'
import { type SQL, sql } from 'drizzle-orm'

/**
 * `String.prototype.trim()` 去掉的白空格集合（WhiteSpace + LineTerminator）。
 * Postgres 的 `btrim(x)` 默认只去 U+0020，必须显式给出集合，否则带制表符 / 全角空格的字段
 * 两边会算出不同文本。
 */
const JS_TRIM_CHARS = sql.raw(
  "E' \\t\\n\\x0b\\f\\r\\u00a0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff'",
)

/** `normalizeValue()`：`\r\n?` → `\n`，再去掉 JS 语义的白空格；空串与 NULL 等价。 */
function normalizedSql(column: SQL): SQL {
  return sql`nullif(btrim(regexp_replace(${column}, E'\\r\\n?', E'\\n', 'g'), ${JS_TRIM_CHARS}), '')`
}

/**
 * 算出 `alias` 指向的实体行**当前内容**对应的指纹（与 `contentHashOf()` 同值）。
 *
 * `alias` 必须是带 `title`/`description`/`category`（listing）或 `keyword`/`description`/`category`
 * （wish）的列引用，例如 `sql`t`` 或 `sql`l``。
 */
export function embeddingContentHashSql(kind: 'listing' | 'wish', alias: SQL): SQL {
  const fields =
    kind === 'listing'
      ? [
          { label: '标题', value: sql`${alias}.title` },
          { label: '描述', value: sql`${alias}.description` },
          { label: '分类', value: sql`${alias}.category::text` },
        ]
      : [
          { label: '需求', value: sql`${alias}.keyword` },
          { label: '描述', value: sql`${alias}.description` },
          // 与 `buildWishEmbeddingText()` 一致：`null` 分类按文本规范写成 `不限`，而不是省略该行。
          { label: '分类', value: sql`coalesce(${alias}.category::text, '不限')` },
        ]

  // 参数都要显式 `::text`：`concat()` / `||` 的入参类型是 "any"，不转型时 Postgres 会报
  // `could not determine data type of parameter`（42P18）。
  const text = sql`concat_ws(E'\\n', ${sql.join(
    fields.map((field) => sql`${`${field.label}: `}::text || ${normalizedSql(field.value)}`),
    sql`, `,
  )})`

  return sql`encode(sha256(convert_to(concat(${`${EMBEDDING_TEXT_FORMAT_VERSION}:`}::text, ${text}), 'UTF8')), 'hex')`
}
