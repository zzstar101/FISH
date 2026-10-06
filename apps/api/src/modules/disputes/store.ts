import type { AdminAuditAction, AdminAuditTargetType } from '@fish/contracts/admin/schema'
import type { DisputeResolution, DisputeStatus, DisputeType } from '@fish/contracts/disputes/schema'
import type { TransactionStatus } from '@fish/contracts/transactions/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { type SQL, sql } from 'drizzle-orm'
import { createdAtCursorText, cursorCondition } from '../admin/cursor'

/**
 * Disputes store（#465）：交易争议的全部 SQL。
 *
 * 与 reports store 同一姿态：所有语句走 `db.execute(sql\`…\`)` 裸 SQL（`rowsOf()` 归一
 * bun-sql 的结果形状），DTO 由 service 构造并过契约 zod。差别在：
 *
 * - 争议**有真实外键**（交易、参与者），所以参与者校验可以直接写进 WHERE，而不是靠
 *   调用方传进来的多态 uuid 自己判；
 * - `resolveDispute` 自己开事务，业务 UPDATE 与审计 INSERT 同事务，条件更新
 *   `WHERE status = 'PENDING'` 处理两个管理员同时处理；
 * - 附件与证据都是 append-only，没有 UPDATE / DELETE 语句。
 */

export type DisputeDbTransaction = Parameters<Parameters<Db['transaction']>[0]>[0]

/** 通知事件：与契约 `notificationDisputeEventSchema` 同值域。 */
export type DisputeNotificationEvent = 'FILED' | 'WITHDRAWN' | 'RESOLVED'

export type DisputeNotificationInput = {
  userId: string
  disputeId: string
  transactionId: string
  event: DisputeNotificationEvent
  resolution?: DisputeResolution
}

/**
 * 通知写入器：**在状态变更的同一个事务里**被调用（`executor` 就是那个 tx）。
 *
 * 通知不能是 best-effort：结论提交后进程崩溃、或写通知失败，会让当事人**永久**收不到结论，
 * 而库里没有 outbox 可以补投（plan §2 冻结「与状态变更同事务，走 `writeNotification(executor, …)`」）。
 */
export type DisputeNotificationWriter = (
  executor: DisputeDbTransaction,
  input: DisputeNotificationInput,
) => Promise<void>

/**
 * 一条争议的持久化形态。
 *
 * 三个 pgEnum 列（`type` / `status` / `resolution`）直接用契约的枚举类型，而不是 `string`：
 * SQL 结果在 `disputeFromRow` 这一处边界断言成枚举，下游（service 的判态、过滤、DTO 组装）
 * 就不再需要 `as` 把 `string` 掰回枚举 —— 断言只允许出现在解析边界，不散落在业务分支里。
 */
export type DisputeRow = {
  id: string
  transactionId: string
  initiatorId: string
  respondentId: string
  type: DisputeType
  detailText: string | null
  status: DisputeStatus
  resolution: DisputeResolution | null
  resolutionNote: string | null
  handledBy: string | null
  handledAt: Date | null
  withdrawnAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** 微秒精度游标文本（`to_char` 产出，见 admin/cursor.ts）。 */
  createdAtCursor: string
}

export type DisputeUserRow = { id: string; nickname: string }

export type DisputeTransactionRow = {
  id: string
  listingId: string
  listingTitle: string
  buyer: DisputeUserRow
  seller: DisputeUserRow
  amountCents: number
  /** `transactions.status`（pgEnum）→ 契约 `transactionStatusSchema` 的同一值域。 */
  status: TransactionStatus
  completedAt: Date | null
  cancelledAt: Date | null
  createdAt: Date
}

/** 队列 / 详情共用的行：争议 + 双方 + 交易 + 处理人。 */
export type DisputeJoinedRow = {
  dispute: DisputeRow
  initiator: DisputeUserRow
  respondent: DisputeUserRow
  transaction: DisputeTransactionRow
  handler: DisputeUserRow | null
}

/** 管理端行：在共用行之上补三个计数（附件 / 证据 / 同交易争议数）。 */
export type DisputeAdminRow = DisputeJoinedRow & {
  attachmentCount: number
  evidenceCount: number
  disputeCount: number
}

export type DisputeAttachmentRow = {
  id: string
  disputeId: string
  uploaderId: string
  objectKey: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
  /** 确认时刻实际读到字节的 sha256；读地址的令牌必须带着它（#465 不可覆盖替换）。 */
  contentDigest: string
  createdAt: Date
  uploaderNickname: string
}

export type DisputeEvidenceRow = {
  id: string
  disputeId: string
  messageId: string
  addedBy: string
  createdAt: Date
  adderNickname: string
  messageType: string
  messageSenderId: string | null
  messageSenderNickname: string | null
  messageContent: string
  messageRecalledAt: Date | null
  messageCreatedAt: Date
}

