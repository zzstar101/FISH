import { EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import type { VisualEmbeddingProvider, VisualImageMime } from '@fish/contracts/visual/provider'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'

/**
 * live 视觉 provider（#324 M3）：阿里云百炼 **DashScope 原生**多模态向量化端点。
 *
 * 为什么不是 OpenAI 兼容 `/embeddings`：多模态向量化**没有** OpenAI 兼容接口，只有
 * `POST {baseUrl}/services/embeddings/multimodal-embedding/multimodal-embedding`，
 * 入参形状也不同（`input.contents[]` 里放 `{image}` / `{text}`，参数在 `parameters` 里）。
 * 仍然走裸 `fetch`（不引 DashScope SDK），失败分类与重试策略与 #322 的文本侧 live provider
 * **完全同构**，因为两边共用 `EmbeddingProviderError`。
 *
 * 图片入参只有两种形式：**公网 URL 或 Base64 data URI**。我们的商品封面虽然落在公开前缀
 * （`listings/*`），但查询图是私有对象、且本机/内网没有公网可达地址，所以统一走 Base64——
 * 这意味着**图片字节必然离开我们的基础设施**，这是 #324 已拍板的出域事实（PR 描述里要写明）。
 *
 * 有界重试：超时 / 网络错误 / 429 / 5xx 最多 `VISUAL_EMBEDDING_MAX_ATTEMPTS` 次（含首次）并按
 * `VISUAL_EMBEDDING_RETRY_BASE_DELAY_MS` 指数退避；其它 4xx 与非法响应 / 维度不符**不重试**。
 * 绝不把上游响应体或图片字节写进错误消息。
 */
export const VISUAL_EMBEDDING_TIMEOUT_MS = 10_000
/** 单次 `embedImage`/`embedText` 发起的上游请求上限（含首次）。 */
export const VISUAL_EMBEDDING_MAX_ATTEMPTS = 3
/** 退避基数：第 n 次失败后等 `base * 2^(n-1)`。 */
export const VISUAL_EMBEDDING_RETRY_BASE_DELAY_MS = 100

/** DashScope 原生路径。`baseUrl` 形如 `https://dashscope.aliyuncs.com/api/v1`。 */
export const MULTIMODAL_EMBEDDING_PATH =
  '/services/embeddings/multimodal-embedding/multimodal-embedding'

export type LiveVisualEmbeddingConfig = {
  baseUrl: string
  apiKey: string
  model: string
  /** 退避基数覆盖，只给测试把等待压到 0 用；生产不传。 */
  retryDelayMs?: number
}

type MultimodalContent = { image: string } | { text: string }

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** 图片 → `data:{mime};base64,{...}`（DashScope 只接公网 URL 或 data URI）。 */
function toDataUri(image: Uint8Array, mime: VisualImageMime): string {
  return `data:${mime};base64,${Buffer.from(image).toString('base64')}`
}

function requestBody(model: string, content: MultimodalContent): string {
  return JSON.stringify({
    model,
    input: { contents: [content] },
    parameters: { dimension: VISUAL_EMBEDDING_DIMENSIONS },
  })
}

/**
 * 从上游响应里取出向量并校验。
 *
 * DashScope 的形状是 `{ output: { embeddings: [{ index, embedding: [...] }] } }`；这里额外接受
 * `{ data: [{ embedding }] }` 这种 OpenAI 风格信封，是因为**只看"有没有一条合法的 1024 维向量"**
 * 就够了：形状走错时任何一个候选都不成立，会当场抛 `invalid_response`，不可能静默取到别的数。
 * 换句话说，兼容信封不降低 fail-closed 强度，只是让上游小改信封时不必同步发版。
 */
function readEmbedding(payload: unknown): number[] {
  const candidates: unknown[] = []

  if (typeof payload === 'object' && payload !== null) {
    const output = (payload as { output?: unknown }).output
    if (typeof output === 'object' && output !== null) {
      const embeddings = (output as { embeddings?: unknown }).embeddings
      if (Array.isArray(embeddings) && embeddings.length > 0) {
        candidates.push(unwrapEmbedding(embeddings[0]))
      }
    }

    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data) && data.length > 0) {
      candidates.push(unwrapEmbedding(data[0]))
    }
  }

  const embedding = candidates.find((candidate) => Array.isArray(candidate))
  if (!Array.isArray(embedding)) {
    throw new EmbeddingProviderError(
      'invalid_response',
      '多模态向量化上游响应里没有 embedding 数组',
    )
  }
  if (embedding.length !== VISUAL_EMBEDDING_DIMENSIONS) {
    // 维度不符是最危险的一种"看起来成功"：写库时被 typmod 拒绝，或在更晚的召回阶段
    // 变成永远算不出相似度。当场失败并说清两侧维度。
    throw new EmbeddingProviderError(
      'dimension_mismatch',
      `多模态向量化上游返回 ${embedding.length} 维，本服务期望 ${VISUAL_EMBEDDING_DIMENSIONS} 维（见 vector(${VISUAL_EMBEDDING_DIMENSIONS}) 与 VISUAL_EMBEDDING_DIMENSIONS）`,
    )
  }
  if (!embedding.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new EmbeddingProviderError('invalid_response', '多模态向量化上游返回的向量包含非有限数值')
  }
  return embedding as number[]
}

