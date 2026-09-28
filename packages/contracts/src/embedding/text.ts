/**
 * embedding 文本构造与内容指纹（#322 M1）。
 *
 * 这是生成链唯一的文本出口：worker 的 handler 与 M4 的 backfill 必须都调这里，
 * 否则"内容没变就不用重新生成"这条判据两个入口会各说各话。
 *
 * **服务端专用**（用 `Bun.CryptoHasher`）：worker 与 backfill 脚本用，不要从 web 引用。
 */

/**
 * 文本格式版本。参与指纹计算，所以改动下面任何一行格式都必须把它 +1 —— 否则同一实体
 * 内容没变、指纹却没变，模型侧实际看到的文本已经变了，旧向量会被永久当成"最新"。
 */
export const EMBEDDING_TEXT_FORMAT_VERSION = 1

type Field = { label: string; value: string | null | undefined }

/** `\r\n` / 单个 `\r` 统一成 `\n`，再去首尾空白；空串与 null 等价（视作"没有这个字段"）。 */
function normalizeValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const normalized = value.replace(/\r\n?/g, '\n').trim()
  return normalized.length === 0 ? null : normalized
}

/**
 * `标签: 值` 逐行拼接；值为空时**整行省略**（而不是留一行 `描述:`）。
 *
 * 不做大小写折叠、不做标点归一化：中文与西文标点、品牌大小写的差异本身带语义，
 * 在文本层抹平等于替模型做决定。
 */
function compose(fields: Field[]): string {
  const lines: string[] = []

  for (const field of fields) {
    const value = normalizeValue(field.value)
    if (value !== null) lines.push(`${field.label}: ${value}`)
  }

  return lines.join('\n')
}

export type ListingEmbeddingFacts = {
  title: string
  description: string | null
  category: string | null
}

export type WishEmbeddingFacts = {
  keyword: string
  description: string | null
  /** `null` 表示"不限分类"，按 #322 的文本规范写成 `不限`，而不是省略该行。 */
  category: string | null
}

/** Listing 文本：`标题: <title>\n描述: <description>\n分类: <category>`（空字段省略）。 */
export function buildListingEmbeddingText(listing: ListingEmbeddingFacts): string {
  return compose([
    { label: '标题', value: listing.title },
    { label: '描述', value: listing.description },
    { label: '分类', value: listing.category },
  ])
}

/** Wish 文本：`需求: <keyword>\n描述: <description>\n分类: <category|不限>`（空字段省略）。 */
export function buildWishEmbeddingText(wish: WishEmbeddingFacts): string {
  return compose([
    { label: '需求', value: wish.keyword },
    { label: '描述', value: wish.description },
    { label: '分类', value: wish.category ?? '不限' },
  ])
}

/**
 * 内容指纹 = `sha256("<格式版本>:<规范化文本>")`。
 *
 * **不包含 model / dimensions**：指纹回答的是"这段内容我算过没有"，与用哪个模型算无关；
 * 换模型要重建时判据是 `embeddings.model` 不等，而不是指纹不等（见 M4 的 backfill）。
 */
export function contentHashOf(text: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(`${EMBEDDING_TEXT_FORMAT_VERSION}:${text}`)
    .digest('hex')
}
