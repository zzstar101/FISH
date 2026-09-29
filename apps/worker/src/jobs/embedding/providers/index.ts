import type { EmbeddingProvider } from '@fish/contracts/embedding/provider'
import type { EmbeddingEnv } from '@fish/shared/env'
import { createLiveEmbeddingProvider } from './live'
import { createStubEmbeddingProvider } from './stub'

/**
 * 按 `EMBEDDING_TRANSPORT` 装配 provider（#322 M1）。transport 无默认值，缺失在启动期就被
 * `loadEmbeddingEnv()` 拒绝，所以这里不需要"兜底成 stub"的分支。
 */
export function createEmbeddingProvider(env: EmbeddingEnv): EmbeddingProvider {
  return env.transport === 'stub' ? createStubEmbeddingProvider() : createLiveEmbeddingProvider(env)
}
