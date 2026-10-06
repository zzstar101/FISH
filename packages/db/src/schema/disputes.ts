import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { createdAt, primaryKey, timestamps } from './common'
import { messages } from './messages'
import { transactions } from './transactions'
import { users } from './users'

/**
 * 交易争议（#465）。与 `reports` 是**两个域**，刻意不复用 `reports` 表：
 * `reports.target_id` 是多态裸 uuid（没有外键，见 `reports.ts`），拿不到数据库侧
 * 的「这个目标真的存在」兜底；而争议需要的参与者外键、第二终态（WITHDRAWN）、
 * 结论枚举、附件台账与聊天证据关联，硬塞进 reports 会改动 #280 / #73 已验收的形状。
 *
 * 边界（票面「不做」）：争议结论**只写争议行与审计行**，不修改 `transactions.status`
 * 或 `listings.status`，也不触发任何治理动作（封禁 / 下架）。成交事实不受影响。
 */
export const disputeTypeEnum = pgEnum('dispute_type', [
  'ITEM_MISMATCH',
  'NOT_COMPLETED',
  'PAYMENT_ISSUE',
  'OTHER',
])

/** PENDING → RESOLVED（管理员）/ WITHDRAWN（发起人）；后两者都是终态，行不可复活。 */
export const disputeStatusEnum = pgEnum('dispute_status', ['PENDING', 'RESOLVED', 'WITHDRAWN'])

/** 争议结论。语义只描述"本次反馈是否成立"，不等同于处罚。 */
export const disputeResolutionEnum = pgEnum('dispute_resolution', [
  'UPHELD',
  'DISMISSED',
  'INCONCLUSIVE',
])

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/**
 * 争议行。一行 = 一次对某笔真实交易的反馈。
 *
 * 参与者不存重复信息：`respondent_id` 由交易**推导**（发起人若是买家则被诉方是卖家，
 * 反之亦然），请求体不可指定，服务层负责推导与校验。
 *
 * 去重靠下面的部分唯一索引：同一交易 + 同一发起方向至多一条未决争议。终态（RESOLVED /
 * WITHDRAWN）行不占用该约束，所以「被驳回后可以重新发起」是天然成立的。
 */
export const disputes = pgTable(
  'disputes',
  {
    ...primaryKey(),
    /** 真实交易（票面要求"关联真实交易"）：外键而非多态 uuid。 */
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    /** 发起人 = 该交易的买家或卖家（服务层校验）。 */
    initiatorId: uuid('initiator_id')
      .notNull()
      .references(() => users.id),
    /** 被诉方 = 交易的另一方（服务层由交易推导，不从请求体读）。 */
    respondentId: uuid('respondent_id')
      .notNull()
      .references(() => users.id),
    type: disputeTypeEnum('type').notNull(),
    /** 补充说明。`OTHER` 必须填（见 CHECK）；其余类型可选。 */
    detailText: text('detail_text'),
    status: disputeStatusEnum('status').notNull().default('PENDING'),
    /** 管理员结论；`RESOLVED` 时必须非空（见 CHECK）。 */
    resolution: disputeResolutionEnum('resolution'),
    /** 结论文本，1..500；随 `RESOLVED` 一起写入，之后不可改（只有终态行，无更新路径）。 */
    resolutionNote: text('resolution_note'),
    handledBy: uuid('handled_by').references(() => users.id),
    handledAt: timestamptz('handled_at'),
    /** 发起人撤回时刻；`WITHDRAWN` 时必须非空（见 CHECK）。 */
    withdrawnAt: timestamptz('withdrawn_at'),
    ...timestamps(),
  },
  (table) => [
    // 同一方向同一交易至多一条未决争议：重复提交走 ON CONFLICT DO NOTHING，不报错。
    uniqueIndex('disputes_pending_transaction_initiator_uq')
      .on(table.transactionId, table.initiatorId)
      .where(sql`${table.status} = 'PENDING'`),
    check(
      'disputes_initiator_id_differs_from_respondent_id',
      sql`${table.initiatorId} <> ${table.respondentId}`,
    ),
    // OTHER 是"说不上来哪一类"的兜底，必须留下文字，否则管理员无从处理。
    // 纯空白不算文字（契约侧同样 trim 后判 min(1)，这里是 DB 兜底）。
    check(
      'disputes_other_type_requires_detail',
      sql`${table.type} <> 'OTHER'
        OR (${table.detailText} IS NOT NULL AND length(btrim(${table.detailText})) > 0)`,
    ),
    // 结论四件套同生同灭（NULL-safe 相等判定，同 transactions 的写法）。
    check(
      'disputes_resolution_matches_status',
      sql`(${table.status} = 'RESOLVED') = (${table.resolution} IS NOT NULL)
        AND (${table.status} = 'RESOLVED') = (${table.resolutionNote} IS NOT NULL)
        AND (${table.status} = 'RESOLVED') = (${table.handledBy} IS NOT NULL)
        AND (${table.status} = 'RESOLVED') = (${table.handledAt} IS NOT NULL)`,
    ),
    check(
      'disputes_withdrawn_at_matches_status',
      sql`(${table.status} = 'WITHDRAWN') = (${table.withdrawnAt} IS NOT NULL)`,
    ),
    // 「我的争议」= 我发起的 + 我被诉的，两条独立索引避免 OR 退化成顺序扫描。
    index('disputes_initiator_created_at_idx').on(table.initiatorId, table.createdAt, table.id),
    index('disputes_respondent_created_at_idx').on(table.respondentId, table.createdAt, table.id),
    // 管理端队列默认按状态筛选 + 时间倒序。
    index('disputes_status_created_at_idx').on(table.status, table.createdAt, table.id),
    // 管理端详情/队列要按交易聚合：`related`（同交易其它未决）与 `disputeCount`（全量计数）
    // 都按 `transaction_id` 过滤，没这条索引就会退化成全表扫描。
    index('disputes_transaction_id_idx').on(table.transactionId),
  ],
)

