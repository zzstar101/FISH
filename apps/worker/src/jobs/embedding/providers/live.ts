import { type EmbeddingProvider, EmbeddingProviderError } from '@fish/contracts/embedding/provider'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'

/**
 * live provider（#322 M1）：OpenAI 兼容的 `/embeddings` 端点。
 *
 * 形状照 `apps/api/src/modules/ai/provider.ts`：裸 `fetch`（不引 SDK）、
 * `AbortSignal.timeout`、**不重试**、绝不把上游响应体或请求文本写进错误消息
 * （embedding 的入参是愿望/商品全文，日志里不该出现）。
 *
 * 失败一律 `fail-closed`：宁可让这条 job 重试/失败，也不返回"看起来合法的空向量"。
 */
export const EMBEDDING_TIMEOUT_MS = 10_000

export type LiveEmbeddingConfig = { baseUrl: string; apiKey: string; model: string }

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

export function createLiveEmbeddingProvider(config: LiveEmbeddingConfig): EmbeddingProvider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`

  return {
    model: config.model,
    dimensions: EMBEDDING_DIMENSIONS,

    async embed(texts) {
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: config.model, input: texts }),
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
        throw new EmbeddingProviderError(
          'http_status',
          `embedding 上游返回 status=${response.status}`,
        )
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
    },
  }
}
