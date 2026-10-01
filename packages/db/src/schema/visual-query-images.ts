import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey, timestamptz } from './common'

/**
 * 查询图（临时私有对象）的登记与清理台账（#324 M2）。
 *
 * 为什么需要一张表，而不是"上传完就不管"：
 * - **清理必须有依据**：查询图不进 Listing 媒体、没有别的引用，S3 生命周期规则看不到
 *   "哪些键属于查询图"（本单不改 infra），所以"到期删除"只能由我们自己按台账驱动；
 * - **归属校验**：键里带主体（`visual-search/{subject}/…`）能防住引用他人对象，台账再提供
 *   "这个键确实是本主体申请过的"这一层；
 * - **可观测**：`used_at` 让"上传了多少张 / 其中多少张真的被搜索消费"可查——M9 的
 *   empty-result rate 与上传失败率都要靠它。
 *
 * `expires_at` 是**唯一**的清理判据：对象在 presign 时就被赋予了固定寿命，
 * 不因为"用户又打开了搜索页"而续命（续命等于无限期保留）。
 */
export const visualQueryImages = pgTable(
  'visual_query_images',
  {
    ...primaryKey(),
    /** 私有对象键；与 presign 返回值一致，且满足 `isVisualQueryImageKey`。 */
    objectKey: text('object_key').notNull(),
    /** 主体类型：`user`（登录）或 `session`（匿名会话）。 */
    subjectType: text('subject_type').notNull(),
    /** 主体标识（登录用户 = userId；匿名 = 会话标识的 HMAC），从不落原始 IP。 */
    subjectKey: text('subject_key').notNull(),
    contentType: text('content_type').notNull(),
    /**
     * 客户端声明的大小：**不可信数据**。对象存储的 PUT 不受它约束（预签名 URL 没有内容长度上限），
     * 所以真正的上限只在搜索时按对象真实字节数强制（超限即 `VISUAL_SEARCH_IMAGE_TOO_LARGE`）。
     * 这个字段只用于最早期拒绝明显超限的请求，以及事后观测。
     */
    sizeBytes: integer('size_bytes').notNull(),
    /** 被搜索消费的时刻；NULL = 上传后未被使用（仍会被清理）。 */
    usedAt: timestamptz('used_at'),
    /** 到期时刻（presign 时刻 + `VISUAL_QUERY_IMAGE_TTL_SECONDS`）。 */
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('visual_query_images_object_key_uq').on(table.objectKey),
    // 清理任务按到期时刻扫描。
    index('visual_query_images_expires_at_idx').on(table.expiresAt),
    check('visual_query_images_object_key_prefix', sql`${table.objectKey} LIKE 'visual-search/%'`),
    check(
      'visual_query_images_subject_type_allowed',
      sql`${table.subjectType} IN ('user', 'session')`,
    ),
    check(
      'visual_query_images_content_type_allowed',
      sql`${table.contentType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    check('visual_query_images_size_bytes_positive', sql`${table.sizeBytes} > 0`),
  ],
)
