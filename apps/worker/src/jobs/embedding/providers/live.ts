import {
  type EmbeddingFailureReason,
  type EmbeddingProvider,
  EmbeddingProviderError,
} from '@fish/contracts/embedding/provider'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'
import { elapsedMs } from '../../../log'

/**
 * live provider（#322 M1）：OpenAI 兼容的 `/embeddings` 端点。
 *
 * 形状照 `apps/api/src/modules/ai/provider.ts`：裸 `fetch`（不引 SDK）、`AbortSignal.timeout`、
 * 绝不把上游响应体或请求文本写进错误消息（embedding 的入参是愿望/商品全文，日志里不该出现）。
 *
 * **有界重试**（#322 Provider 验收明确要求 timeout + 有界 retry）：超时 / 网络错误 / 429 /
 * 5xx 最多 `EMBEDDING_MAX_ATTEMPTS` 次（含首次）并按 `EMBEDDING_RETRY_BASE_DELAY_MS` 指数退避；
 * 其它 4xx（请求本身错）与非法响应 / 维度不符**不重试**——重发同样会失败，只会多占 worker 一轮。
 * 队列自己还有 3 次重试（`DEFAULT_MAX_ATTEMPTS`，见 `apps/worker/src/jobs/queue.ts`），
 * 每次重试都会重新读实体、重新算指纹，因此这里的重试与队列重试叠加但都各自有界。
 *
 * 失败一律 `fail-closed`：宁可让这条 job 重试/失败，也不返回"看起来合法的空向量"。
 */
export const EMBEDDING_TIMEOUT_MS = 10_000
/** 单次 `embed()` 发起的上游请求上限（含首次）：有界，坏上游不能把 worker 轮询拖死。 */
export const EMBEDDING_MAX_ATTEMPTS = 3
/** 退避基数：第 n 次失败后等 `base * 2^(n-1)`（默认 100ms / 200ms）。 */
export const EMBEDDING_RETRY_BASE_DELAY_MS = 100

export type LiveEmbeddingConfig = {
  baseUrl: string
  apiKey: string
  model: string
  /** 每个实际 HTTP attempt 的 admission；拒绝时 fail-closed，不进入网络重试。 */
  beforeRequest?: () => Promise<void>
  /** 退避基数覆盖，只给测试把等待压到 0 用；生产不传。 */
  retryDelayMs?: number
  /**
   * 每次上游请求结束后的观测回调（#322 M4）。provider 只报**计数与耗时**：条数、尝试序号、
   * 结果分类、失败原因、上游 status；请求文本与响应/向量都不进事件（见 `../../../log`）。
   * 不传 = 不观测，所以 provider 本身仍然可以在测试里裸用。
   */
  onRequest?: (event: EmbeddingRequestEvent) => void
}

/** 一次上游请求的观测事件；一次 `embed()` 可能产生多条（重试）。 */
export type EmbeddingRequestEvent = {
  /** 第几次尝试（含首次），从 1 起。 */
  attempt: number
  durationMs: number
  /** `ok` 成功；`retryable` 失败且会重试；`fatal` 失败且不再重试。 */
  outcome: 'ok' | 'retryable' | 'fatal'
  /** 失败分类（成功为 `null`）；`http_status` 时 `status` 才有值。 */
  reason: EmbeddingFailureReason | null
  status: number | null
  /** 本次请求的文本条数。 */
  texts: number
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function readEmbeddings(payload: unknown, expectedCount: number): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw new EmbeddingProviderError('invalid_response', 'embedding 上游响应不是对象')
  }

  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new EmbeddingProviderError(
      'invalid_response',
      `embedding 上游返回 ${Array.isArray(data) ? data.length : '非数组'} 条，期望 ${expectedCount} 条`,
    )
  }

  return data.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new EmbeddingProviderError('invalid_response', 'embedding 上游响应的条目不是对象')
    }
    const embedding = (item as { embedding?: unknown }).embedding
    if (!Array.isArray(embedding)) {
      throw new EmbeddingProviderError(
        'invalid_response',
        'embedding 上游响应的条目缺少 embedding 数组',
      )
    }
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      // 维度不符是最危险的一种"看起来成功"：它会在写库时被 typmod 拒绝，或者在更晚的
      // 召回阶段变成永远算不出相似度。这里当场失败并说清两侧维度。
      throw new EmbeddingProviderError(
        'dimension_mismatch',
        `embedding 上游返回 ${embedding.length} 维，本服务期望 ${EMBEDDING_DIMENSIONS} 维（见 vector(${EMBEDDING_DIMENSIONS}) 与 EMBEDDING_DIMENSIONS）`,
      )
    }
    if (!embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      throw new EmbeddingProviderError('invalid_response', 'embedding 上游返回的向量包含非有限数值')
    }
    return embedding as number[]
  })
}

