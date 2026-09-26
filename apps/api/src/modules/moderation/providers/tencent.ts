/**
 * 腾讯云内容安全 provider（#228）：TMS 审文本、IMS 审图片。
 *
 * 用官方 Node SDK（`tencentcloud-sdk-nodejs-tms` / `-ims`）承载 TC3-HMAC-SHA256 签名与重试无关的
 * 传输细节；Bun 下可用性已在 #228 开工前用本地假上游实测（见 docs/design/issue-228-*.md §2）。
 * 业务层只看到 `ContentModerationProvider`，换签名实现只需改本文件。
 *
 * 三条纪律：
 * 1. **失败不放行**：任何异常/超时/非法响应都抛 `ContentModerationError`，绝不返回 ALLOW。
 * 2. **上游文本不外泄**：SDK 的 `Error.Message`、响应正文都可能回显用户原文，一律不写进错误消息。
 * 3. **Score 不参与判定**：只用 `Suggestion`；Score 原样回带给调用方存档。
 */
import { ims } from 'tencentcloud-sdk-nodejs-ims'
import { tms } from 'tencentcloud-sdk-nodejs-tms'
import type { ModerationField } from '../types'
import { withBoundedRetry } from './retry'
import {
  aggregateModerationDecision,
  ContentModerationError,
  type ContentModerationProvider,
  decisionFromSuggestion,
  type FieldModerationResult,
  isModerationSuggestion,
  type ModerationProviderName,
  type ModerationVerdict,
  sanitizeRequestId,
  sanitizeUpstreamCode,
  suggestionFromDecision,
} from './types'

/** 单次请求超时（毫秒），与 `apps/api/src/modules/ai/provider.ts` 同口径。腾讯 SDK 只接受秒。 */
const DEFAULT_TIMEOUT_MS = 8000
/** 总尝试次数（含首次）：有限重试，不做无上限重试。 */
const DEFAULT_MAX_ATTEMPTS = 3
/** 首次退避毫秒数，之后指数翻倍。 */
const DEFAULT_RETRY_DELAY_MS = 200
const TMS_ENDPOINT = 'tms.tencentcloudapi.com'
const IMS_ENDPOINT = 'ims.tencentcloudapi.com'
const DEFAULT_PROTOCOL = 'https:'
/**
 * 腾讯 IMS `FileContent` 上限 10M（Base64 字符，见 IMS 接口文档）；Base64 按 3 字节 → 4 字符膨胀，
 * 反推原始字节上限。listing 侧 `MAX_IMAGE_BYTES`（packages/contracts/src/listings/schema.ts）是
 * 5MB，正常走不到这里；这道闸门只防「绕过上传链路直接喂大图」。
 */