/** `[{ embedding: [...] }]` 与 `[[...]]` 两种内层形状都接受。 */
function unwrapEmbedding(entry: unknown): unknown {
  if (typeof entry === 'object' && entry !== null) {
    return (entry as { embedding?: unknown }).embedding
  }
  return entry
}

/** 一次上游请求 + 响应校验；失败一律抛 `EmbeddingProviderError`（带 retryable 判定）。 */
async function requestEmbedding(
  config: LiveVisualEmbeddingConfig,
  endpoint: string,
  body: string,
): Promise<number[]> {
  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(VISUAL_EMBEDDING_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = isAbortError(error)
    throw new EmbeddingProviderError(
      timedOut ? 'timeout' : 'network',
      timedOut
        ? `多模态向量化上游超时（${VISUAL_EMBEDDING_TIMEOUT_MS}ms）`
        : '多模态向量化上游网络错误',
    )
  }

  if (!response.ok) {
    // 丢弃响应体：既不解析也不记日志（可能回显请求细节）。
    await response.body?.cancel()
    const status = response.status
    throw new EmbeddingProviderError('http_status', `多模态向量化上游返回 status=${status}`, {
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
        ? `多模态向量化上游读取响应超时（${VISUAL_EMBEDDING_TIMEOUT_MS}ms）`
        : '多模态向量化上游响应不是合法 JSON',
    )
  })

  return readEmbedding(payload)
}

export function createLiveVisualEmbeddingProvider(
  config: LiveVisualEmbeddingConfig,
): VisualEmbeddingProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}${MULTIMODAL_EMBEDDING_PATH}`
  const retryDelayMs = config.retryDelayMs ?? VISUAL_EMBEDDING_RETRY_BASE_DELAY_MS

  async function embed(body: string): Promise<number[]> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await requestEmbedding(config, endpoint, body)
      } catch (error) {
        // 不可重试的失败（4xx / 非法响应 / 维度不符）直接冒泡：重发不会变好。
        if (!(error instanceof EmbeddingProviderError) || !error.retryable) throw error
        if (attempt >= VISUAL_EMBEDDING_MAX_ATTEMPTS) throw error
        // 指数退避；测试用 `retryDelayMs: 0` 不真的等。
        await Bun.sleep(retryDelayMs * 2 ** (attempt - 1))
      }
    }
  }

  return {
    model: config.model,
    dimensions: VISUAL_EMBEDDING_DIMENSIONS,

    async embedImage(image, mime) {
      return embed(requestBody(config.model, { image: toDataUri(image, mime) }))
    },

    async embedText(text) {
      return embed(requestBody(config.model, { text }))
    },
  }
}
