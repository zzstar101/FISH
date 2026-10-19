import type { MessageDto } from '@fish/contracts/chat/schema'
import { DISPUTE_ROUTES } from '@fish/contracts/disputes/routes'
import {
  type DisputeAttachmentConfirmRequest,
  DisputeAttachmentConfirmRequestSchema,
  DisputeAttachmentConfirmResponseSchema,
  type DisputeAttachmentPresignRequest,
  DisputeAttachmentPresignRequestSchema,
  type DisputeAttachmentPresignResponse,
  DisputeAttachmentPresignResponseSchema,
  type DisputeCreateInput,
  type DisputeCreateResponse,
  DisputeCreateResponseSchema,
  type DisputeDetail,
  DisputeDetailSchema,
  type DisputeEvidenceInput,
  DisputeEvidenceInputSchema,
  type DisputeEvidenceResponse,
  DisputeEvidenceResponseSchema,
  type DisputeListResponse,
  DisputeListResponseSchema,
} from '@fish/contracts/disputes/schema'
import { ALLOWED_IMAGE_MIME } from '@fish/contracts/listings/schema'
import { ApiError, apiRequest } from '../../lib/api-client'
import { fetchMessagePage } from '../chat/api'
import { fetchTransaction } from '../profile/api'
import { imagePreparationMessage, toUploadableFile, validateImageFile } from '../publish/api'

/** 「我的争议」单页条数（契约 `DisputeMineQuerySchema.limit` 服务端封顶 50）。 */
export const DISPUTE_PAGE_LIMIT = 20