/** 关联前的候选消息（只证明"这条消息属于本交易的会话"，尚未建立关联）。 */
export type EvidenceCandidateRow = {
  messageId: string
  messageType: string
  messageSenderId: string | null
  messageSenderNickname: string | null
  messageContent: string
  messageRecalledAt: Date | null
  messageCreatedAt: Date
}

export type CreateDisputeInput = {
  transactionId: string
  initiatorId: string
  respondentId: string
  type: DisputeType
  detailText: string | null
}

export type ListDisputesCriteria = {
  viewerId: string
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type ListAdminDisputesCriteria = {
  status?: DisputeStatus
  type?: DisputeType
  q?: string
  createdFrom?: Date
  createdTo?: Date
  cursor: { createdAt: string; id: string } | null
  limit: number
}

export type InsertAttachmentInput = {
  id: string
  disputeId: string
  uploaderId: string
  objectKey: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
  contentDigest: string
}

export type ResolveDisputeInput = {
  disputeId: string
  actorUserId: string
  resolution: DisputeResolution
  reason: string
}

export interface DisputeStore {
  /**
   * 交易摘要，**仅当查看者是该交易的买家或卖家时**才返回。
   *
   * 「交易不存在」与「我不是参与人」都返回 `null`：两者对调用方是同一件事（404），
   * 分开表达只会给外人一个枚举交易 id 的信道（与 `transactions/service.ts` 的
   * `loadPendingTxForMeetup` 同一手法）。
   */
  findTransactionForViewer(
    transactionId: string,
    viewerId: string,
  ): Promise<DisputeTransactionRow | null>
  /** 我（作为发起人）在该交易上仍未决的争议 id。 */
  findPendingDisputeId(transactionId: string, initiatorId: string): Promise<string | null>
  /**
   * 插入争议。唯一索引冲突（同交易同方向已有未决争议）走 `ON CONFLICT DO NOTHING`，
   * 返回 `duplicate` + 既有 id —— 与举报一致：不靠捕异常，异常路径会污染 bun-sql 连接池。
   */
  insertDispute(
    input: CreateDisputeInput,
  ): Promise<{ kind: 'created'; disputeId: string } | { kind: 'duplicate'; disputeId: string }>
  /** 争议 + 双方 + 交易；查看者必须是参与人或管理员（`admin` 为 true 时跳过参与人校验）。 */
  findDispute(
    disputeId: string,
    viewerId: string,
    options?: { admin?: boolean },
  ): Promise<DisputeJoinedRow | null>
  /** 「我的争议」= 我发起的 + 我被诉的，时间倒序 + 游标。 */
  listMine(criteria: ListDisputesCriteria): Promise<DisputeJoinedRow[]>
  listAdminDisputes(criteria: ListAdminDisputesCriteria): Promise<DisputeAdminRow[]>
  /** 同一交易上的其它**未决**争议（详情页给出上下文，不泄漏给非参与人）。 */
  listRelatedPending(
    transactionId: string,
    excludeDisputeId: string,
    limit: number,
  ): Promise<DisputeJoinedRow[]>
  /** 同一交易上的**全部**争议数（含各终态，含本条）。与队列的 `disputeCount` 同一口径。 */
  countDisputesByTransaction(transactionId: string): Promise<number>

  countAttachments(disputeId: string): Promise<number>
  listAttachments(disputeId: string): Promise<DisputeAttachmentRow[]>
  /**
   * 插入附件行。数量上限与「争议仍是 PENDING」都在**同一事务的行锁内**判定。
   *
   * 先按 `object_key` 查既有行（重复确认必须仍然幂等，哪怕已到上限），再
   * `SELECT status FROM disputes WHERE id = $1 FOR UPDATE` 锁住争议行：
   * - 锁内校验状态，否则「service 读到 PENDING → 等到 S3 读完字节时已被 resolve/withdraw」
   *   会把附件写进终态争议（审查 P1-1）；
   * - 锁内计数，不用「先 count 再 insert」，也不用 `INSERT … SELECT … WHERE (SELECT count(*)) < n`
   *   —— READ COMMITTED 下两条并发语句都可能看到 n-1 行，只有行锁能把它变成真上限（审查 P2-4）。
   */
  insertAttachment(
    input: InsertAttachmentInput,
    limit: number,
  ): Promise<{
    kind: 'created' | 'duplicate' | 'limit' | 'not-found' | 'not-pending'
    attachmentId: string | null
  }>
  /** 从对象键反查附件（确认接口的幂等快速路径）。 */
  findAttachmentByObjectKey(objectKey: string): Promise<DisputeAttachmentRow | null>
  /** 从对象键解析出的 id 反查附件（同一张图重复确认时命中唯一键）。 */
  findAttachmentById(attachmentId: string): Promise<DisputeAttachmentRow | null>

  countEvidence(disputeId: string): Promise<number>
  listEvidence(disputeId: string): Promise<DisputeEvidenceRow[]>
  /**
   * 证据候选消息：必须是**由本争议的交易推导出的那段会话**里的消息。
   *
   * 交易 ↔ 会话是 `(listing_id, buyer_id)` 唯一键（`conversations` 表），不是交易上存
   * conversationId —— 会话先于交易存在（买家先发起交易确认才会建交易行）。这条 JOIN 就是
   * 「只能关联本交易的聊天」的全部实现；发送者是否属于双方由会话本身保证。
   *
   * 只看消息本身，不看是否已关联（关联前的校验必须能通过）。
   */
  findEvidenceCandidate(disputeId: string, messageId: string): Promise<EvidenceCandidateRow | null>
  /** 已建立的关联行（幂等重读用）。 */
  findEvidenceRow(disputeId: string, messageId: string): Promise<DisputeEvidenceRow | null>
  /**
   * 写入关联行，与 `insertAttachment` 同样在行锁内校验争议状态。
   *
   * 证据落库前要先读消息、校验会话归属，中间同样有窗口；终态争议不能再加材料（审查 P1-1）。
   * 重复关联靠 `(dispute_id, message_id)` 唯一键幂等。
   */
  insertEvidence(input: { disputeId: string; messageId: string; addedBy: string }): Promise<{
    kind: 'created' | 'duplicate' | 'not-found' | 'not-pending'
    evidenceId: string | null
  }>

  /** 发起人撤回：条件更新，只有仍 PENDING 且发起人本人的行会被写。 */
  withdrawDispute(input: {
    disputeId: string
    initiatorId: string
  }): Promise<'applied' | 'conflict'>
  /** 管理员处理：业务 UPDATE 与审计写入同事务。 */
  resolveDispute(input: ResolveDisputeInput): Promise<'applied' | 'not-found' | 'conflict'>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function toDate(value: unknown): Date {
  return new Date(value as string | Date)
}

function toNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : new Date(value as string | Date)
}

const disputeSelectSql = sql`
  d.id AS id, d.transaction_id AS transaction_id, d.initiator_id AS initiator_id,
  d.respondent_id AS respondent_id, d.type::text AS type, d.detail_text AS detail_text,
  d.status::text AS status, d.resolution::text AS resolution,
  d.resolution_note AS resolution_note, d.handled_by AS handled_by,
  d.handled_at AS handled_at, d.withdrawn_at AS withdrawn_at,
  d.created_at AS created_at, d.updated_at AS updated_at,
  ${createdAtCursorText(sql`d.created_at`)} AS created_at_cursor
`

const disputeJoinSql = sql`
  ini.id AS initiator_summary_id, ini.nickname AS initiator_nickname,
  resp.id AS respondent_summary_id, resp.nickname AS respondent_nickname,
  h.id AS handler_summary_id, h.nickname AS handler_nickname,
  t.id AS transaction_summary_id, t.listing_id AS transaction_listing_id,
  t.amount_cents AS transaction_amount_cents, t.status::text AS transaction_status,
  t.completed_at AS transaction_completed_at, t.cancelled_at AS transaction_cancelled_at,
  t.created_at AS transaction_created_at,
  l.title AS transaction_listing_title,
  bu.id AS buyer_summary_id, bu.nickname AS buyer_nickname,
  su.id AS seller_summary_id, su.nickname AS seller_nickname
  FROM disputes d
  JOIN users ini ON ini.id = d.initiator_id
  JOIN users resp ON resp.id = d.respondent_id
  LEFT JOIN users h ON h.id = d.handled_by
  JOIN transactions t ON t.id = d.transaction_id
  JOIN listings l ON l.id = t.listing_id
  JOIN users bu ON bu.id = t.buyer_id
  JOIN users su ON su.id = t.seller_id
`

function disputeFromRow(row: Record<string, unknown>): DisputeRow {
  return {
    id: String(row.id),
    transactionId: String(row.transaction_id),
    initiatorId: String(row.initiator_id),
    respondentId: String(row.respondent_id),
    // 三个 pgEnum 列的唯一断言点：库里的值域由迁移的 enum 定义保证，这里只是把
    // `unknown` 收窄成契约枚举；真正的兜底仍在 service 出参的 zod `parse`。
    type: row.type as DisputeType,
    detailText: (row.detail_text as string | null) ?? null,
    status: row.status as DisputeStatus,
    resolution: (row.resolution as DisputeResolution | null) ?? null,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    handledBy: (row.handled_by as string | null) ?? null,
    handledAt: toNullableDate(row.handled_at),
    withdrawnAt: toNullableDate(row.withdrawn_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    createdAtCursor: String(row.created_at_cursor),
  }
}

function joinedFromRow(row: Record<string, unknown>): DisputeJoinedRow {
  return {
    dispute: disputeFromRow(row),
    initiator: {
      id: String(row.initiator_summary_id),
      nickname: String(row.initiator_nickname),
    },
    respondent: {
      id: String(row.respondent_summary_id),
      nickname: String(row.respondent_nickname),
    },
    transaction: {
      id: String(row.transaction_summary_id),
      listingId: String(row.transaction_listing_id),
      listingTitle: String(row.transaction_listing_title),
      buyer: { id: String(row.buyer_summary_id), nickname: String(row.buyer_nickname) },
      seller: { id: String(row.seller_summary_id), nickname: String(row.seller_nickname) },
      amountCents: Number(row.transaction_amount_cents),
      status: row.transaction_status as TransactionStatus,
      completedAt: toNullableDate(row.transaction_completed_at),
      cancelledAt: toNullableDate(row.transaction_cancelled_at),
      createdAt: toDate(row.transaction_created_at),
    },
    handler:
      row.handler_summary_id === null || row.handler_summary_id === undefined
        ? null
        : {
            id: String(row.handler_summary_id),
            nickname: String(row.handler_nickname),
          },
  }
}

function attachmentFromRow(row: Record<string, unknown>): DisputeAttachmentRow {
  return {
    id: String(row.id),
    disputeId: String(row.dispute_id),
    uploaderId: String(row.uploader_id),
    objectKey: String(row.object_key),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    width: Number(row.width),
    height: Number(row.height),
    contentDigest: String(row.content_digest),
    createdAt: toDate(row.created_at),
    uploaderNickname: String(row.uploader_nickname),
  }
}

function evidenceFromRow(row: Record<string, unknown>): DisputeEvidenceRow {
  return {
    id: String(row.id),
    disputeId: String(row.dispute_id),
    messageId: String(row.message_id),
    addedBy: String(row.added_by),
    createdAt: toDate(row.created_at),
    adderNickname: String(row.adder_nickname),
    messageType: String(row.message_type),
    messageSenderId: (row.message_sender_id as string | null) ?? null,
    messageSenderNickname: (row.message_sender_nickname as string | null) ?? null,
    messageContent: String(row.message_content),
    messageRecalledAt: toNullableDate(row.message_recalled_at),
    messageCreatedAt: toDate(row.message_created_at),
  }
}

/** 关键词搜索：争议说明 / 商品标题 / 双方昵称（与 #6 feed 同口径 ILIKE，`%_\` 转义）。 */
function disputeSearchCondition(q: string) {
  const escaped = q.replace(/[\\%_]/g, '\\$&')
  const pattern = `%${escaped}%`
  return sql`(d.detail_text ILIKE ${pattern} OR l.title ILIKE ${pattern}
    OR ini.nickname ILIKE ${pattern} OR resp.nickname ILIKE ${pattern})`
}

export function createSqlDisputeStore(
  db: Db,
  options?: {
    /** 与状态变更同事务写入当事人通知（见 `DisputeNotificationWriter`）。 */
    notify?: DisputeNotificationWriter
  },
): DisputeStore {
  const notify = options?.notify

  return {
    async findTransactionForViewer(transactionId, viewerId) {
      const result = await db.execute(sql`
        SELECT t.id, t.listing_id, l.title AS listing_title,
               t.buyer_id, b.nickname AS buyer_nickname,
               t.seller_id, s.nickname AS seller_nickname,
               t.amount_cents, t.status::text AS status,
               t.completed_at, t.cancelled_at, t.created_at
        FROM transactions t
        JOIN listings l ON l.id = t.listing_id
        JOIN users b ON b.id = t.buyer_id
        JOIN users s ON s.id = t.seller_id
        WHERE t.id = ${transactionId}
          AND (t.buyer_id = ${viewerId} OR t.seller_id = ${viewerId})
      `)
      const row = rowsOf(result)[0]
      if (!row) return null
      return {
        id: String(row.id),
        listingId: String(row.listing_id),
        listingTitle: String(row.listing_title),
        buyer: { id: String(row.buyer_id), nickname: String(row.buyer_nickname) },
        seller: { id: String(row.seller_id), nickname: String(row.seller_nickname) },
        amountCents: Number(row.amount_cents),
        status: row.status as TransactionStatus,
        completedAt: toNullableDate(row.completed_at),
        cancelledAt: toNullableDate(row.cancelled_at),
        createdAt: toDate(row.created_at),
      }
    },

    async findPendingDisputeId(transactionId, initiatorId) {
      const result = await db.execute(sql`
        SELECT id FROM disputes
        WHERE transaction_id = ${transactionId}
          AND initiator_id = ${initiatorId}
          AND status = 'PENDING'
      `)
      const row = rowsOf(result)[0]
      return row ? String(row.id) : null
    },

    async insertDispute(input) {
      // `ON CONFLICT … DO NOTHING` 而不是捕唯一键异常：异常路径污染 bun-sql 连接池
      // （见 reports/store.ts 同一处注释）。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await db.transaction(async (tx) => {
          const inserted = await tx.execute(sql`
            INSERT INTO disputes (id, transaction_id, initiator_id, respondent_id, type, detail_text)
            VALUES (${newId()}, ${input.transactionId}, ${input.initiatorId}, ${input.respondentId},
                    ${input.type}::dispute_type, ${input.detailText})
            ON CONFLICT (transaction_id, initiator_id) WHERE status = 'PENDING' DO NOTHING
            RETURNING id
          `)
          const row = rowsOf(inserted)[0]
          if (!row) return null
          const disputeId = String(row.id)
          // 通知与插入同事务：发起成功后被诉方立刻有一条可查的通知；写通知失败则整条回滚。
          await notify?.(tx, {
            userId: input.respondentId,
            disputeId,
            transactionId: input.transactionId,
            event: 'FILED',
          })
          return disputeId
        })
        if (result) return { kind: 'created' as const, disputeId: result }
        // 冲突分支：重读既有未决行。读到就返回；读不到说明对方刚被撤回/处理，再试一次 INSERT。
        const existing = await this.findPendingDisputeId(input.transactionId, input.initiatorId)
        if (existing) return { kind: 'duplicate' as const, disputeId: existing }
      }
      throw new Error('争议重复但未找到未决争议（唯一索引异常）')
    },

    async findDispute(disputeId, viewerId, options) {
      // 管理员走同一 SELECT，只是跳过参与人谓词：争议详情对管理员必须是全量的。
      const participantCondition = options?.admin
        ? sql``
        : sql`AND (d.initiator_id = ${viewerId} OR d.respondent_id = ${viewerId})`
      const result = await db.execute(sql`
        SELECT ${disputeSelectSql}, ${disputeJoinSql}
        WHERE d.id = ${disputeId} ${participantCondition}
      `)
      const row = rowsOf(result)[0]
      return row ? joinedFromRow(row) : null
    },

    async listMine(criteria) {
      const conditions = [
        sql`(d.initiator_id = ${criteria.viewerId} OR d.respondent_id = ${criteria.viewerId})`,
      ]
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`d.created_at`, sql`d.id`, criteria.cursor))
      }
      const result = await db.execute(sql`
        SELECT ${disputeSelectSql}, ${disputeJoinSql}
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${criteria.limit}
      `)
      return rowsOf(result).map(joinedFromRow)
    },

    async listAdminDisputes(criteria) {
      const conditions: SQL[] = []
      if (criteria.status) conditions.push(sql`d.status = ${criteria.status}::dispute_status`)
      if (criteria.type) conditions.push(sql`d.type = ${criteria.type}::dispute_type`)
      if (criteria.q) conditions.push(disputeSearchCondition(criteria.q))
      if (criteria.createdFrom) conditions.push(sql`d.created_at >= ${criteria.createdFrom}`)
      // 左闭右开：同一毫秒的边界行不会重复 / 漏掉。
      if (criteria.createdTo) conditions.push(sql`d.created_at < ${criteria.createdTo}`)
      if (criteria.cursor) {
        conditions.push(cursorCondition(sql`d.created_at`, sql`d.id`, criteria.cursor))
      }
      const where = conditions.length > 0 ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``
      // 三个计数都在独立别名上算：队列的状态/类型/关键词过滤不应缩小计数（同 admin 举报队列）。
      // 计数必须排在 `disputeJoinSql` 之前 —— 后者自带 `FROM … JOIN …`，插在它后面会变成
      // `… FROM … , (SELECT …)` 的语法错误。
      const result = await db.execute(sql`
        SELECT ${disputeSelectSql},
          (SELECT count(*)::int FROM dispute_attachments a WHERE a.dispute_id = d.id)
            AS attachment_count,
          (SELECT count(*)::int FROM dispute_evidence_messages e WHERE e.dispute_id = d.id)
            AS evidence_count,
          (SELECT count(*)::int FROM disputes all_disputes
            WHERE all_disputes.transaction_id = d.transaction_id) AS dispute_count,
          ${disputeJoinSql}
        ${where}
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${criteria.limit + 1}
      `)
      return rowsOf(result).map((row) => ({
        ...joinedFromRow(row),
        attachmentCount: Number(row.attachment_count),
        evidenceCount: Number(row.evidence_count),
        disputeCount: Number(row.dispute_count),
      }))
    },

    async listRelatedPending(transactionId, excludeDisputeId, limit) {
      const result = await db.execute(sql`
        SELECT ${disputeSelectSql}, ${disputeJoinSql}
        WHERE d.transaction_id = ${transactionId} AND d.id <> ${excludeDisputeId}
          AND d.status = 'PENDING'
        ORDER BY d.created_at DESC, d.id DESC
        LIMIT ${limit}
      `)
      return rowsOf(result).map(joinedFromRow)
    },

    async countDisputesByTransaction(transactionId) {
      const result = await db.execute(sql`
        SELECT count(*)::int AS total FROM disputes WHERE transaction_id = ${transactionId}
      `)
      return Number(rowsOf(result)[0]?.total ?? 0)
    },

    async countAttachments(disputeId) {
      const result = await db.execute(sql`
        SELECT count(*)::int AS count FROM dispute_attachments WHERE dispute_id = ${disputeId}
      `)
      return Number(rowsOf(result)[0]?.count ?? 0)
    },

    async listAttachments(disputeId) {
      const result = await db.execute(sql`
        SELECT a.id, a.dispute_id, a.uploader_id, a.object_key, a.mime_type, a.size_bytes,
               a.width, a.height, a.content_digest, a.created_at, u.nickname AS uploader_nickname
        FROM dispute_attachments a
        JOIN users u ON u.id = a.uploader_id
        WHERE a.dispute_id = ${disputeId}
        ORDER BY a.created_at ASC, a.id ASC
      `)
      return rowsOf(result).map(attachmentFromRow)
    },

    async insertAttachment(input, limit) {
      return await db.transaction(async (tx) => {
        const attachmentColumns = sql`SELECT a.id, a.dispute_id, a.uploader_id, a.object_key,
               a.mime_type, a.size_bytes, a.width, a.height, a.content_digest, a.created_at,
               u.nickname AS uploader_nickname
        FROM dispute_attachments a
        JOIN users u ON u.id = a.uploader_id`
        // 先看键是否已登记：重复确认必须仍然幂等，哪怕那时已经到上限。
        const existing = rowsOf(
          await tx.execute(sql`${attachmentColumns} WHERE a.object_key = ${input.objectKey}`),
        )[0]
        if (existing) {
          return { kind: 'duplicate' as const, attachmentId: attachmentFromRow(existing).id }
        }
        // 把争议行锁住：同一争议上的并发确认被串行化，状态校验与计数都在锁内做 ——
        // 计数靠行锁才是真上限（只靠 `INSERT … SELECT … WHERE (SELECT count(*)) < n` 在
        // READ COMMITTED 下两个并发语句仍可能同时看到 n-1 行）。
        const locked = rowsOf(
          await tx.execute(
            sql`SELECT status::text AS status FROM disputes WHERE id = ${input.disputeId} FOR UPDATE`,
          ),
        )[0]
        if (!locked) return { kind: 'not-found' as const, attachmentId: null }
        // service 里的 `requirePending` 读的是请求开始时的快照，读完字节可能已经过去几百毫秒，
        // 期间管理员 resolve / 发起人 withdraw 都可能发生。终态争议不能再加材料，只能在这里拦。
        if (String(locked.status) !== 'PENDING') {
          return { kind: 'not-pending' as const, attachmentId: null }
        }
        const counted = rowsOf(
          await tx.execute(
            sql`SELECT count(*)::int AS count FROM dispute_attachments WHERE dispute_id = ${input.disputeId}`,
          ),
        )[0]
        if (Number(counted?.count ?? 0) >= limit) {
          return { kind: 'limit' as const, attachmentId: null }
        }
        const inserted = await tx.execute(sql`
          INSERT INTO dispute_attachments
            (id, dispute_id, uploader_id, object_key, mime_type, size_bytes, width, height,
             content_digest)
          VALUES (${input.id}, ${input.disputeId}, ${input.uploaderId}, ${input.objectKey},
                  ${input.mimeType}, ${input.sizeBytes}, ${input.width}, ${input.height},
                  ${input.contentDigest})
          ON CONFLICT (object_key) DO NOTHING
          RETURNING id
        `)
        const row = rowsOf(inserted)[0]
        if (row) return { kind: 'created' as const, attachmentId: String(row.id) }
        // 并发下另一个请求刚插了同一个键：返回既有行，不报错。
        const raced = rowsOf(
          await tx.execute(sql`${attachmentColumns} WHERE a.object_key = ${input.objectKey}`),
        )[0]
        if (!raced) throw new Error('附件重复但未找到既有行（唯一索引异常）')
        return { kind: 'duplicate' as const, attachmentId: attachmentFromRow(raced).id }
      })
    },

    async findAttachmentByObjectKey(objectKey) {
      const result = await db.execute(sql`
        SELECT a.id, a.dispute_id, a.uploader_id, a.object_key, a.mime_type, a.size_bytes,
               a.width, a.height, a.content_digest, a.created_at, u.nickname AS uploader_nickname
        FROM dispute_attachments a
        JOIN users u ON u.id = a.uploader_id
        WHERE a.object_key = ${objectKey}
      `)
      const row = rowsOf(result)[0]
      return row ? attachmentFromRow(row) : null
    },

    async findAttachmentById(attachmentId) {
      const result = await db.execute(sql`
        SELECT a.id, a.dispute_id, a.uploader_id, a.object_key, a.mime_type, a.size_bytes,
               a.width, a.height, a.content_digest, a.created_at, u.nickname AS uploader_nickname
        FROM dispute_attachments a
        JOIN users u ON u.id = a.uploader_id
        WHERE a.id = ${attachmentId}
      `)
      const row = rowsOf(result)[0]
      return row ? attachmentFromRow(row) : null
    },

    async countEvidence(disputeId) {
      const result = await db.execute(sql`
        SELECT count(*)::int AS count FROM dispute_evidence_messages WHERE dispute_id = ${disputeId}
      `)
      return Number(rowsOf(result)[0]?.count ?? 0)
    },

    async listEvidence(disputeId) {
      const result = await db.execute(sql`
        SELECT e.id, e.dispute_id, e.message_id, e.added_by, e.created_at,
               au.nickname AS adder_nickname,
               m.type::text AS message_type, m.sender_id AS message_sender_id,
               ms.nickname AS message_sender_nickname, m.content AS message_content,
               m.recalled_at AS message_recalled_at, m.created_at AS message_created_at
        FROM dispute_evidence_messages e
        JOIN users au ON au.id = e.added_by
        JOIN messages m ON m.id = e.message_id
        LEFT JOIN users ms ON ms.id = m.sender_id
        WHERE e.dispute_id = ${disputeId}
        ORDER BY e.created_at ASC, e.id ASC
      `)
      return rowsOf(result).map(evidenceFromRow)
    },

    async findEvidenceCandidate(disputeId, messageId) {
      // 会话由交易推导：`conversations` 的唯一键是 (listing_id, buyer_id)，交易上不存会话 id。
      // 这条 JOIN 就是「只能关联本交易的聊天」的全部实现。
      const result = await db.execute(sql`
        SELECT m.id AS message_id, m.type::text AS message_type,
               m.sender_id AS message_sender_id, ms.nickname AS message_sender_nickname,
               m.content AS message_content, m.recalled_at AS message_recalled_at,
               m.created_at AS message_created_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN disputes d ON d.id = ${disputeId}
        JOIN transactions t ON t.id = d.transaction_id
        LEFT JOIN users ms ON ms.id = m.sender_id
        WHERE m.id = ${messageId}
          AND c.listing_id = t.listing_id
          AND c.buyer_id = t.buyer_id
          -- plan §4 第 4 条：只有买卖双方或 SYSTEM 的消息能升格为证据。当前会话层已经限制了
          -- 发送者（只有双方能发、SYSTEM 由服务端写），这里是纵深防御。
          AND (m.sender_id IN (t.buyer_id, t.seller_id) OR m.sender_id IS NULL)
      `)
      const row = rowsOf(result)[0]
      if (!row) return null
      return {
        messageId: String(row.message_id),
        messageType: String(row.message_type),
        messageSenderId: (row.message_sender_id as string | null) ?? null,
        messageSenderNickname: (row.message_sender_nickname as string | null) ?? null,
        messageContent: String(row.message_content),
        messageRecalledAt: toNullableDate(row.message_recalled_at),
        messageCreatedAt: toDate(row.message_created_at),
      }
    },

    async findEvidenceRow(disputeId, messageId) {
      const result = await db.execute(sql`
        SELECT e.id, e.dispute_id, e.message_id, e.added_by, e.created_at,
               au.nickname AS adder_nickname,
               m.type::text AS message_type, m.sender_id AS message_sender_id,
               ms.nickname AS message_sender_nickname, m.content AS message_content,
               m.recalled_at AS message_recalled_at, m.created_at AS message_created_at
        FROM dispute_evidence_messages e
        JOIN users au ON au.id = e.added_by
        JOIN messages m ON m.id = e.message_id
        LEFT JOIN users ms ON ms.id = m.sender_id
        WHERE e.dispute_id = ${disputeId} AND e.message_id = ${messageId}
      `)
      const row = rowsOf(result)[0]
      return row ? evidenceFromRow(row) : null
    },

    async insertEvidence(input) {
      return await db.transaction(async (tx) => {
        // 与附件同理：service 的 PENDING 判断是请求开始时的快照，读完消息、校验完会话归属之后
        // 争议可能已被处理。终态争议不能再加材料，只能在行锁内拦（审查 P1-1）。
        const locked = rowsOf(
          await tx.execute(
            sql`SELECT status::text AS status FROM disputes WHERE id = ${input.disputeId} FOR UPDATE`,
          ),
        )[0]
        if (!locked) return { kind: 'not-found' as const, evidenceId: null }
        if (String(locked.status) !== 'PENDING') {
          return { kind: 'not-pending' as const, evidenceId: null }
        }
        const inserted = await tx.execute(sql`
          INSERT INTO dispute_evidence_messages (id, dispute_id, message_id, added_by)
          VALUES (${newId()}, ${input.disputeId}, ${input.messageId}, ${input.addedBy})
          ON CONFLICT (dispute_id, message_id) DO NOTHING
          RETURNING id
        `)
        const row = rowsOf(inserted)[0]
        if (row) return { kind: 'created' as const, evidenceId: String(row.id) }
        const existing = rowsOf(
          await tx.execute(sql`
            SELECT id FROM dispute_evidence_messages
            WHERE dispute_id = ${input.disputeId} AND message_id = ${input.messageId}
          `),
        )[0]
        if (!existing) throw new Error('证据重复但未找到既有行（唯一索引异常）')
        return { kind: 'duplicate' as const, evidenceId: String(existing.id) }
      })
    },

    async withdrawDispute(input) {
      return db.transaction(async (tx) => {
        const updated = await tx.execute(sql`
          UPDATE disputes
          SET status = 'WITHDRAWN', withdrawn_at = now(), updated_at = now()
          WHERE id = ${input.disputeId}
            AND status = 'PENDING'
            AND initiator_id = ${input.initiatorId}
          RETURNING id, transaction_id, respondent_id
        `)
        const row = rowsOf(updated)[0]
        if (!row) return 'conflict' as const
        // 撤回也要让对方知道（否则对方会一直以为争议还挂着）。与状态变更同事务。
        await notify?.(tx, {
          userId: String(row.respondent_id),
          disputeId: input.disputeId,
          transactionId: String(row.transaction_id),
          event: 'WITHDRAWN',
        })
        return 'applied' as const
      })
    },

    async resolveDispute(input) {
      return db.transaction(async (tx) => {
        // 条件更新：只有仍 PENDING 的单子能被处理。另一个管理员已经处理过 → 0 行 →
        // 重读区分「不存在」与「已被处理」，给调用方确定的结果（不抛、不猜）。
        const updated = await tx.execute(sql`
          UPDATE disputes
          SET status = 'RESOLVED',
              resolution = ${input.resolution}::dispute_resolution,
              resolution_note = ${input.reason},
              handled_by = ${input.actorUserId},
              handled_at = now(),
              updated_at = now()
          WHERE id = ${input.disputeId} AND status = 'PENDING'
          RETURNING id, transaction_id, initiator_id, respondent_id
        `)
        const updatedRow = rowsOf(updated)[0]
        if (!updatedRow) {
          const existing = await tx.execute(sql`
            SELECT id FROM disputes WHERE id = ${input.disputeId}
          `)
          return rowsOf(existing).length > 0 ? ('conflict' as const) : ('not-found' as const)
        }

        // 审计与业务同事务：处理争议是管理动作，必须有可回查的记录。
        // 注意这里**不**写 transactions / listings，也不调治理 —— 处理争议不改变成交事实，
        // 也不执行处罚（票面验收第 6 条）。
        await tx.insert(adminAuditLogs).values({
          id: newId(),
          actorUserId: input.actorUserId,
          action: 'DISPUTE_DECISION' satisfies AdminAuditAction,
          targetType: 'DISPUTE' satisfies AdminAuditTargetType,
          targetId: input.disputeId,
          before: jsonParam({ status: 'PENDING' }),
          after: jsonParam({
            status: 'RESOLVED',
            resolution: input.resolution,
            transactionId: String(updatedRow.transaction_id),
            initiatorId: String(updatedRow.initiator_id),
            respondentId: String(updatedRow.respondent_id),
          }),
          reason: input.reason,
        })

        // 结论对**双方**都有意义（管理员不是当事人），所以两边各写一条；与状态变更同事务。
        for (const userId of [String(updatedRow.initiator_id), String(updatedRow.respondent_id)]) {
          await notify?.(tx, {
            userId,
            disputeId: input.disputeId,
            transactionId: String(updatedRow.transaction_id),
            event: 'RESOLVED',
            resolution: input.resolution,
          })
        }
        return 'applied' as const
      })
    },
  }
}
