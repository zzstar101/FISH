import {
  type AdminDisputeDetail,
  AdminDisputeDetailSchema,
  type AdminDisputeItem,
  AdminDisputeItemSchema,
  type AdminDisputeListResponse,
  AdminDisputeListResponseSchema,
  type AdminDisputeQueueQuery,
  type AdminDisputeResolveInput,
  DISPUTE_WINDOW_DAYS,
  type DisputeAttachment,
  type DisputeAttachmentConfirmRequest,
  type DisputeAttachmentConfirmResponse,
  type DisputeAttachmentPresignRequest,
  type DisputeAttachmentPresignResponse,
  type DisputeCreateResponse,
  type DisputeDetail,
  DisputeDetailSchema,
  type DisputeErrorCode,
  type DisputeEvidence,
  type DisputeEvidenceResponse,
  type DisputeListResponse,
  DisputeListResponseSchema,
  type DisputeMineQuery,
  DisputeSchema,
  type DisputeTransactionSummary,
  type DisputeType,
  type DisputeUserSummary,
  MAX_DISPUTE_ATTACHMENTS,
} from '@fish/contracts/disputes/schema'
import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import type { SystemErrorCode } from '@fish/contracts/system/error'
import { newId } from '@fish/db/ids'
import { sniffImageMime } from '@fish/shared/image-mime'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from '../admin/cursor'
import { probeImage } from '../messages/media-probe'
import {
  contentDigestOf,
  disputeMediaObjectKey,
  disputeMediaPrefix,
  parseDisputeMediaKey,
} from '../uploads/dispute-media'
import type { MediaStorage } from '../uploads/storage'
import type {
  DisputeAdminRow,
  DisputeAttachmentRow,
  DisputeEvidenceRow,
  DisputeJoinedRow,
  DisputeStore,
  DisputeTransactionRow,
  DisputeUserRow,
} from './store'

/**
 * Disputes service（#465）：权限校验之后 + 数据层之前的业务编排。
 *
 * 边界（票面「不做」）：
 * - 处理争议**只写争议行与审计行**，不改 `transactions.status` / `listings.status`，
 *   也不触发任何治理动作（封禁 / 下架）。成交事实不受影响。
 * - 没有申诉：`RESOLVED` 与 `WITHDRAWN` 都是终态，行不可复活（前端文案「结论为最终结论」）。
 * - 不做平台支付 / 退款 / 资金托管 / 自动裁定责任。
 */

/**
 * 争议域的业务异常。
 *
 * `code` 除了 `DisputeErrorCodeSchema` 里的争议域错误码，还允许 system 域的
 * `VALIDATION_FAILED`（非法 cursor）：与 reports / listings 同款取舍——各 domain 只声明
 * **新增**的错误码，通用码复用 `system/error.ts`。
 */
export class DisputeServiceError extends Error {
  constructor(
    readonly code: DisputeErrorCode | SystemErrorCode,
    readonly status: 404 | 409 | 422,
    message: string,
  ) {
    super(message)
    this.name = 'DisputeServiceError'
  }
}

/**
 * 交易终态后的发起窗口：**从契约常量派生**（`DISPUTE_WINDOW_DAYS`），不再另写一份天数。
 * `PENDING_MEETUP` 无时限。契约侧是该口径的唯一定义（客户端文案与错误码同源）。
 */
const WINDOW_MS = DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000

/** 管理端详情里「同交易其它未决争议」的上限（同 reports 的 `RELATED_PENDING_LIMIT`）。 */
const RELATED_PENDING_LIMIT = 20

/**
 * 发起争议的内部命令：`transactionId` 是**已解码的裸 UUID**。
 *
 * 公开 ID ↔ 裸 UUID 的边界与 reports 一致：解码在 router（协议层），service 只认 uuid，
 * 编码在 `toDisputeDto`（回程）。`detailText` 在这里已归一为 `string | null`。
 */
export type CreateDisputeCommand = {
  transactionId: string
  type: DisputeType
  detailText: string | null
}

