import type { LegacyMediaDecision, LegacyMediaSourceKind } from '@fish/db/legacy-media-audit'
import type { ContentModerationEnv } from '@fish/shared/env'
import { ims } from 'tencentcloud-sdk-nodejs-ims'

/**
 * #694 M8 存量图补审的图片审核出口。
 *
 * worker 不能依赖 `apps/api` 的 provider 模块，这里用官方 IMS SDK 实现同一套硬约束：
 * 失败不放行、只按 `Suggestion` 判定、上游文本不外泄、有界重试。文本审核不在本 job 范围内。
 *
 * 策略号复用现有环境变量，不新增：
 * - 商品图 / 评价图（公开图）→ `TENCENT_IMS_UGC_BIZ_TYPE`
 * - 聊天图 → `TENCENT_IMS_CHAT_BIZ_TYPE`
 * `local` transport 下图片一律 REVIEW（与 API 本地实现一致），不会放行。
 */

const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 200
const IMS_ENDPOINT = 'ims.tencentcloudapi.com'
const DEFAULT_PROTOCOL = 'https:'
const TENCENT_DATA_ID_PATTERN = /^[A-Za-z0-9_@#-]{1,64}$/
const TENCENT_FILE_MD5_PATTERN = /^[0-9a-fA-F]{32}$/
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const UPSTREAM_CODE_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const TRANSPORT_TIMEOUT_PREFIXES = ['network timeout at:', 'The operation timed out'] as const
const TRANSPORT_TIMEOUT_NAMES = new Set(['TimeoutError'])

export type LegacyMediaAuditModerationInput = {
  objectKey: string
  dataId: string
  bytes: Uint8Array
  sourceKind: LegacyMediaSourceKind
}

export type LegacyMediaAuditModerationResult = {
  decision: LegacyMediaDecision
  provider: 'LOCAL' | 'TENCENT_IMS'
  providerRequestId: string | null
  policyVersion: string
  suggestion: 'Pass' | 'Review' | 'Block' | null
  label: string | null
  subLabel: string | null
  score: number | null
  contentDigest: string | null
}

export type LegacyMediaAuditModerator = (
  input: LegacyMediaAuditModerationInput,
) => Promise<LegacyMediaAuditModerationResult>

/** 审核失败：`retryable` 决定入库后是否保留 PENDING 等待下一轮。 */
export class LegacyMediaAuditModerationError extends Error {
  readonly retryable: boolean

  constructor(message: string, options: { retryable: boolean }) {
    super(message)
    this.name = 'LegacyMediaAuditModerationError'
    this.retryable = options.retryable
  }
}

type TencentPayload = {
  Suggestion?: unknown
  Label?: unknown
  SubLabel?: unknown
  Score?: unknown
  RequestId?: unknown
  FileMD5?: unknown
}

type TencentVerdict = {
  decision: LegacyMediaDecision
  suggestion: 'Pass' | 'Review' | 'Block'
  label: string | null
  subLabel: string | null
  score: number | null
  requestId: string | null
  contentDigest: string | null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function sanitizeRequestId(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : null
}

function sanitizeUpstreamCode(value: unknown): string | null {
  return typeof value === 'string' && UPSTREAM_CODE_PATTERN.test(value) ? value : null
}

function classifyFailure(error: unknown): LegacyMediaAuditModerationError {
  const record = isRecord(error) ? error : {}
  const httpCode = typeof record.httpCode === 'number' ? record.httpCode : null
  const upstreamCode = sanitizeUpstreamCode(record.code)

  if (error instanceof SyntaxError || error instanceof TypeError) {
    return new LegacyMediaAuditModerationError('invalid_response', { retryable: true })
  }
  if (httpCode !== null) {
    if (httpCode === 429)
      return new LegacyMediaAuditModerationError('throttled', { retryable: true })
    if (httpCode >= 500)
      return new LegacyMediaAuditModerationError('upstream_error', { retryable: true })
    if (httpCode === 401 || httpCode === 403) {
      // 凭证/权限配置错误是**整批**的问题，不是这张图的问题：按可重试处理，
      // 记录 last_error 后等下一位运维修好配置；重试耗尽才 FAILED，届时可 CLI 重排。
      // 旧实现把 401/403 当不可重试，一次配置漂移就把整批对象永久判死（审查 P1-5）。
      return new LegacyMediaAuditModerationError('configuration', { retryable: true })
    }
    return new LegacyMediaAuditModerationError('upstream_rejected', { retryable: false })
  }
  if (upstreamCode !== null) {
    if (/^(RequestLimitExceeded|LimitExceeded)/.test(upstreamCode)) {
      return new LegacyMediaAuditModerationError('throttled', { retryable: true })
    }
    if (/^(InternalError|FailedOperation)/.test(upstreamCode)) {
      return new LegacyMediaAuditModerationError('upstream_error', { retryable: true })
    }
    if (/^(InvalidParameter|MissingParameter)/.test(upstreamCode)) {
      // 单个对象/请求参数不合法：换一个对象仍然会失败，确定性失败。
      return new LegacyMediaAuditModerationError('configuration', { retryable: false })
    }
    if (/^(AuthFailure|UnauthorizedOperation)/.test(upstreamCode)) {
      // 凭证/授权问题影响整批，修好配置后可继续：可重试。
      return new LegacyMediaAuditModerationError('configuration', { retryable: true })
    }
    return new LegacyMediaAuditModerationError('upstream_rejected', { retryable: false })
  }
  const message = nonEmpty(record.message) ?? ''
  const name = nonEmpty(record.name) ?? ''
  if (
    TRANSPORT_TIMEOUT_NAMES.has(name) ||
    TRANSPORT_TIMEOUT_PREFIXES.some((prefix) => message.startsWith(prefix))
  ) {
    return new LegacyMediaAuditModerationError('timeout', { retryable: true })
  }
  return new LegacyMediaAuditModerationError('network', { retryable: true })
}

function decisionFromSuggestion(suggestion: 'Pass' | 'Review' | 'Block'): LegacyMediaDecision {
  if (suggestion === 'Block') return 'BLOCK'
  if (suggestion === 'Review') return 'REVIEW'
  return 'ALLOW'
}

function verdictFromPayload(payload: unknown): TencentVerdict {
  if (!isRecord(payload)) {
    throw new LegacyMediaAuditModerationError('invalid_response', { retryable: true })
  }
  const suggestion: unknown = payload.Suggestion
  if (suggestion !== 'Pass' && suggestion !== 'Review' && suggestion !== 'Block') {
    throw new LegacyMediaAuditModerationError('invalid_response', { retryable: true })
  }
  const requestId = sanitizeRequestId(payload.RequestId)
  const rawDigest = nonEmpty(payload.FileMD5)
  if (rawDigest !== null && !TENCENT_FILE_MD5_PATTERN.test(rawDigest)) {
    throw new LegacyMediaAuditModerationError('invalid_response', { retryable: true })
  }
  return {
    decision: decisionFromSuggestion(suggestion),
    suggestion,
    label: nonEmpty(payload.Label),
    subLabel: nonEmpty(payload.SubLabel),
    score: typeof payload.Score === 'number' ? payload.Score : null,
    requestId,
    contentDigest: rawDigest === null ? null : rawDigest.toLowerCase(),
  }
}

async function withBoundedRetry<T>(
  run: () => Promise<T>,
  options: { attempts: number; baseDelayMs: number },
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      lastError = error
      const retryable = error instanceof LegacyMediaAuditModerationError && error.retryable
      if (!retryable || attempt >= options.attempts) throw error
      await Bun.sleep(options.baseDelayMs * 2 ** (attempt - 1))
    }
  }
  throw lastError
}