/** `GET /disputes/mine` 的请求路径（导出便于测试路径与游标拼装）。 */
export function myDisputesPath(cursor?: string, limit = DISPUTE_PAGE_LIMIT): string {
  const params = new URLSearchParams({ limit: String(limit) })
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${DISPUTE_ROUTES.mine}?${params.toString()}`
}

export async function fetchMyDisputes(
  cursor?: string,
  limit = DISPUTE_PAGE_LIMIT,
): Promise<DisputeListResponse> {
  return DisputeListResponseSchema.parse(await apiRequest(myDisputesPath(cursor, limit)))
}

/** 详情：非当事人 / 不存在都是 404 `DISPUTE_NOT_FOUND`（服务端不泄漏存在性）。 */
export async function fetchDispute(disputeId: string): Promise<DisputeDetail> {
  return DisputeDetailSchema.parse(await apiRequest(DISPUTE_ROUTES.detail(disputeId)))
}

/**
 * 发起争议：`201` 新建 / `200` 复用同一交易同一方向的未决争议（`created: false`）。
 *
 * 两者都是**受理成功**（与举报同一契约姿态：超时重试对客户端无感）。调用方都直接进入
 * 详情页，`created` 只用于是否需要提示「已有进行中的争议」。
 */
export async function startDispute(input: DisputeCreateInput): Promise<DisputeCreateResponse> {
  const payload = await apiRequest(DISPUTE_ROUTES.create, {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return DisputeCreateResponseSchema.parse(payload)
}

/** 撤回：服务端返回撤回后的完整详情（含时间线字段），调用方直接替换缓存。 */
export async function withdrawDispute(disputeId: string): Promise<DisputeDetail> {
  return DisputeDetailSchema.parse(
    await apiRequest(DISPUTE_ROUTES.withdraw(disputeId), { method: 'POST' }),
  )
}

/**
 * confirm 阶段失败时，只有「对象明确不可用」才丢弃暂存键；网络错误要保留，
 * 因为服务端可能已经登记成功、只是响应没回来，重试要做幂等确认而不是重新上传。
 */
const STAGED_KEY_UNUSABLE_CODES = new Set<string>([
  'DISPUTE_ATTACHMENT_INVALID',
  'DISPUTE_ATTACHMENT_LIMIT',
  'DISPUTE_NOT_FOUND',
  'DISPUTE_NOT_PENDING',
])

/**
 * PUT 已成功但 confirm 响应丢失时，按争议暂存 objectKey（30 分钟内可幂等重试）。
 *
 * 用 `sessionStorage` 而不是模块级 Map：刷新页面后仍能续传，避免同一张图在
 * 6 张配额里留下孤儿对象。暂存项带**文件指纹**（name/size/lastModified/type）：
 * 只有用户重新选择**同一个文件**时才做幂等 confirm；换了文件就丢弃旧 key 走
 * 完整上传，绝不把上一张图静默确认成这一次的选择。
 *
 * 已知后端缺口：对象存储没有删除端点（孤儿对象会占服务端 presign 配额），
 * 由 #500 跟踪；端上只能减少产生孤儿的机会。
 */
type StagedAttachmentFingerprint = {
  name: string
  size: number
  lastModified: number
  type: string
}

type StagedAttachment = {
  objectKey: string
  expiresAt: number
  fingerprint: StagedAttachmentFingerprint
}

const STAGED_ATTACHMENT_STORAGE_PREFIX = 'fish:web-pc:dispute-attachment:'
const STAGED_ATTACHMENT_TTL_MS = 30 * 60 * 1000

function stagedAttachmentStorageKey(disputeId: string): string {
  return `${STAGED_ATTACHMENT_STORAGE_PREFIX}${disputeId}`
}

/** `sessionStorage` 在隐私模式 / 无 DOM 环境下可能不可用：退化为「本次不续传」。 */
function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function isFingerprint(value: unknown): value is StagedAttachmentFingerprint {
  if (typeof value !== 'object' || value === null) return false
  const fingerprint = value as Partial<StagedAttachmentFingerprint>
  return (
    typeof fingerprint.name === 'string' &&
    typeof fingerprint.size === 'number' &&
    typeof fingerprint.lastModified === 'number' &&
    typeof fingerprint.type === 'string'
  )
}

function isStagedAttachment(value: unknown): value is StagedAttachment {
  if (typeof value !== 'object' || value === null) return false
  const staged = value as Partial<StagedAttachment>
  return (
    typeof staged.objectKey === 'string' &&
    staged.objectKey !== '' &&
    typeof staged.expiresAt === 'number' &&
    isFingerprint(staged.fingerprint)
  )
}

function readStagedAttachment(disputeId: string): StagedAttachment | null {
  const storage = getSessionStorage()
  if (storage === null) return null
  const key = stagedAttachmentStorageKey(disputeId)
  const raw = storage.getItem(key)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    storage.removeItem(key)
    return null
  }
  if (!isStagedAttachment(parsed) || parsed.expiresAt <= Date.now()) {
    storage.removeItem(key)
    return null
  }
  return parsed
}

function rememberStagedAttachment(disputeId: string, objectKey: string, file: File): void {
  const storage = getSessionStorage()
  if (storage === null) return
  const staged: StagedAttachment = {
    objectKey,
    expiresAt: Date.now() + STAGED_ATTACHMENT_TTL_MS,
    fingerprint: fingerprintOf(file),
  }
  try {
    storage.setItem(stagedAttachmentStorageKey(disputeId), JSON.stringify(staged))
  } catch {
    // 存储写满（隐私模式配额）时放弃续传能力，不阻断本次上传。
  }
}

function forgetStagedAttachment(disputeId: string): void {
  getSessionStorage()?.removeItem(stagedAttachmentStorageKey(disputeId))
}

function fingerprintOf(file: File): StagedAttachmentFingerprint {
  return { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type }
}

function sameFingerprint(a: StagedAttachmentFingerprint, b: StagedAttachmentFingerprint): boolean {
  return (
    a.name === b.name && a.size === b.size && a.lastModified === b.lastModified && a.type === b.type
  )
}

async function confirmDisputeAttachment(disputeId: string, objectKey: string): Promise<void> {
  const input: DisputeAttachmentConfirmRequest = DisputeAttachmentConfirmRequestSchema.parse({
    objectKey,
  })
  DisputeAttachmentConfirmResponseSchema.parse(
    await apiRequest(DISPUTE_ROUTES.attachmentConfirm(disputeId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/**
 * 上传一张附件：HEIC→JPG 预处理 → presign → PUT 对象存储 → confirm 写台账。
 *
 * 预处理与其它四处图片上传入口**同一个 helper**（`toUploadableFile` /
 * `imagePreparationMessage`）：浏览器能展示的格式原样上传，HEIC 先转 JPG，
 * 转不了时给「HEIC 图片转换失败」的可区分文案，不把注定 422 的文件送去上传。
 *
 * 三步里任何一步失败都抛给调用方，且**配额/幂等要特别处理**：
 * - 服务端 presign 按「该争议 + 该发起人前缀下的对象数」卡 6 张，重复 presign 会造孤儿对象；
 * - confirm 本身是幂等的（`findAttachmentById` 命中返回 `created:false`）。
 *
 * 所以：每次上传**先**看有没有「同一争议 + 同一文件指纹」的暂存 objectKey，
 * 有才做一次幂等 confirm；成功即清暂存直接返回；对象明确不可用（422/404/409）则丢弃重传。
 * 指纹不一致（用户改选了另一张图）时清掉旧 key，走完整上传 —— 绝不确认旧图。
 * PUT 成功后立刻暂存 key（含指纹，30 分钟），confirm 网络失败时保留给下次重试。
 */
export async function uploadDisputeAttachment(disputeId: string, file: File): Promise<void> {
  const staged = readStagedAttachment(disputeId)
  if (staged !== null) {
    if (sameFingerprint(staged.fingerprint, fingerprintOf(file))) {
      try {
        await confirmDisputeAttachment(disputeId, staged.objectKey)
        forgetStagedAttachment(disputeId)
        return
      } catch (error) {
        if (error instanceof ApiError && STAGED_KEY_UNUSABLE_CODES.has(error.code)) {
          forgetStagedAttachment(disputeId)
        } else {
          throw error
        }
      }
    } else {
      // 用户改选了另一张图：旧 key 不能确认（会把旧图记成这次的选择），
      // 丢弃后走完整上传；旧对象成为孤儿，删除端点由 #500 跟踪。
      forgetStagedAttachment(disputeId)
    }
  }

  const prepared = await toUploadableFile(file)
  if (prepared === null) throw new Error(imagePreparationMessage(file))
  const invalid = validateImageFile(prepared)
  if (invalid !== null) throw new Error(invalid)
  const contentType = (ALLOWED_IMAGE_MIME as readonly string[]).find(
    (mime) => mime === prepared.type,
  )
  if (contentType === undefined) throw new Error('仅支持 JPG / PNG / WebP 图片')

  const presignInput: DisputeAttachmentPresignRequest = DisputeAttachmentPresignRequestSchema.parse(
    {
      contentType,
      sizeBytes: prepared.size,
    },
  )
  const presign: DisputeAttachmentPresignResponse = DisputeAttachmentPresignResponseSchema.parse(
    await apiRequest(DISPUTE_ROUTES.attachmentPresign(disputeId), {
      method: 'POST',
      body: JSON.stringify(presignInput),
    }),
  )

  let uploaded: Response
  try {
    uploaded = await fetch(presign.uploadUrl, {
      body: prepared,
      headers: { ...presign.headers, 'content-type': contentType },
      method: 'PUT',
    })
  } catch {
    throw new Error('图片上传失败，请重试')
  }
  if (!uploaded.ok) throw new Error('图片上传失败，请重试')

  // PUT 成功即暂存：此后 confirm 若网络失败，下一次上传先用这个 key 幂等确认，
  // 不会再 presign 第二个对象白占配额。
  rememberStagedAttachment(disputeId, presign.objectKey, file)
  try {
    await confirmDisputeAttachment(disputeId, presign.objectKey)
    forgetStagedAttachment(disputeId)
  } catch (error) {
    if (error instanceof ApiError && STAGED_KEY_UNUSABLE_CODES.has(error.code)) {
      forgetStagedAttachment(disputeId)
    }
    throw error
  }
}

/** 关联一条聊天消息作为证据（只提交 `msg_` 公开 ID，服务端校验消息归属）。 */
export async function addDisputeEvidence(
  disputeId: string,
  messageId: string,
): Promise<DisputeEvidenceResponse> {
  const input: DisputeEvidenceInput = DisputeEvidenceInputSchema.parse({ messageId })
  return DisputeEvidenceResponseSchema.parse(
    await apiRequest(DISPUTE_ROUTES.evidenceMessages(disputeId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/** 证据选择器需要的一页数据：交易会话 id + 该页消息 + 更早一页的游标。 */
export type DisputeConversation = {
  conversationId: string
  messages: MessageDto[]
  /** null = 已到会话最早一页；否则作为下一次 `before` 原样回传（同聊天历史契约）。 */
  nextCursor: string | null
}

/**
 * 从争议读交易会话：争议摘要里**没有** `conversationId`（契约只给交易 id），
 * 所以先用 `GET /transactions/:id` 拿会话 id，再按会话读消息（口径同任务书）。
 *
 * 返回 `null` 表示交易已不可见（非当事人 / 已删）——端上按空态处理，不伪造消息。
 * 历史接口按 `(createdAt, id)` 升序返回一页并用 `nextCursor` 指向更早一页，所以
 * `before` 分页由调用方（infinite query）负责透传，选择器才能翻到最早的消息。
 *
 * 只返回文本 / 系统消息：聊天接口固定排除 `type='MEDIA'`，且争议证据契约
 * （`DisputeEvidenceMessageSchema`）没有媒体投影字段，图片证据待 #500。
 */
export async function fetchDisputeConversation(
  transactionId: string,
  before?: string,
): Promise<DisputeConversation | null> {
  const transaction = await fetchTransaction(transactionId)
  if (transaction === null) return null
  const page = await fetchMessagePage(transaction.conversationId, before)
  return {
    conversationId: transaction.conversationId,
    messages: page.items,
    nextCursor: page.nextCursor,
  }
}