export interface DisputeService {
  createDispute(viewerId: string, input: CreateDisputeCommand): Promise<DisputeCreateResponse>
  listMine(viewerId: string, query: DisputeMineQuery): Promise<DisputeListResponse>
  getDispute(viewerId: string, disputeId: string): Promise<DisputeDetail>
  withdrawDispute(viewerId: string, disputeId: string): Promise<DisputeDetail>
  presignAttachment(
    viewerId: string,
    disputeId: string,
    input: DisputeAttachmentPresignRequest,
  ): Promise<DisputeAttachmentPresignResponse>
  confirmAttachment(
    viewerId: string,
    disputeId: string,
    input: DisputeAttachmentConfirmRequest,
  ): Promise<DisputeAttachmentConfirmResponse>
  addEvidence(
    viewerId: string,
    disputeId: string,
    input: { messageId: string },
  ): Promise<DisputeEvidenceResponse>
  listAdminDisputes(query: AdminDisputeQueueQuery): Promise<AdminDisputeListResponse>
  getAdminDispute(disputeId: string): Promise<AdminDisputeDetail>
  resolveDispute(input: {
    disputeId: string
    actorUserId: string
    resolution: AdminDisputeResolveInput['resolution']
    reason: string
  }): Promise<void>
}

function notFound(): never {
  // 「不存在」与「无权看」同一个 404：否则越权探测能通过错误码区分出「这条争议存在」。
  throw new DisputeServiceError('DISPUTE_NOT_FOUND', 404, '争议不存在')
}

function invalidCursor(): never {
  throw new DisputeServiceError('VALIDATION_FAILED', 422, 'cursor 无效')
}

/**
 * 附件确认失败统一走 422 `DISPUTE_ATTACHMENT_INVALID`（客户端只需提示"重新上传"，
 * 不需要按原因分支）。函数声明 + `never` 返回类型让 TS 在调用点收窄 `stat`/`bytes` 的可空性。
 */
function attachmentInvalid(message: string): never {
  throw new DisputeServiceError('DISPUTE_ATTACHMENT_INVALID', 422, message)
}

/** 附件张数上限。真正的判定在 `store.insertAttachment` 的锁内（先查后插挡不住并发）。 */
function attachmentLimit(): never {
  throw new DisputeServiceError(
    'DISPUTE_ATTACHMENT_LIMIT',
    422,
    `最多上传 ${MAX_DISPUTE_ATTACHMENTS} 张图片`,
  )
}

function toUserSummary(row: DisputeUserRow): DisputeUserSummary {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, row.id),
    nickname: row.nickname,
  }
}

function toTransactionSummary(row: DisputeTransactionRow): DisputeTransactionSummary {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.transaction, row.id),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
    listingTitle: row.listingTitle,
    buyer: toUserSummary(row.buyer),
    seller: toUserSummary(row.seller),
    amountCents: row.amountCents,
    status: row.status,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toDisputeDto(row: DisputeJoinedRow) {
  return DisputeSchema.parse({
    id: encodePublicId(PUBLIC_ID_PREFIX.dispute, row.dispute.id),
    type: row.dispute.type,
    status: row.dispute.status,
    detailText: row.dispute.detailText,
    initiator: toUserSummary(row.initiator),
    respondent: toUserSummary(row.respondent),
    transaction: toTransactionSummary(row.transaction),
    resolution: row.dispute.resolution,
    resolutionNote: row.dispute.resolutionNote,
    handledBy: row.handler ? toUserSummary(row.handler) : null,
    handledAt: row.dispute.handledAt ? row.dispute.handledAt.toISOString() : null,
    withdrawnAt: row.dispute.withdrawnAt ? row.dispute.withdrawnAt.toISOString() : null,
    createdAt: row.dispute.createdAt.toISOString(),
    updatedAt: row.dispute.updatedAt.toISOString(),
  })
}

