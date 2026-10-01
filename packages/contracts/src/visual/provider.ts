import type { ALLOWED_IMAGE_MIME } from '../listings/schema'

/** 查询图允许的字节类型（与 Listing 图片同一白名单，`packages/contracts/src/listings/schema.ts`）。 */
export type VisualImageMime = (typeof ALLOWED_IMAGE_MIME)[number]

/**
 * 多模态（视觉）embedding provider 的最小契约（#324 M3）。
 *
 * 为什么不复用 #322 的 `EmbeddingProvider`：那个接口是**纯文本**的（`embed(texts: string[])`），
 * 且维度锁死在 `EMBEDDING_DIMENSIONS = 1536`，对应 `embeddings` 表的 `vector(1536)` 列。
 * 多模态向量化在阿里云百炼上**不走 OpenAI 兼容接口**（只有 DashScope 原生
 * `/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`），维度也是另一套
 * （`qwen3-vl-embedding` 默认 2560，我们选 1024）。共用一个接口只会诱使调用方把 1024 维图像
 * 向量塞进 1536 维的表——那是**静默的语义灾难**：写进去要么被 CHECK 拒绝，要么（放宽约束后）
 * 变成两个空间混算的相似度。
 *
 * `embedText` 与 `embedImage` 必须来自**同一个 model**：多模态 embedding 的价值就在于
 * 文本与图像落在同一向量空间，M5 的 OCR/VLM 文本查询才能与 Listing 的**封面图像**向量直接
 * 比余弦——这是第二路召回能与第一路共用一张向量表的原因。换模型必须同时换两侧。
 *
 * 失败一律抛 `EmbeddingProviderError`（`packages/contracts/src/embedding/provider.ts`）：
 * 失败分类（timeout / network / http_status / invalid_response / dimension_mismatch）与可重试
 * 判定和文本侧完全同构，再造一个同形类只会让 worker 的 fail-closed 判定出现两份实现。
 */
export interface VisualEmbeddingProvider {
  /** 模型标识，原样写入 `listing_visual_embeddings.model`，"不许混用不同模型向量"的判据。 */
  readonly model: string
  /** 输出维度，必须与迁移里的 `vector(N)` 一致（`VISUAL_EMBEDDING_DIMENSIONS`）。 */
  readonly dimensions: number
  /**
   * 单张图片 → 向量。`mime` 由调用方**按魔术字节嗅探**得出（不是客户端声明的 MIME）：
   * live 实现要把字节编码成 `data:{mime};base64,{...}` 传给上游。
   */
  embedImage(image: Uint8Array, mime: VisualImageMime): Promise<number[]>
  /** 纯文本 → 向量（同一模型、同一空间）。M5 的 OCR/VLM 文本走这里。 */
  embedText(text: string): Promise<number[]>
}
