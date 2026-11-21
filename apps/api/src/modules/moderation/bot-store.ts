import type { AdminModerationQueueItem } from '@fish/contracts/admin/schema'
import type { Db } from '@fish/db/client'
import { listingImages, listings } from '@fish/db/schema/listings'
import { moderationModelReviews } from '@fish/db/schema/moderation'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { asc, desc, inArray } from 'drizzle-orm'
import type { MediaStorage } from '../uploads/storage'

/**
 * 机器人卡片需要的、admin 队列里没有的商品事实（价格 / 类目 / 图片 / 模型结论）。
 *
 * 单独查而不是改 `AdminModerationQueueItem`：卡片是另一种视图，字段需求会各自演化，
 * 但两者读的是同一份 `listings` / `listing_images` / `moderation_model_reviews`。
 */

/** 卡片上最多放几张图：再多手机端也看不清，剩下的靠 `imageCount` 提示去后台看。 */
const MAX_CARD_IMAGES = 3

export interface BotModelReview {
  model: string
  promptVersion: string
  decision: 'PASS' | 'BLOCK' | 'UNSURE' | 'ERROR'
  category: string | null
  reason: string
  evidence: string[]
  confidence: number | null
  latencyMs: number | null
  outcome: 'SHADOW' | 'AUTO_PASSED' | 'AUTO_REJECTED' | 'PENDING'
  /** ISO 字符串：契约里 `modelReview.createdAt` 是 `z.iso.datetime()`，Date 会被判非法。 */
  createdAt: string
}

export interface BotListingFacts {
  priceCents: number
  category: string
  images: { url: string; position: number }[]
  imageCount: number
  modelReview: BotModelReview | null
}

/**
 * 一次批量取回整页商品的事实，避免卡片数量 × 4 次查询。
 *
 * 返回的 Map 以**公开 ID**（`lst_…`）为键：调用方手里只有队列项里的公开 ID，
 * 内部 UUID 只在本函数内部用于 SQL。解码失败的条目直接跳过——它是坏数据，
 * 不该让整页卡片 500。
 */
export async function loadBotListingFacts(
  db: Db,
  storage: MediaStorage,
  items: readonly AdminModerationQueueItem[],
): Promise<Map<string, BotListingFacts>> {
  const internalToPublic = new Map<string, string>()
  for (const item of items) {
    try {
      internalToPublic.set(
        decodePublicId(PUBLIC_ID_PREFIX.listing, item.listing.id),
        item.listing.id,
      )
    } catch {
      // 公开 ID 不合法：跳过这一条，不让一张卡坏掉整页。
    }
  }
  const internalIds = [...internalToPublic.keys()]
  if (internalIds.length === 0) return new Map()

  const [listingRows, imageRows, reviewRows] = await Promise.all([
    db
      .select({
        id: listings.id,
        priceCents: listings.priceCents,
        category: listings.category,
      })
      .from(listings)
      .where(inArray(listings.id, internalIds)),
    db
      .select({
        listingId: listingImages.listingId,
        objectKey: listingImages.objectKey,
        sortOrder: listingImages.sortOrder,
      })
      .from(listingImages)
      .where(inArray(listingImages.listingId, internalIds))
      .orderBy(asc(listingImages.listingId), asc(listingImages.sortOrder)),
    db
      .select({
        listingId: moderationModelReviews.listingId,
        model: moderationModelReviews.model,
        promptVersion: moderationModelReviews.promptVersion,
        decision: moderationModelReviews.decision,
        category: moderationModelReviews.category,
        reason: moderationModelReviews.reason,
        evidence: moderationModelReviews.evidence,
        confidence: moderationModelReviews.confidence,
        latencyMs: moderationModelReviews.latencyMs,
        outcome: moderationModelReviews.outcome,
        createdAt: moderationModelReviews.createdAt,
      })
      .from(moderationModelReviews)
      .where(inArray(moderationModelReviews.listingId, internalIds))
      .orderBy(desc(moderationModelReviews.createdAt), desc(moderationModelReviews.id)),
  ])

  const imagesByListing = new Map<string, { objectKey: string; position: number }[]>()
  for (const row of imageRows) {
    const list = imagesByListing.get(row.listingId) ?? []
    list.push({ objectKey: row.objectKey, position: list.length + 1 })
    imagesByListing.set(row.listingId, list)
  }

  // 按 created_at DESC 取第一条即「最近一次」；同毫秒时靠 id DESC 兜底（与 admin 详情同序）。
  const reviewByListing = new Map<string, BotModelReview>()
  for (const row of reviewRows) {
    if (reviewByListing.has(row.listingId)) continue
    reviewByListing.set(row.listingId, {
      model: row.model,
      promptVersion: row.promptVersion,
      decision: row.decision,
      category: row.category,
      reason: row.reason,
      evidence: evidenceOf(row.evidence),
      confidence: row.confidence,
      latencyMs: row.latencyMs,
      outcome: row.outcome,
      createdAt: row.createdAt.toISOString(),
    })
  }

  const facts = new Map<string, BotListingFacts>()
  for (const row of listingRows) {
    const publicId = internalToPublic.get(row.id)
    if (!publicId) continue
    const all = imagesByListing.get(row.id) ?? []
    facts.set(publicId, {
      priceCents: row.priceCents,
      category: row.category,
      images: all
        .slice(0, MAX_CARD_IMAGES)
        .map((image) => ({ url: storage.publicUrl(image.objectKey), position: image.position })),
      imageCount: all.length,
      modelReview: reviewByListing.get(row.id) ?? null,
    })
  }
  return facts
}

/** jsonb 列可能读成数组、JSON 文本或 null；卡片只接受字符串数组。 */
function evidenceOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}
