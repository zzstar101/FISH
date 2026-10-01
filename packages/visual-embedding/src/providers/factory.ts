import type { VisualEmbeddingProvider } from '@fish/contracts/visual/provider'
import type { VisualEmbeddingEnv } from '@fish/shared/env'
import { createLiveVisualEmbeddingProvider } from './live'
import { createStubVisualEmbeddingProvider } from './stub'

/**
 * 按 env 选 provider（#324 M3）。
 *
 * 放在包里而不是各 app 各写一遍：**有两个调用方**——API（在搜索请求里当场算查询图向量，
 * 查询图只活 15 分钟，投 job 等 worker 轮询会让首屏延迟不可控）与 worker（回填封面向量）。
 * 两边必须选到同一个模型，否则查询向量与库存向量落在不同空间，"相似度"会静默变成噪声。
 *
 * 子路径是 `providers/factory` 而不是 `providers`：仓内所有 package 的 exports 都是
 * `"./*": "./src/*.ts"`，**通配只能指向文件**，指向目录（`providers/index.ts`）解析不了。
 */
export function createVisualEmbeddingProvider(env: VisualEmbeddingEnv): VisualEmbeddingProvider {
  return env.transport === 'stub'
    ? createStubVisualEmbeddingProvider()
    : createLiveVisualEmbeddingProvider(env)
}
