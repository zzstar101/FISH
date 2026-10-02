import { sql } from 'drizzle-orm'
import { timestamp, uuid } from 'drizzle-orm/pg-core'
import { newId } from '../ids'

/**
 * 各表共用的列。
 *
 * 必须用工厂函数，不能共用同一个 column builder 实例：Drizzle 的 `PgColumn` 构造函数会把
 * `uniqueName` 写回 builder 的 config 对象（`pg-core/columns/common.js`），共享实例会让
 * 第一个 build 的表把名字泄漏给其他所有表（实测所有表的 `id` 都带上了 `users_id_unique`）。
 */
export const primaryKey = () => ({
  id: uuid('id').primaryKey().default(sql`uuidv7()`).$defaultFn(newId),
})

/**
 * 绝对时刻统一用 timestamptz + JS Date（#2 决策：不用无时区 timestamp、不用数值时间戳）。
 *
 * 领域表需要语义化时刻列（如 `requested_at` / `occurred_at`）时直接用这个工厂，
 * 不要再写一份 `timestamp(name, {...})`：类型选项散开后，"不用无时区 timestamp"这条决策就守不住了。
 */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const createdAt = () => timestamptz('created_at').notNull().defaultNow()

/**
 * app 侧维护（不建 PG trigger）；只在所有写入都经 Drizzle 的前提下成立。
 *
 * **时刻一律取数据库时钟（`now()`），不取应用进程时钟**：#322 把 `updated_at` 当版本号用
 * （`embeddings.source_updated_at` 直接取它，写入时走 CAS `excluded.source_updated_at >= 现存`）。
 * 插入用 `defaultNow()`（DB 钟）、更新用 `new Date()`（应用钟）时，只要两个钟有偏差，刚编辑过的行
 * 就会带上比"编辑前"更小的版本号，CAS 会**静默丢弃**这次重算（`saveEmbedding` 返回 false ⇒
 * handler 报 `stale`，实体永久停在过期向量）。实测本机 Docker 容器钟比宿主快 42–52ms，最小复现：
 * insert(DB now)=…164ms、update(app clock)=…126ms、delta=−38ms ⇒ REJECT。时钟同源后
 * "后写的版本不小于先写的版本"才成立（`apps/worker/src/jobs/matching/engine.test.ts` 与
 * `apps/worker/src/jobs/embedding/handlers.test.ts` 的编辑-重算用例即覆盖这条不变式）。
 */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`now()`)

/** 可变行使用。不可变行（messages / listing_images）只取 `createdAt()`。 */
export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() })
