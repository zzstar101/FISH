import { LISTING_IMAGE_RETAIN_MS } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import {
  deleteListingImageDeletionRow,
  isListingImageKeyReferenced,
  listDueListingImageDeletions,
} from '@fish/db/listing-image-deletions'
import type { WorkerMediaStorage } from '../media-storage'

/**
 * 被替换掉的公开商品图对象的回收（#476）。
 *
 * 图片写路径是全量替换，换图时旧 `listings/…` 对象从 `listing_images` 摘除、并登记进
 * `listing_image_deletions`（见 `apps/api/src/modules/listings/image-cleanup.ts`）。本任务按
 * **保留期**（`LISTING_IMAGE_RETAIN_MS`，从 `removed_at` 即最后一次被引用时刻起算）取到期的
 * 待删行，逐行**再复核一次引用**后删对象、删行。
 *
 * 两处刻意的取舍：
 *
 * - **先删对象再删行**（与 `visual-embedding/cleanup.ts` 的到期查询图清理同一顺序）：反过来的话，
 *   删对象失败就再也查不到该删哪个键了。`deleteObject` 失败会抛错、本轮中止，下一轮重新捡起同一行。
 * - **删除前的引用复核是唯一的误删防线**：`listing_image_deletions` 只是"这个键被摘除过"的登记，
 *   真正的判据是"此刻没有任何 `listing_images.object_key` 等于它"。同一个键被同一卖家的多条商品
 *   共享时，一条商品摘除它、另一条仍引用它，这里的复核会把它留下（并保留台账行 —— 它今后被摘除时
 *   会刷新 `removed_at` 重新起算保留期）。`listing_media_objects` 台账刻意**不**作为判据：它永久
 *   保留旧 `final_key`，拿它当"仍被引用"会让任何键都删不掉。
 *
 * 已知残留窗口（接受，且与既有清理同形）：复核通过后、`deleteObject` 之前，若有并发写请求把该键
 * **重新引用**回某条商品，对象仍会被删。该键必须已被摘除且超过保留期，正常前端拿不到它
 * （编辑态只下发当前图片组里的键），只有构造请求才可能触发；把它彻底关掉需要写路径在事务内对对象
 * 存储发请求，违反 #286 的"锁内不发网络请求"约定，代价大于收益。
 */
export const LISTING_IMAGE_CLEANUP_BATCH_SIZE = 100

export type ListingImageCleanupResult = { scanned: number; deleted: number; skipped: number }

export async function cleanupRemovedListingImages(input: {
  db: Db
  storage: WorkerMediaStorage
  now: Date
  retainMs?: number
  limit?: number
}): Promise<ListingImageCleanupResult> {
  const retainMs = input.retainMs ?? LISTING_IMAGE_RETAIN_MS
  const cutoff = new Date(input.now.getTime() - retainMs)
  const rows = await listDueListingImageDeletions(input.db, {
    cutoff,
    limit: input.limit ?? LISTING_IMAGE_CLEANUP_BATCH_SIZE,
  })

  let deleted = 0
  let skipped = 0
  for (const row of rows) {
    if (await isListingImageKeyReferenced(input.db, row.objectKey)) {
      skipped += 1
      continue
    }
    await input.storage.deleteObject(row.objectKey)
    await deleteListingImageDeletionRow(input.db, row.objectKey)
    deleted += 1
  }

  return { scanned: rows.length, deleted, skipped }
}