function toEvidenceDto(row: DisputeEvidenceRow): DisputeEvidence {
  return {
    message: {
      id: encodePublicId(PUBLIC_ID_PREFIX.message, row.messageId),
      type: row.messageType as DisputeEvidence['message']['type'],
      senderId: row.messageSenderId
        ? encodePublicId(PUBLIC_ID_PREFIX.user, row.messageSenderId)
        : null,
      senderNickname: row.messageSenderNickname,
      // 撤回只影响聊天读侧（messages 域会把 content 置空），不影响已固定为证据的这一份：
      // 关联动作本身记录的是「当时说过这句话」，撤回后仍然可读，否则争议双方可以撤回证据。
      content: row.messageContent,
      recalledAt: row.messageRecalledAt ? row.messageRecalledAt.toISOString() : null,
      createdAt: row.messageCreatedAt.toISOString(),
    },
    addedBy: {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.addedBy),
      nickname: row.adderNickname,
    },
    createdAt: row.createdAt.toISOString(),
  }
}

/** 交易终态后超过 `DISPUTE_WINDOW_DAYS` 天即关闭发起窗口；`PENDING_MEETUP` 无时限。 */
function isWindowClosed(transaction: DisputeTransactionRow, now: number): boolean {
  const closedAt = transaction.completedAt ?? transaction.cancelledAt
  if (!closedAt) return false
  return now - closedAt.getTime() > WINDOW_MS
}