/**
 * 争议附件（#465）：受限图片，私有前缀 `dispute-media/` 的对象台账。
 *
 * **只增不改不删**：应用层不提供 UPDATE / DELETE 接口，`object_key` 唯一，
 * 后续确认同一张图走幂等路径返回同一行。
 *
 * 「证据不可被覆盖替换」不是靠唯一键就行 —— 预签名 URL 在有效期内仍可对**同一 key**
 * 二次 PUT，把已确认的字节换掉。收口手段是 `content_digest`：确认时刻对实际读到的
 * 字节算 sha256 存下来，之后读侧（`GET /uploads/dispute-media/:token`）只下发与
 * 该 digest 相符的字节，对不上就拒。于是「对象被换掉」不会变成「换掉的内容被当成证据看到」。
 *
 * 行主键（`med_` 公开 ID）与对象键第三段是同一个 UUID：确认时从对象键解析出 id，
 * 天然幂等，也不需要额外的「上传会话」表。
 */
export const disputeAttachments = pgTable(
  'dispute_attachments',
  {
    ...primaryKey(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    /** 上传者（争议参与人之一，服务层校验）。 */
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id),
    objectKey: text('object_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** 真实尺寸由服务端解析容器后写入，客户端声明从不被信任。 */
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    /** 确认时刻实际读到字节的 sha256（hex，小写）。读侧据此拒绝已被替换的对象。 */
    contentDigest: text('content_digest').notNull(),
    /** 附件行不可变，因此没有 `updated_at`。 */
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('dispute_attachments_object_key_uq').on(table.objectKey),
    check('dispute_attachments_size_bytes_positive', sql`${table.sizeBytes} > 0`),
    check(
      'dispute_attachments_dimensions_positive',
      sql`${table.width} > 0 AND ${table.height} > 0`,
    ),
    check('dispute_attachments_key_prefix', sql`${table.objectKey} LIKE 'dispute-media/%'`),
    check('dispute_attachments_digest_sha256', sql`${table.contentDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      'dispute_attachments_mime_allowed',
      sql`${table.mimeType} IN ('image/jpeg', 'image/png', 'image/webp')`,
    ),
    index('dispute_attachments_dispute_created_at_idx').on(
      table.disputeId,
      table.createdAt,
      table.id,
    ),
  ],
)

/**
 * 争议 ↔ 聊天证据（#465）。**只存引用，不复制消息内容**：
 * 消息正文的读取权仍由 messages 域决定，争议侧不产生第二份正文副本，
 * 也不会因为「关联了证据」而把整段私聊开放给管理端。
 *
 * `message_id` 级联删除：会话/消息被删时引用行同步消失（引用目标不存在就没有意义），
 * 这也避免了一笔历史争议把商品删除流程卡死。
 */
export const disputeEvidenceMessages = pgTable(
  'dispute_evidence_messages',
  {
    ...primaryKey(),
    disputeId: uuid('dispute_id')
      .notNull()
      .references(() => disputes.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** 谁关联的（只有发起人能补材料，见 `apps/api/src/modules/disputes/service.ts` 的 `requireInitiator`）。 */
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    // 同一条消息不重复关联（重复提交走 ON CONFLICT DO NOTHING）。
    uniqueIndex('dispute_evidence_messages_dispute_message_uq').on(
      table.disputeId,
      table.messageId,
    ),
    index('dispute_evidence_messages_dispute_created_at_idx').on(
      table.disputeId,
      table.createdAt,
      table.id,
    ),
  ],
)
