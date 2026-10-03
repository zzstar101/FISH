import type { EmbeddingProvider } from '@fish/contracts/embedding/provider'
import type { EmbeddingEnv } from '@fish/shared/env'
import { createLiveEmbeddingProvider, type EmbeddingRequestEvent } from './live'
import { createStubEmbeddingProvider } from './stub'

/** 装配期的观测选项（#322 M4）：provider 不认识日志，只把事件交给调用方决定怎么记。 */
export type EmbeddingProviderOptions = {
  /** 运维脚本的请求限速/预算控制，正常 worker 不传。 */
  beforeRequest?: () => Promise<void>
  /**
   * 上游请求观测回调。**只有 live 有上游请求可观测**：stub 在本地算哈希词袋，不发请求，
   * 因此不会产生 `embed.request` 事件（它仍然会被 handler 的 `embed.entity` 事件覆盖到）。
   */
  onRequest?: (event: EmbeddingRequestEvent) => void
}

/**
 * 按 `EMBEDDING_TRANSPORT` 装配 provider（#322 M1）。transport 无默认值，缺失在启动期就被
 * `loadEmbeddingEnv()` 拒绝，所以这里不需要"兜底成 stub"的分支。
 */
export function createEmbeddingProvider(
  env: EmbeddingEnv,
  options: EmbeddingProviderOptions = {},
): EmbeddingProvider {
  return env.transport === 'stub'
    ? createStubEmbeddingProvider()
    : createLiveEmbeddingProvider({
        baseUrl: env.baseUrl,
        apiKey: env.apiKey,
        model: env.model,
        beforeRequest: options.beforeRequest,
        onRequest: options.onRequest,
      })
}
