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
 */
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const createdAt = () => timestamptz('created_at').notNull().defaultNow()

/** app 侧维护（不建 PG trigger）；只在所有写入都经 Drizzle 的前提下成立。 */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

/** 可变行使用。不可变行（messages / listing_images）只取 `createdAt()`。 */
export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() })
