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
 * #322 把 updated_at 复制为 embedding 的 source version。更新取数据库实际求值时间
 * clock_timestamp()，既不混用应用钟，也不使用冻结在事务开始时的 now()：先开始的事务可能后取得
 * 行锁，若它写入 now()，版本会倒退，unchanged 向量的单向 refresh 会拒绝推进并永久退出候选。
 * 插入的 defaultNow() 不变（没有既有版本），不改 schema 默认值或历史迁移。
 * 时间戳仍不是严格递增 revision（同毫秒/时钟校正均有边界）；旧内容的最终防线是实体行锁和
 * content hash 复检，不能仅用时间戳判定内容先后。两连接晚写价格更新回归覆盖事务开始顺序反转。
 */
export const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => sql`clock_timestamp()`)

/** 可变行使用。不可变行（messages / listing_images）只取 `createdAt()`。 */
export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() })
