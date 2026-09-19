import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { listings } from './listings'
import { users } from './users'

/**
 * 商品详情留言 / 评论（Issue #111）。
 *
 * 自引用 `parent_id` 表达「回复」：`NULL` = 顶层留言，非空 = 回复某条顶层留言。
 * **只允许嵌套一层**（页面只渲染一层），这条由 service 保证而不是 DB CHECK ——
 * 「父留言的 parent_id 必须为 NULL」需要跨行断言，CHECK 表达不了；DB 侧只保证
 * 被引用的留言真实存在（外键）与删除级联。
 *
 * 不可变行：只有 `created_at`，没有 `updated_at`（留言不支持编辑，Issue §五 明确
 * 删除 / 点赞都在范围外）。
 */
export const comments = pgTable(
  'comments',
  {
    ...primaryKey(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    /** 自引用必须是惰性类型标注（`AnyPgColumn`），否则 drizzle 在建表前无法定型 `comments.id`。 */
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, {
      onDelete: 'cascade',
    }),
    /** 长度上限由契约（`COMMENT_CONTENT_MAX`）收口，DB 是裸 `text`（与 listings.title 同口径）。 */
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // 顶层留言分页：`WHERE listing_id = ? AND parent_id IS NULL ORDER BY created_at DESC, id DESC`。
    // 把 `parent_id` 放进索引前缀，让「取某 listing 的顶层留言」与「取某父留言的回复」都不回表。
    index('comments_listing_id_parent_id_created_at_id_idx').on(
      table.listingId,
      table.parentId,
      table.createdAt,
      table.id,
    ),
    index('comments_parent_id_created_at_id_idx').on(table.parentId, table.createdAt, table.id),
  ],
)
