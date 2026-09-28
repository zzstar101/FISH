/**
 * embedding provider 的最小契约（#322 M1）。
 *
 * 刻意不引入任何 SDK：供应商不进本 Issue 的绑定范围，engine/worker 只认这个接口，
 * 换模型或换供应商不需要动匹配代码。实现见
 * `apps/worker/src/jobs/embedding/providers/{stub,live}.ts`。
 */
export interface EmbeddingProvider {
  /** 模型标识，会原样写入 `embeddings.model`，并成为"不许混用不同模型向量"的判据。 */
  readonly model: string
  /** 输出维度，必须与迁移里的 `vector(N)` 一致（`EMBEDDING_DIMENSIONS`）。 */
  readonly dimensions: number
  /** 批量生成向量；返回顺序必须与入参一致，长度必须相等。 */
  embed(texts: string[]): Promise<number[][]>
}

/**
 * 一律 fail-closed 的失败原因分类。
 *
 * 没有"返回空向量继续跑"这条路径：空向量会变成一条看起来合法、实则毫无语义的匹配，
 * 比失败更难发现（#322 明确禁止）。
 */
export type EmbeddingFailureReason =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'invalid_response'
  | 'dimension_mismatch'

export class EmbeddingProviderError extends Error {
  readonly reason: EmbeddingFailureReason

  constructor(reason: EmbeddingFailureReason, message: string) {
    super(message)
    this.name = 'EmbeddingProviderError'
    this.reason = reason
  }
}
