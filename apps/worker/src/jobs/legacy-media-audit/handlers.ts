import { LegacyMediaAuditJobPayloadSchema } from '@fish/contracts/legacy-media/jobs'
import type { Db } from '@fish/db/client'
import {
  finalizeLegacyMediaAudit,
  findLegacyMediaAuditItem,
  type LegacyMediaDecision,
  markLegacyMediaAuditFailure,
} from '@fish/db/legacy-media-audit'
import { sniffImageMime } from '@fish/shared/image-mime'
import { logErrorEvent, logEvent } from '../../log'
import type { WorkerMediaStorage } from '../../media-storage'
import { InvalidJobPayloadError } from '../invalid-payload-error'
import {
  LegacyMediaAuditModerationError,
  type LegacyMediaAuditModerationResult,
  type LegacyMediaAuditModerator,
} from './moderator'

/**
 * #694 M8：一次补审一个存量对象。
 *
 * 结论先落 `legacy_media_audit_items`，再在同一个事务里落实商品可见性；因此「审核成功但
 * 可见性没改」不会出现。失败只写审计行（PENDING 等下一轮 / FAILED 终止），**不动可见性**：
 * 上游故障时对象保持原来的公开状态，由读路径的 fail-closed 判定兜住未审记录。
 *
 * 日志只打对象键、来源、结论与耗时；绝不打印图片字节、base64 或上游原始响应。
 */

export type LegacyMediaAuditOutcome =
  | { status: 'audited'; decision: LegacyMediaDecision; listingsAffected: number }
  | { status: 'already_audited' }
  | { status: 'missing' }
  | { status: 'invalid_object'; reason: string }
  | { status: 'failed'; reason: string; retryable: boolean; attempts: number | null }

export type LegacyMediaAuditHandlerDeps = {
  db: Db
  storage: Pick<WorkerMediaStorage, 'readBytes'>
  moderator: LegacyMediaAuditModerator
  maxImageBytes: number
  maxAttempts: number
  retryDelayMs: number
}

function sha256Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

function md5Hex(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('md5').update(bytes).digest('hex')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runLegacyMediaAudit(
  deps: LegacyMediaAuditHandlerDeps,
  payload: unknown,
): Promise<LegacyMediaAuditOutcome> {
  const parsed = LegacyMediaAuditJobPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new InvalidJobPayloadError(
      'LEGACY_MEDIA_AUDIT',
      parsed.error.issues.map((issue) => issue.message).join('; '),
    )
  }
  const { objectKey } = parsed.data

  const item = await findLegacyMediaAuditItem(deps.db, objectKey)
  if (!item) {
    logEvent({ event: 'legacy_media_audit.missing', objectKey })
    return { status: 'missing' }
  }
  if (item.auditStatus === 'AUDITED') {
    return { status: 'already_audited' }
  }

  const fail = async (reason: string, retryable: boolean): Promise<LegacyMediaAuditOutcome> => {
    const result = await markLegacyMediaAuditFailure(deps.db, {
      objectKey,
      error: reason,
      retryable,
      maxAttempts: deps.maxAttempts,
      retryDelayMs: deps.retryDelayMs,
    })
    logErrorEvent({
      event: 'legacy_media_audit.failed',
      objectKey,
      sourceKind: item.sourceKind,
      reason,
      retryable,
      attempts: result?.attempts ?? null,
      auditStatus: result?.auditStatus ?? null,
    })
    return {
      status: 'failed',
      reason,
      retryable,
      attempts: result?.attempts ?? null,
    }
  }

  let bytes: Uint8Array | null = null
  try {
    bytes = await deps.storage.readBytes(objectKey, deps.maxImageBytes)
  } catch (error) {
    // 读存储的瞬时故障（网络 / 超时 / 5xx / 限流 / 权限抖动）：必须走退避重试，
    // 否则一次上游抖动就把整批对象永久判死（审查 P1-5）。
    logErrorEvent({
      event: 'legacy_media_audit.storage_read_error',
      objectKey,
      sourceKind: item.sourceKind,
      message: errorMessage(error),
    })
    return fail('storage_read_failed', true)
  }
  if (!bytes) {
    // 对象不存在是确定性失败：同一份字节再读一次也不会出现，重试只会刷日志。
    return fail('object_unavailable', false)
  }
  if (bytes.byteLength > deps.maxImageBytes) {
    // readBytes 多读 1 字节用于区分「恰好到上限」与「超限」；超限对象不送 IMS。
    return fail('image_too_large', false)
  }
  const mimeType = sniffImageMime(bytes)
  if (!mimeType) {
    return fail('unsupported_image', false)
  }

  const contentDigest = sha256Hex(bytes)
  const dataId = `legacy_${contentDigest.slice(0, 48)}`

  let moderation: LegacyMediaAuditModerationResult
  try {
    moderation = await deps.moderator({
      objectKey,
      dataId,
      bytes,
      sourceKind: item.sourceKind,
    })
  } catch (error) {
    const retryable = error instanceof LegacyMediaAuditModerationError ? error.retryable : true
    return fail(errorMessage(error), retryable)
  }

  // IMS 返回的 FileMD5 是它实际收到的字节摘要；与本地 MD5 对不上说明中间被截断/替换，
  // 此时任何结论都不能信，按不可重试失败处理（对象保持未审状态，读路径继续 fail-closed）。
  if (moderation.contentDigest !== null && moderation.contentDigest !== md5Hex(bytes)) {
    return fail('content_digest_mismatch', false)
  }

  const result = await finalizeLegacyMediaAudit(deps.db, {
    objectKey,
    sourceKind: item.sourceKind,
    decision: moderation.decision,
    provider: moderation.provider,
    providerRequestId: moderation.providerRequestId,
    policyVersion: moderation.policyVersion,
    suggestion: moderation.suggestion,
    label: moderation.label,
    subLabel: moderation.subLabel,
    score: moderation.score,
    contentDigest,
    sizeBytes: bytes.byteLength,
    mimeType,
  })

  if (result.status === 'audited') {
    logEvent({
      event: 'legacy_media_audit.audited',
      objectKey,
      sourceKind: item.sourceKind,
      decision: result.decision,
      listingsAffected: result.listingsAffected,
    })
  }

  if (result.status === 'already_audited') return { status: 'already_audited' }
  if (result.status === 'missing') return { status: 'missing' }
  return {
    status: 'audited',
    decision: moderation.decision,
    listingsAffected: result.listingsAffected,
  }
}