/** 一次上游请求 + 响应校验；失败一律抛 `EmbeddingProviderError`（带 retryable 判定）。 */
async function requestEmbeddings(
  config: LiveEmbeddingConfig,
  endpoint: string,
  texts: string[],
): Promise<number[][]> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      // `dimensions` 必须显式发（#322 M4）：多数兼容端点把维度做成可选参数，省略时按**模型默认**
      // 返回（百炼 `text-embedding-v4` 默认 1024），于是每条都栽在 `readEmbeddings` 的
      // `dimension_mismatch` 上——请求是 200、向量也"合法"，只是维度不是本服务的那一列。
      // 这里直接发 `EMBEDDING_DIMENSIONS`（与 `vector(1536)` / CHECK 同一个常量），不做 env 可配：
      // 列类型是编译期常量，可配维度只会造出"配置与列定义不一致"的死法。
      body: JSON.stringify({
        model: config.model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = isAbortError(error)
    throw new EmbeddingProviderError(
      timedOut ? 'timeout' : 'network',
      timedOut ? `embedding 上游超时（${EMBEDDING_TIMEOUT_MS}ms）` : 'embedding 上游网络错误',
    )
  }

  if (!response.ok) {
    // 丢弃响应体：既不解析也不记日志（可能回显错误细节）。
    await response.body?.cancel()
    const status = response.status
    throw new EmbeddingProviderError('http_status', `embedding 上游返回 status=${status}`, {
      status,
      // 429（限流）与 5xx（上游故障）重发有意义；其余 4xx 是请求本身的问题。
      retryable: status === 429 || status >= 500,
    })
  }

  const payload: unknown = await response.json().catch((error: unknown) => {
    const timedOut = isAbortError(error)
    throw new EmbeddingProviderError(
      timedOut ? 'timeout' : 'invalid_response',
      timedOut
        ? `embedding 上游读取响应超时（${EMBEDDING_TIMEOUT_MS}ms）`
        : 'embedding 上游响应不是合法 JSON',
    )
  })

  return readEmbeddings(payload, texts.length)
}

export function createLiveEmbeddingProvider(config: LiveEmbeddingConfig): EmbeddingProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`
  const retryDelayMs = config.retryDelayMs ?? EMBEDDING_RETRY_BASE_DELAY_MS

  /**
   * 观测回调**不得改变 provider 行为**（#322 M4 审查）：回调自己抛错只吞掉。
   * 否则它会落进 `embed()` 的 catch —— 一次成功的上游请求被重新定性成 `fatal`、多发一条
   * 误导性的失败事件、并把 job 判失败。回调由调用方装配（日志出口），它的异常由它自己负责。
   */
  const notify = (event: EmbeddingRequestEvent): void => {
    try {
      config.onRequest?.(event)
    } catch {
      // 刻意静默：观测坏掉不能影响传输。
    }
  }

  return {
    model: config.model,
    dimensions: EMBEDDING_DIMENSIONS,

    async embed(texts) {
      for (let attempt = 1; ; attempt += 1) {
        // 在 retry catch 外等待 admission：预算/限速配置错误不应触发上游重试。
        await config.beforeRequest?.()
        const startedAt = Bun.nanoseconds()
        try {
          const vectors = await requestEmbeddings(config, endpoint, texts)
          notify({
            attempt,
            durationMs: elapsedMs(startedAt),
            outcome: 'ok',
            reason: null,
            status: null,
            texts: texts.length,
          })
          return vectors
        } catch (error) {
          const failure = error instanceof EmbeddingProviderError ? error : null
          const retryable = failure?.retryable ?? false
          // 先按"这次到底会不会重试"定性再上报，免得日志里出现"重试了但其实已经放弃"的读数。
          const willRetry = retryable && attempt < EMBEDDING_MAX_ATTEMPTS
          notify({
            attempt,
            durationMs: elapsedMs(startedAt),
            outcome: willRetry ? 'retryable' : 'fatal',
            reason: failure?.reason ?? null,
            status: failure?.status ?? null,
            texts: texts.length,
          })
          // 不可重试的失败（4xx / 非法响应 / 维度不符）直接冒泡：重发不会变好。
          if (!retryable) throw error
          if (attempt >= EMBEDDING_MAX_ATTEMPTS) throw error
          // 指数退避；`Bun.sleep(0)` 也走同一路径，测试用 retryDelayMs: 0 不真的等。
          await Bun.sleep(retryDelayMs * 2 ** (attempt - 1))
        }
      }
    },
  }
}
