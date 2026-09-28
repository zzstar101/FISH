import { MAX_IMAGE_BYTES } from '@fish/contracts/listings/schema'
import { newId } from '@fish/db/ids'
import { listingMediaObjects } from '@fish/db/schema/listing-media'
import { listingImages } from '@fish/db/schema/listings'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { ModerationDbTransaction } from '../moderation/store'
import { isListingReviewMediaKey } from './review-media'
import type { MediaStorage } from './storage'

/**
 * #286 复审 blocker 1：人工审核结论对**图片**的 durable 结算。
 *
 * 背景：`REVIEW` 图片在 confirm 时只固化到私有的 `listing-review-media/…`（blocker 2），商品因此进人工
 * 队列。管理员做出 ALLOW / BLOCK 之后，如果这张图还留着原始的机器 `REVIEW` 结论，卖家下一次不改图的
 * 文本编辑（编辑请求省略 `objectKeys`，服务端沿用 `listing_images` 里的老键）会重新读到 `REVIEW`，
 * 把已经放行的商品**再次**压回 `REVIEW` + `OFFLINE` —— 人工结论被编辑洗掉。所以人工决策必须与图片
 * 结论一起落库，且是同一个事务：
 *
 * - `ALLOW`：把私有对象**搬到**公开的 `listings/…` 前缀（`readMediaBytes` → `writeMediaBytes`），
 *   改写媒体行（`final_key` = 新公开键、`settled_decision='ALLOW'`）与 `listing_images.object_key`，
 *   于是「放行」与「可匿名读」同时生效；
 * - `BLOCK`：只结算结论（`settled_decision='BLOCK'`，不固化、不搬对象），媒体行随即不可引用。
 *
 * 事务边界：调用方（`moderation/store.ts` 的 `decideWithin`）已经对 listings 行 `FOR UPDATE`，
 * 而卖家改图走 `listings/store.ts` 的 `updateListingAtomic`，也在锁内读 `listing_images` —— 两者
 * 互斥，因此把 S3 拷贝放在决策事务里不会与卖家编辑并发改写同一批键。代价是决策事务内做 ≤9 次
 * 对象拷贝（管理员低频操作），换来「翻转结论」与「切换可引用键」原子。
 *
 * 失败即回滚（抛错）：拷贝失败时宁可整个人工决策不生效（商品留在 REVIEW 队列），也不能出现
 * 「已放行但图片仍是私有键 / 键指向不存在对象」的半截状态。
 */
export type SettleListingMedia = (
  tx: ModerationDbTransaction,
  input: { listingId: string; decision: 'ALLOW' | 'BLOCK' },
) => Promise<void>

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** 私有审核键与公开固化键同构，扩展名就是对象内容类型。 */
function extensionOf(key: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(key)
  return (match?.[1] ?? 'jpg').toLowerCase()
}

export function createListingMediaSettlement(deps: { storage: MediaStorage }): SettleListingMedia {
  const { storage } = deps
  return async function settleListingMediaWithin(tx, { listingId, decision }) {
    const storedRows = await tx
      .select({ objectKey: listingImages.objectKey })
      .from(listingImages)
      .where(eq(listingImages.listingId, listingId))
    const reviewKeys = storedRows.map((row) => row.objectKey).filter(isListingReviewMediaKey)
    // 没有审核中的图（全机器 ALLOW 或纯 legacy 键）：人工结论对图片没有可结算的内容。
    if (reviewKeys.length === 0) return

    if (decision === 'BLOCK') {
      await tx
        .update(listingMediaObjects)
        .set({ settledDecision: 'BLOCK', settledAt: sql`now()` })
        .where(
          and(
            inArray(listingMediaObjects.finalKey, reviewKeys),
            eq(listingMediaObjects.moderationDecision, 'REVIEW'),
          ),
        )
      return
    }

    if (!storage.readMediaBytes || !storage.writeMediaBytes) {
      throw new Error('媒体存储不支持读写字节，无法结算人工放行的审核图片')
    }
    for (const reviewKey of reviewKeys) {
      const [media] = await tx
        .select()
        .from(listingMediaObjects)
        .where(eq(listingMediaObjects.finalKey, reviewKey))
        .limit(1)
      // 已经被结算过（例如决策重试）就跳过：结算只对原始 REVIEW 且尚未结算的行做一次。
      if (media?.moderationDecision !== 'REVIEW' || media.settledDecision !== null) continue

      const bytes = await storage.readMediaBytes(reviewKey, MAX_IMAGE_BYTES)
      if (!bytes || bytes.length === 0) {
        throw new Error(`审核图片对象缺失，无法结算人工放行：${reviewKey}`)
      }
      const extension = extensionOf(reviewKey)
      const publicKey = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, media.userId)}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.${extension}`
      await storage.writeMediaBytes(
        publicKey,
        bytes,
        CONTENT_TYPE_BY_EXTENSION[extension] ?? 'image/jpeg',
      )
      await tx
        .update(listingMediaObjects)
        .set({ finalKey: publicKey, settledDecision: 'ALLOW', settledAt: sql`now()` })
        .where(eq(listingMediaObjects.id, media.id))
      await tx
        .update(listingImages)
        .set({ objectKey: publicKey })
        .where(and(eq(listingImages.listingId, listingId), eq(listingImages.objectKey, reviewKey)))
    }
  }
}