export function createLegacyMediaAuditModerator(
  env: ContentModerationEnv,
  options: { maxAttempts?: number; retryDelayMs?: number } = {},
): LegacyMediaAuditModerator {
  if (env.transport === 'local') {
    return async () => ({
      decision: 'REVIEW',
      provider: 'LOCAL',
      providerRequestId: null,
      policyVersion: 'local',
      suggestion: 'Review',
      label: 'LOCAL_IMAGE_NOT_AUDITED',
      subLabel: null,
      score: null,
      contentDigest: null,
    })
  }

  const protocol = DEFAULT_PROTOCOL
  const client = new ims.v20201229.Client({
    credential: { secretId: env.secretId, secretKey: env.secretKey },
    region: env.region,
    profile: {
      httpProfile: {
        endpoint: IMS_ENDPOINT,
        protocol,
        reqMethod: 'POST',
        reqTimeout: Math.max(1, Math.ceil(DEFAULT_TIMEOUT_MS / 1000)),
      },
    },
  })
  const attempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const baseDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  return async (input) => {
    if (!TENCENT_DATA_ID_PATTERN.test(input.dataId)) {
      throw new LegacyMediaAuditModerationError('invalid_data_id', { retryable: false })
    }
    if (input.bytes.byteLength === 0) {
      throw new LegacyMediaAuditModerationError('empty_image', { retryable: false })
    }
    const policyVersion = input.sourceKind === 'CHAT' ? env.imsChatBizType : env.imsUgcBizType
    const fileContent = Buffer.from(input.bytes).toString('base64')

    const verdict = await withBoundedRetry(
      async () => {
        let payload: TencentPayload
        try {
          payload = await client.ImageModeration({
            FileContent: fileContent,
            BizType: policyVersion,
            DataId: input.dataId,
          })
        } catch (error) {
          throw classifyFailure(error)
        }
        return verdictFromPayload(payload)
      },
      { attempts, baseDelayMs },
    )

    return {
      decision: verdict.decision,
      provider: 'TENCENT_IMS',
      providerRequestId: verdict.requestId,
      policyVersion,
      suggestion: verdict.suggestion,
      label: verdict.label,
      subLabel: verdict.subLabel,
      score: verdict.score,
      contentDigest: verdict.contentDigest,
    }
  }
}