const TENCENT_IMS_MAX_BASE64_CHARS = 10_000_000
const MAX_IMAGE_BYTES = Math.floor(TENCENT_IMS_MAX_BASE64_CHARS / 4) * 3
/** 腾讯 `DataId` 取值：英文字母、数字、`_` `-` `@` `#`，长度不超过 64。 */
const TENCENT_DATA_ID_PATTERN = /^[A-Za-z0-9_@#-]{1,64}$/
/**
 * 传输层超时的 message 特征。SDK 在 `doRequestWithSign3` 的 catch 里把底层异常拍平成
 * `TencentCloudSDKHttpException(e.message)`，`type`/`name` 全丢，只剩 message 能区分超时与断连：
 * - Node 上 SDK 依赖的真 `node-fetch` v2 用 `network timeout at: <url>`；
 * - Bun 会把 `node-fetch` 解析到内置实现，它用自己的传输超时并抛
 *   `The operation timed out.`，且 `reqTimeout` 被量化（实测 1–3s → ~4s、5–8s → ~8s，
 *   见 `providers/tencent.test.ts` 的超时用例）。
 * 两者都按 `timeout` 归类；分类只影响日志与错误码，**不影响放行与否**（都不放行）。
 */
const TRANSPORT_TIMEOUT_PREFIXES = ['network timeout at:', 'The operation timed out'] as const
const TRANSPORT_TIMEOUT_NAMES = new Set(['TimeoutError'])

/** 腾讯文本/图片响应里本层用到的字段（结构化类型，避免把 SDK 模型类型泄漏到调用方）。 */
type TencentModerationPayload = {
  Suggestion?: string | undefined
  Label?: string | undefined
  SubLabel?: string | undefined
  Score?: number | undefined
  RequestId?: string | undefined
  FileMD5?: string | undefined
}

export type ModerationImageSource = {
  bytes: Uint8Array
  contentType?: string | null
}

/**
 * 读图片字节的注入点：本层不直接碰对象存储（#228 分工里存储接线另行协调），
 * 由调用方注入。返回 null 表示对象不存在——按入参错误处理，不放行。
 */
export type LoadModerationImage = (objectKey: string) => Promise<ModerationImageSource | null>

export type TencentModerationConfig = {
  secretId: string
  secretKey: string
  region: string
  tmsBizType: string
  imsBizType: string
  /** 单次请求超时（毫秒）。默认 8000。 */
  timeoutMs?: number
  /** **仅测试**：把请求指向本地假上游（形如 `127.0.0.1:38211`）；不设则走腾讯线上域名。 */
  endpoint?: string
  /** **仅测试**：配合 `endpoint` 使用，默认 `https:`。 */
  protocol?: string
}

export type TencentModerationOptions = {
  loadImage: LoadModerationImage
  /** **仅测试**：覆盖总尝试次数与首次退避，默认 3 次 / 200ms。 */
  maxAttempts?: number
  retryDelayMs?: number
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 统一决策来自 `Suggestion`；缺失或非枚举值一律按失败处理（**不**默认 ALLOW）。
 * 入参按 `unknown` 收：SDK 理论上必返回对象，但若它返回 `null`/字符串，这里也必须变成
 * `ContentModerationError`（否则会漏出一个裸 `TypeError`，调用方按统一错误类型处理时会落空）。
 */
function verdictFromPayload(payload: unknown, provider: ModerationProviderName): ModerationVerdict {
  if (!isRecord(payload)) {
    throw new ContentModerationError({ reason: 'invalid_response', provider, detail: 'payload' })
  }
  // RequestId 会被调用方写进日志，上游可控：非白名单形状（换行/控制字符）一律置 null。
  const requestId = sanitizeRequestId(payload.RequestId)
  const suggestion: unknown = payload.Suggestion
  if (!isModerationSuggestion(suggestion)) {
    throw new ContentModerationError({
      reason: 'invalid_response',
      provider,
      requestId,
      detail: 'suggestion',
    })
  }
  return {
    decision: decisionFromSuggestion(suggestion),
    suggestion,
    label: nonEmpty(payload.Label),
    subLabel: nonEmpty(payload.SubLabel),
    score: typeof payload.Score === 'number' ? payload.Score : null,
    requestId,
  }
}

/**
 * 腾讯失败 → 统一错误。只做分类，**不搬运任何上游文本**。
 *
 * SDK 的错误形状（`tencentcloud-sdk-nodejs-common` 4.1.220 实读）：
 * - HTTP 非 200 → `httpCode = status`、`message = statusText`、无 `code`；
 * - 200 但 `Response.Error` → `code` + `requestId`、无 `httpCode`；
 * - 传输层（超时/断连）→ 只有 `message`，无 `code`/`httpCode`；
 * - 响应体不是 JSON（或 `Response` 缺失）→ 裸 `SyntaxError` / `TypeError`。
 */
function classifyTencentFailure(
  error: unknown,
  provider: ModerationProviderName,
): ContentModerationError {
  const record = isRecord(error) ? error : {}
  const httpCode = typeof record.httpCode === 'number' ? record.httpCode : null
  const upstreamCode = sanitizeUpstreamCode(record.code)
  const base = { provider, requestId: nonEmpty(record.requestId), httpCode, upstreamCode }

  if (error instanceof SyntaxError || error instanceof TypeError) {
    return new ContentModerationError({ ...base, reason: 'invalid_response', detail: 'payload' })
  }
  if (httpCode !== null) {
    if (httpCode === 429) return new ContentModerationError({ ...base, reason: 'throttled' })
    if (httpCode >= 500) return new ContentModerationError({ ...base, reason: 'upstream_error' })
    if (httpCode === 401 || httpCode === 403) {
      return new ContentModerationError({ ...base, reason: 'configuration' })
    }
    return new ContentModerationError({ ...base, reason: 'upstream_rejected' })
  }
  if (upstreamCode !== null) {
    if (/^(RequestLimitExceeded|LimitExceeded)/.test(upstreamCode)) {
      return new ContentModerationError({ ...base, reason: 'throttled' })
    }
    if (/^(InternalError|FailedOperation)/.test(upstreamCode)) {
      return new ContentModerationError({ ...base, reason: 'upstream_error' })
    }
    if (
      /^(AuthFailure|UnauthorizedOperation|InvalidParameter|MissingParameter)/.test(upstreamCode)
    ) {
      return new ContentModerationError({ ...base, reason: 'configuration' })
    }
    // 未知错误码不当作瞬时故障：宁可少重试，也不把「上游明确拒绝」重放三次。
    return new ContentModerationError({ ...base, reason: 'upstream_rejected' })
  }
  const message = nonEmpty(record.message) ?? ''
  const name = nonEmpty(record.name) ?? ''
  if (
    TRANSPORT_TIMEOUT_NAMES.has(name) ||
    TRANSPORT_TIMEOUT_PREFIXES.some((prefix) => message.startsWith(prefix))
  ) {
    return new ContentModerationError({ ...base, reason: 'timeout' })
  }
  return new ContentModerationError({ ...base, reason: 'network' })
}

function buildFieldDataId(dataId: string, field: ModerationField): string {
  const candidate = `${dataId}-${field}`
  if (!TENCENT_DATA_ID_PATTERN.test(candidate)) {
    throw new ContentModerationError({ reason: 'invalid_input', detail: 'data_id' })
  }
  return candidate
}

export function createTencentContentModerationProvider(
  config: TencentModerationConfig,
  options: TencentModerationOptions,
): ContentModerationProvider {
  const credential = { secretId: config.secretId, secretKey: config.secretKey }
  const protocol = config.protocol ?? DEFAULT_PROTOCOL
  // reqTimeout 单位是秒（common/http/interface.d.ts:64-68），这里向上取整避免配出 0。
  const reqTimeout = Math.max(1, Math.ceil((config.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))
  const tmsClient = new tms.v20201229.Client({
    credential,
    region: config.region,
    profile: {
      httpProfile: {
        endpoint: config.endpoint ?? TMS_ENDPOINT,
        protocol,
        reqMethod: 'POST',
        reqTimeout,
      },
    },
  })
  const imsClient = new ims.v20201229.Client({
    credential,
    region: config.region,
    profile: {
      httpProfile: {
        endpoint: config.endpoint ?? IMS_ENDPOINT,
        protocol,
        reqMethod: 'POST',
        reqTimeout,
      },
    },
  })
  const retryOptions = {
    attempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  }

  async function callTextModeration(value: string, dataId: string): Promise<ModerationVerdict> {
    let payload: TencentModerationPayload
    try {
      payload = await tmsClient.TextModeration({
        Content: Buffer.from(value, 'utf8').toString('base64'),
        BizType: config.tmsBizType,
        DataId: dataId,
      })
    } catch (error) {
      throw classifyTencentFailure(error, 'TENCENT_TMS')
    }
    return verdictFromPayload(payload, 'TENCENT_TMS')
  }

  async function callImageModeration(
    fileContent: string,
    dataId: string,
  ): Promise<{ verdict: ModerationVerdict; contentDigest: string | null }> {
    let payload: TencentModerationPayload
    try {
      payload = await imsClient.ImageModeration({
        FileContent: fileContent,
        BizType: config.imsBizType,
        DataId: dataId,
      })
    } catch (error) {
      throw classifyTencentFailure(error, 'TENCENT_IMS')
    }
    return {
      verdict: verdictFromPayload(payload, 'TENCENT_IMS'),
      contentDigest: nonEmpty(payload.FileMD5),
    }
  }

  return {
    transport: 'tencent',

    async moderateText(input) {
      const auditable = input.fields.filter((item) => item.value.trim().length > 0)
      if (auditable.length === 0) {
        // 没有可审内容却返回 ALLOW 就是一条静默放行路径，直接按入参错误拒绝。
        throw new ContentModerationError({ reason: 'invalid_input', detail: 'no_content' })
      }
      // 先把所有字段的 DataId 渲染 + 校验完，再发第一个请求：否则前一个字段已经真实调用腾讯
      // （计费并产生审核记录）之后，才因为后一个字段的 DataId 越界抛 400——调用方既拿不到
      // 已产生的判定，也无法判断整体是否安全。
      const targets = auditable.map((item) => ({
        field: item.field,
        value: item.value,
        fieldDataId: buildFieldDataId(input.dataId, item.field),
      }))
      const fields: FieldModerationResult[] = []
      // 逐字段串行；任一字段失败即整体抛出，不返回「一半通过」的部分结果。
      for (const target of targets) {
        const verdict = await withBoundedRetry(
          () => callTextModeration(target.value, target.fieldDataId),
          retryOptions,
        )
        fields.push({ ...verdict, field: target.field })
      }
      const decision = aggregateModerationDecision(fields.map((item) => item.decision))
      return {
        provider: 'TENCENT_TMS',
        transport: 'tencent',
        dataId: input.dataId,
        policyVersion: config.tmsBizType,
        decision,
        suggestion: suggestionFromDecision(decision),
        fields,
      }
    },

    async moderateImage(input) {
      // 图片的 DataId 由调用方按「每张图一个标识」传入，本层不加后缀（文本才需要按字段区分）。
      if (!TENCENT_DATA_ID_PATTERN.test(input.dataId)) {
        throw new ContentModerationError({
          reason: 'invalid_input',
          provider: 'TENCENT_IMS',
          detail: 'data_id',
        })
      }
      // 图片字节只读一次：重试只重放 IMS 请求，不重复读 5MB。
      // 读取失败同样是「审核失败」：转成统一错误，调用方才能按 503 处理，而不是漏出一个裸的
      // 存储异常（落到框架 500，丢掉可重试语义）。存储异常文本可能含 bucket/key，一律不回带。
      let source: ModerationImageSource | null
      try {
        source = await options.loadImage(input.objectKey)
      } catch {
        throw new ContentModerationError({
          reason: 'network',
          provider: 'TENCENT_IMS',
          detail: 'image_load',
        })
      }
      if (!source) {
        throw new ContentModerationError({
          reason: 'invalid_input',
          provider: 'TENCENT_IMS',
          detail: 'image_missing',
        })
      }
      if (source.bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new ContentModerationError({
          reason: 'invalid_input',
          provider: 'TENCENT_IMS',
          detail: 'image_too_large',
        })
      }
      const fileContent = Buffer.from(source.bytes).toString('base64')
      const { verdict, contentDigest } = await withBoundedRetry(
        () => callImageModeration(fileContent, input.dataId),
        retryOptions,
      )
      return {
        ...verdict,
        provider: 'TENCENT_IMS',
        transport: 'tencent',
        dataId: input.dataId,
        objectKey: input.objectKey,
        policyVersion: config.imsBizType,
        contentDigest,
        reasonCode: null,
      }
    },
  }
}