export function createDisputeService(options: {
  store: DisputeStore
  storage: MediaStorage
  /** 测试注入用；默认 `Date.now`。 */
  now?: () => number
}): DisputeService {
  const { store, storage } = options
  const now = options.now ?? Date.now

  function toAttachmentDto(row: DisputeAttachmentRow): DisputeAttachment {
    return {
      id: encodePublicId(PUBLIC_ID_PREFIX.media, row.id),
      // 私有前缀 → 短期签名 capability URL（见 storage.publicUrl / GET /uploads/dispute-media/:token）。
      // 令牌里带上确认时刻的字节摘要：预签名 URL 在有效期内可重复 PUT，读侧靠它拒发被换过的对象。
      url: storage.publicUrl(row.objectKey, { contentDigest: row.contentDigest }),
      mimeType: row.mimeType as DisputeAttachment['mimeType'],
      sizeBytes: row.sizeBytes,
      width: row.width,
      height: row.height,
      uploadedBy: {
        id: encodePublicId(PUBLIC_ID_PREFIX.user, row.uploaderId),
        nickname: row.uploaderNickname,
      },
      createdAt: row.createdAt.toISOString(),
    }
  }

  async function loadDetail(row: DisputeJoinedRow): Promise<DisputeDetail> {
    // 详情页是唯一的附件 / 证据出口，列表不内联（否则每行都要多两次查询）。
    const [attachments, evidence] = await Promise.all([
      store.listAttachments(row.dispute.id),
      store.listEvidence(row.dispute.id),
    ])
    return DisputeDetailSchema.parse({
      ...toDisputeDto(row),
      attachments: attachments.map(toAttachmentDto),
      evidence: evidence.map(toEvidenceDto),
    })
  }

  /** 可见性 + 存在性的唯一入口：不可见与不存在都是 404 `DISPUTE_NOT_FOUND`。 */
  async function requireVisible(disputeId: string, viewerId: string): Promise<DisputeJoinedRow> {
    const row = await store.findDispute(disputeId, viewerId)
    if (!row) notFound()
    return row
  }

  function notPending(): never {
    throw new DisputeServiceError('DISPUTE_NOT_PENDING', 409, '争议已处理或已撤回，不能再补充材料')
  }

  /** 附件与证据只允许在未决阶段追加：结论出来之后材料不再变化，避免事后翻案。 */
  function requirePending(row: DisputeJoinedRow): void {
    if (row.dispute.status !== 'PENDING') notPending()
  }

  /**
   * 只有**发起人**能往争议里补材料（plan §3 presign 行、§4 校验链第 1 条冻结）。
   *
   * 被诉方能看到全部材料与结论，但写入面收在发起人一侧：否则被诉方可以占用双方共享的
   * 6 张附件额度，把针对自己的争议塞满（审查 P2-1）。非发起人返回与「不存在」同码的 404，
   * 不泄漏争议存在性。
   */
  function requireInitiator(row: DisputeJoinedRow, viewerId: string): void {
    if (row.dispute.initiatorId !== viewerId) notFound()
  }

  function toAdminItem(row: DisputeAdminRow): AdminDisputeItem {
    return AdminDisputeItemSchema.parse({
      dispute: toDisputeDto(row),
      attachmentCount: row.attachmentCount,
      evidenceCount: row.evidenceCount,
      disputeCount: row.disputeCount,
    })
  }

  return {
    async createDispute(viewerId, input) {
      // 1) 交易必须真实存在，且调用者是买卖双方之一。非参与人与不存在同码：否则
      //    `txn_` id 可以被外人用来枚举「这笔交易是否成立」。
      const transaction = await store.findTransactionForViewer(input.transactionId, viewerId)
      if (!transaction) {
        throw new DisputeServiceError(
          'DISPUTE_TRANSACTION_NOT_FOUND',
          404,
          '交易不存在或你不是该交易的参与人',
        )
      }

      // 2) 终态交易有 `DISPUTE_WINDOW_DAYS` 天窗口；PENDING_MEETUP 期间随时可以发起。
      if (isWindowClosed(transaction, now())) {
        throw new DisputeServiceError(
          'DISPUTE_WINDOW_CLOSED',
          409,
          `交易结束已超过 ${DISPUTE_WINDOW_DAYS} 天，无法再发起争议`,
        )
      }

      // 3) 被诉方由交易**推导**：发起人是买家则被诉方是卖家，反之亦然。
      //    请求体里没有这个字段，所以"把争议指向别人"在协议层就不可表达。
      const respondentId =
        transaction.buyer.id === viewerId ? transaction.seller.id : transaction.buyer.id

      const result = await store.insertDispute({
        transactionId: transaction.id,
        initiatorId: viewerId,
        respondentId,
        type: input.type,
        detailText: input.detailText,
      })

      // 4) 无论新建还是命中既有未决争议，都返回同一形状（重复提交对客户端无感）。
      //    被诉方的通知由 store 在**插入的同一事务**里写（plan 冻结值）。
      const row = await requireVisible(result.disputeId, viewerId)

      return { dispute: await loadDetail(row), created: result.kind === 'created' }
    },

    async listMine(viewerId, query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.dispute) : null
      if (query.cursor && !cursor) invalidCursor()

      // 多取一条判断 hasMore：与 reports / admin 队列同一口径，避免额外 count 查询。
      const rows = await store.listMine({ viewerId, cursor, limit: query.limit + 1 })
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)
      const nextCursor =
        hasMore && last
          ? encodeCursor(last.dispute.createdAtCursor, last.dispute.id, PUBLIC_ID_PREFIX.dispute)
          : null

      // 列表行**不带**附件与证据（详情才有），因此这里只做 DisputeSchema 一次构造。
      return DisputeListResponseSchema.parse({
        items: page.map(toDisputeDto),
        nextCursor,
      })
    },

    async getDispute(viewerId, disputeId) {
      return loadDetail(await requireVisible(disputeId, viewerId))
    },

    async withdrawDispute(viewerId, disputeId) {
      const row = await requireVisible(disputeId, viewerId)
      // 撤回是**发起人独有**的动作。对被诉方来说这个动作不存在（不是"被拒绝"），
      // 因此同样回 404，不给出「你无权撤回」这种区分。
      if (row.dispute.initiatorId !== viewerId) notFound()
      if (row.dispute.status !== 'PENDING') {
        throw new DisputeServiceError('DISPUTE_NOT_PENDING', 409, '该争议已处理或已撤回')
      }

      const result = await store.withdrawDispute({ disputeId, initiatorId: viewerId })
      if (result === 'conflict') {
        // 条件更新 0 行 = 并发中已被处理 / 已被另一个标签页撤回。先到先得。
        throw new DisputeServiceError('DISPUTE_NOT_PENDING', 409, '该争议已处理或已撤回')
      }

      // 被诉方的 WITHDRAWN 通知由 store 在撤回的同一事务里写。
      return loadDetail(await requireVisible(disputeId, viewerId))
    },

    async presignAttachment(viewerId, disputeId, input) {
      const row = await requireVisible(disputeId, viewerId)
      requireInitiator(row, viewerId)
      requirePending(row)

      // 已确认的附件数（台账行）。
      const count = await store.countAttachments(disputeId)
      if (count >= MAX_DISPUTE_ATTACHMENTS) attachmentLimit()

      // 存储侧配额（审查 P2-2）：只数台账行挡不住「反复 presign + PUT、从不 confirm」——
      // 那条路径不产生行，额度永远用不完，私有前缀可被单账号无限填充。预签名只签
      // 「本人 + 本争议」这一段前缀，所以数这段前缀下的对象数，就能把单个发起人能写进去的
      // 对象真正卡在 6 个以内。`countObjects` 返回 null 表示无法判定（列表失败/实现不支持），
      // 这是成本配额而不是安全边界，因此放行。
      const outstanding = await storage.countObjects?.(disputeMediaPrefix(disputeId, viewerId))
      if (
        outstanding !== null &&
        outstanding !== undefined &&
        outstanding >= MAX_DISPUTE_ATTACHMENTS
      ) {
        attachmentLimit()
      }

      // 键由服务端生成：第三段就是附件行主键，确认时能反解，天然幂等；扩展名由 mime 推导，
      // 绝不由客户端给。归属（disputeId + uploaderId）也直接编码在键里。
      const attachmentId = newId()
      const objectKey = disputeMediaObjectKey(disputeId, viewerId, attachmentId, input.contentType)
      const presigned = storage.presignPut({ key: objectKey, contentType: input.contentType })
      return {
        uploadUrl: presigned.url,
        objectKey,
        headers: presigned.headers,
        expiresAt: presigned.expiresAt,
      }
    },

    async confirmAttachment(viewerId, disputeId, input) {
      const row = await requireVisible(disputeId, viewerId)
      requireInitiator(row, viewerId)

      // 键归属校验：键里的争议与上传者都必须是"这一次请求的这两个人"。外人拿到别人的键
      // 也不能把它登记到另一个争议上（键里的 disputeId 与路径不一致 → 422）。
      const parts = parseDisputeMediaKey(input.objectKey)
      if (!parts || parts.disputeId !== disputeId || parts.uploaderId !== viewerId) {
        throw new DisputeServiceError('DISPUTE_ATTACHMENT_INVALID', 422, '附件对象键不属于本次争议')
      }

      // 幂等路径：同一对象键已经登记过。这里**仍然要读一次字节**核对摘要 ——
      // 预签名 URL 在有效期内可以重复 PUT，若对象被换掉，行上的 digest 就不再代表实际内容，
      // 再确认一次必须被拒（读侧也会因为摘要不符而拒发，见 uploads/router.ts）。
      const existing = await store.findAttachmentById(parts.attachmentId)
      if (existing) {
        if (existing.disputeId !== disputeId || existing.uploaderId !== viewerId) {
          throw new DisputeServiceError('DISPUTE_ATTACHMENT_INVALID', 422, '附件已被占用')
        }
        const bytes = await storage.readMediaBytes?.(input.objectKey, MAX_IMAGE_BYTES)
        if (!bytes || contentDigestOf(bytes) !== existing.contentDigest) {
          throw new DisputeServiceError('DISPUTE_ATTACHMENT_INVALID', 422, '附件内容已被替换')
        }
        return { attachment: toAttachmentDto(existing), created: false }
      }

      try {
        requirePending(row)

        // 提前挡一次给出可读错误；**真正的上限在 insertAttachment 的锁内判定** ——
        // 先查后插挡不住并发（审查 P2-4）。
        const count = await store.countAttachments(disputeId)
        if (count >= MAX_DISPUTE_ATTACHMENTS) throw attachmentLimit()

        const stat = await storage.stat(input.objectKey)
        if (!stat) attachmentInvalid('图片尚未上传完成')
        if (stat.size > MAX_IMAGE_BYTES || stat.size <= 0) attachmentInvalid('图片大小不符合要求')

        // 完整读一次（有界）：stat 与 GET 之间上传方仍可覆盖对象，所以属性一律以实读字节为准。
        const bytes = await storage.readMediaBytes?.(input.objectKey, MAX_IMAGE_BYTES)
        if (!bytes || bytes.length === 0) attachmentInvalid('图片尚未上传完成')
        if (bytes.length > MAX_IMAGE_BYTES) attachmentInvalid('图片大小不符合要求')
        if (bytes.length !== stat.size) attachmentInvalid('图片内容与元数据不一致，请重新上传')

        // 真实类型由魔术字节决定，声明的 mime（编码在键的扩展名里）必须与之一致。
        const sniffed = sniffImageMime(bytes)
        if (!sniffed || sniffed !== parts.mimeType) attachmentInvalid('图片格式不符合要求')
        // 容器里能解析出宽高才收；probe 失败说明字节不是完整的图片文件。
        const probed = probeImage(bytes, sniffed)
        if (!probed) attachmentInvalid('图片格式不符合要求')

        const inserted = await store.insertAttachment(
          {
            id: parts.attachmentId,
            disputeId,
            uploaderId: viewerId,
            objectKey: input.objectKey,
            mimeType: sniffed,
            sizeBytes: bytes.length,
            width: probed.width,
            height: probed.height,
            // 摘要与「确认时刻实际读到的字节」绑定；读地址的令牌带着它。
            contentDigest: contentDigestOf(bytes),
          },
          MAX_DISPUTE_ATTACHMENTS,
        )

        if (inserted.kind === 'limit') throw attachmentLimit()
        // 锁内才发现争议已终态：`requirePending(row)` 读的是请求开始时的快照，而读完字节
        // 可能已经过去几百毫秒。与 `requirePending` 同码，但拦截点在写入之前（审查 P1-1）。
        if (inserted.kind === 'not-pending') notPending()
        if (inserted.kind === 'not-found') notFound()

        const stored = await store.findAttachmentById(inserted.attachmentId ?? '')
        if (!stored) {
          if (inserted.kind === 'duplicate') throw new Error('附件重复但未找到既有行')
          // 落库后立刻读不到：行已被并发删除（理论上不存在）。对象由下面的 catch
          // 统一清掉（它先查台账确认确实没有行），这里不要重复删。
          throw new Error('附件写入后无法读回')
        }
        return { attachment: toAttachmentDto(stored), created: inserted.kind === 'created' }
      } catch (error) {
        // 在没有**台账行**的情况下失败的路径都要把刚 PUT 的对象删掉：只靠 presign 签发、
        // 客户端 PUT、confirm 被拒，对象就永久留在私有前缀里（`dispute-media/` 没有后台 GC）。
        // 先查台账，确认真的没有行才删，避免删掉并发请求刚登记成功的对象。
        const registered = await store.findAttachmentByObjectKey(input.objectKey).catch(() => null)
        if (!registered) await storage.delete?.(input.objectKey).catch(() => undefined)
        throw error
      }
    },

    async addEvidence(viewerId, disputeId, input) {
      const row = await requireVisible(disputeId, viewerId)
      requireInitiator(row, viewerId)
      requirePending(row)

      // 候选校验：消息必须属于**本争议交易推导出的那段会话**（`conversations` 的
      // (listing_id, buyer_id) 唯一键）。不属于 → 与消息不存在同码，不泄漏他人的消息。
      const candidate = await store.findEvidenceCandidate(disputeId, input.messageId)
      if (!candidate) {
        throw new DisputeServiceError(
          'DISPUTE_MESSAGE_NOT_FOUND',
          404,
          '消息不存在或不属于本交易的会话',
        )
      }

      const inserted = await store.insertEvidence({
        disputeId,
        messageId: input.messageId,
        addedBy: viewerId,
      })
      // 读消息、校验会话归属之间同样有窗口，状态在写入前于行锁内复核（审查 P1-1）。
      if (inserted.kind === 'not-pending') notPending()
      if (inserted.kind === 'not-found') notFound()
      const stored = await store.findEvidenceRow(disputeId, input.messageId)
      if (!stored) throw new Error('证据写入后无法读回')
      return { evidence: toEvidenceDto(stored), created: inserted.kind === 'created' }
    },

    async listAdminDisputes(query) {
      const cursor = query.cursor ? decodeCursor(query.cursor, PUBLIC_ID_PREFIX.dispute) : null
      if (query.cursor && !cursor) invalidCursor()

      const rows = await store.listAdminDisputes({
        status: query.status,
        type: query.type,
        q: query.q,
        createdFrom: query.createdFrom ? new Date(query.createdFrom) : undefined,
        createdTo: query.createdTo ? new Date(query.createdTo) : undefined,
        cursor,
        limit: query.limit,
      })
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows
      const last = page.at(-1)
      const nextCursor =
        hasMore && last
          ? encodeCursor(last.dispute.createdAtCursor, last.dispute.id, PUBLIC_ID_PREFIX.dispute)
          : null

      return AdminDisputeListResponseSchema.parse({
        items: page.map(toAdminItem),
        nextCursor,
      })
    },

    async getAdminDispute(disputeId) {
      // 管理员看全量：跳过参与人谓词（`options.admin`）。
      const row = await store.findDispute(disputeId, '', { admin: true })
      if (!row) notFound()

      const [attachments, evidence, related] = await Promise.all([
        store.listAttachments(disputeId),
        store.listEvidence(disputeId),
        store.listRelatedPending(row.dispute.transactionId, disputeId, RELATED_PENDING_LIMIT),
      ])
      const counts = await Promise.all([
        store.countAttachments(disputeId),
        store.countEvidence(disputeId),
        store.countDisputesByTransaction(row.dispute.transactionId),
      ])

      const item: AdminDisputeItem = AdminDisputeItemSchema.parse({
        dispute: toDisputeDto(row),
        attachmentCount: counts[0],
        evidenceCount: counts[1],
        // 详情页的「同交易争议数」与队列同一口径：同交易全部争议（含各终态、含本条），
        // 不受 `related`（只看未决、且封顶 20）影响。
        disputeCount: counts[2],
      })

      return AdminDisputeDetailSchema.parse({
        item,
        attachments: attachments.map(toAttachmentDto),
        evidence: evidence.map(toEvidenceDto),
        related: related.map(toDisputeDto),
      })
    },

    async resolveDispute(input) {
      // 处理前先确认争议存在（管理员可见性跳过参与人校验），否则审计里会出现指向空气的行。
      const row = await store.findDispute(input.disputeId, '', { admin: true })
      if (!row) notFound()

      const result = await store.resolveDispute({
        disputeId: input.disputeId,
        actorUserId: input.actorUserId,
        resolution: input.resolution,
        reason: input.reason,
      })
      if (result === 'not-found') notFound()
      if (result === 'conflict') {
        // 条件更新 0 行 = 已被另一个管理员处理，或已被发起人撤回。先到先得。
        throw new DisputeServiceError('DISPUTE_CONFLICT', 409, '该争议已被处理或已撤回')
      }

      // 结论**双方都要知道**（管理员不是当事人）：两条 RESOLVED 通知由 store 在处理事务里写。
    },
  }
}
