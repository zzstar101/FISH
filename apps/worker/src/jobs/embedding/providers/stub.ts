import type { EmbeddingProvider } from '@fish/contracts/embedding/provider'
import { EMBEDDING_DIMENSIONS } from '@fish/db/schema/embeddings'

/**
 * 确定性 stub provider（#322 M1）：本地开发、单测与 CI 用它，不需要任何上游密钥。
 *
 * 不是随机数：同一文本永远得到同一向量，且**共享词元的文本余弦相似度为正**——否则
 * 集成测试只能断言"有没有写库"，无法断言"召回顺序与语义有关"。做法是词元哈希到维度上的
 * 词袋 + L2 归一化，够用且完全可复现。
 *
 * 模型名刻意带 `stub-` 前缀：它会被写进 `embeddings.model`，所以开发库里的假向量永远不会
 * 被误当成真实模型的向量（读侧按 model 过滤）。
 */
export const STUB_EMBEDDING_MODEL = 'stub-deterministic-v1'

/** 拉丁词按整词、CJK 按单字：中文没有空格分词，按单字切至少能让同字词元重合。 */
const TOKEN_PATTERN = /[a-z0-9]+|[\u4e00-\u9fff]/gi

function embedOne(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)

  for (const token of text.toLowerCase().match(TOKEN_PATTERN) ?? []) {
    const digest = new Bun.CryptoHasher('sha256').update(token).digest()
    const bucket = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0)
    const sign = ((digest[2] ?? 0) & 1) === 0 ? 1 : -1
    // `noUncheckedIndexedAccess` 下 `vector[i]` 是 `number | undefined`，不能直接 `+=`。
    const index = bucket % EMBEDDING_DIMENSIONS
    vector[index] = (vector[index] ?? 0) + sign
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  // 全空文本（例如只剩标点）会得到零向量，余弦无定义；给一个固定方向而不是返回 0 向量，
  // 免得下游把"零向量"当成合法输入。真实调用路径上文本不会为空（keyword/title 非空）。
  if (norm === 0) {
    vector[0] = 1
    return vector
  }

  return vector.map((value) => value / norm)
}

export function createStubEmbeddingProvider(): EmbeddingProvider {
  return {
    model: STUB_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map(embedOne)
    },
  }
}
