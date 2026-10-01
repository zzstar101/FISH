import type { VisualEmbeddingProvider } from '@fish/contracts/visual/provider'
import { VISUAL_EMBEDDING_DIMENSIONS } from '@fish/db/schema/visual-embeddings'

/**
 * 确定性 stub provider（#324）：本地开发、单测与 CI 用它，不需要任何上游密钥、不出网。
 *
 * 两个必须成立的性质：
 * 1. **同一输入永远得到同一向量**：图片按字节、文本按词元，都是纯函数；
 * 2. **相同输入之间余弦距离为 0**：所以"拿商品封面本身当查询图"必定召回那件商品，
 *    集成测试因此能断言**召回顺序**，而不是只能断言"有没有写库"。
 *
 * 图片与文本落在同一个维度空间里，但**语义上不互相关联**（图片向量由字节哈希铺开，
 * 文本向量由词元铺开）——stub 不假装自己有多模态对齐能力。混合排序里"文本路是否加分"
 * 由打分函数的单测用显式分数覆盖，不依赖 stub 的文本-图片相似度。
 *
 * 模型名刻意带 `stub-` 前缀：它会原样写进 `listing_visual_embeddings.model`，
 * 开发库里的假向量永远不会被误当成真实模型的向量（读侧按 model 过滤）。
 */
export const STUB_VISUAL_EMBEDDING_MODEL = 'stub-visual-deterministic-v1'

/** 拉丁词按整词、CJK 按单字（与 #322 的文本 stub 同一分词口径）。 */
const TOKEN_PATTERN = /[a-z0-9]+|[\u4e00-\u9fff]/gi

/**
 * 词袋 + L2 归一化：把任意词元流映射成 1024 维单位向量。
 *
 * 用 `sha256` 而不是普通哈希：桶位与符号都取自摘要字节，同一次运行内完全可复现，
 * 且不同词元之间的碰撞概率与维度成比例，测试里不会出现"两个不同图片恰好同向"。
 */
function bagOfTokens(tokens: Iterable<string>): number[] {
  const vector = new Array<number>(VISUAL_EMBEDDING_DIMENSIONS).fill(0)

  for (const token of tokens) {
    const digest = new Bun.CryptoHasher('sha256').update(token).digest()
    const bucket = ((digest[0] ?? 0) << 8) | (digest[1] ?? 0)
    const sign = ((digest[2] ?? 0) & 1) === 0 ? 1 : -1
    // `noUncheckedIndexedAccess` 下 `vector[i]` 是 `number | undefined`，不能直接 `+=`。
    const index = bucket % VISUAL_EMBEDDING_DIMENSIONS
    vector[index] = (vector[index] ?? 0) + sign
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  // 空输入（空文本 / 空字节）会得到零向量，余弦无定义：给一个固定方向，
  // 免得下游把零向量当合法输入（真实路径上图片不可能为空，handler 会先拒掉）。
  if (norm === 0) {
    vector[0] = 1
    return vector
  }

  return vector.map((value) => value / norm)
}

/**
 * 图片 → 词元流：`mime` 与字节一起摘要后按 4 个十六进制字符切段。
 *
 * 把 mime 也算进去，是为了让"同样的字节、不同的声明类型"得到不同向量——这样
 * "服务端不信客户端 MIME"这件事在向量空间里也是可观察的。
 */
function imageTokens(image: Uint8Array, mime: string): string[] {
  const hex = new Bun.CryptoHasher('sha256').update(mime).update(image).digest('hex')
  const tokens: string[] = []
  for (let index = 0; index < hex.length; index += 4) {
    tokens.push(hex.slice(index, index + 4))
  }
  return tokens
}

export function createStubVisualEmbeddingProvider(): VisualEmbeddingProvider {
  return {
    model: STUB_VISUAL_EMBEDDING_MODEL,
    dimensions: VISUAL_EMBEDDING_DIMENSIONS,
    async embedImage(image, mime) {
      return bagOfTokens(imageTokens(image, mime))
    },
    async embedText(text) {
      return bagOfTokens(text.toLowerCase().match(TOKEN_PATTERN) ?? [])
    },
  }
}
