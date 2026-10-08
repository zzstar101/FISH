import { LISTING_IMAGE_RETAIN_MS } from '@fish/contracts/listings/schema'
import type { Db } from '@fish/db/client'
import {
  deleteListingImageDeletionRow,
  isListingImageKeyReferenced,
  listReclaimableListingImageDeletions,
} from '@fish/db/listing-image-deletions'
import type { WorkerMediaStorage } from '../media-storage'

/**
 * 被替换掉的公开商品图对象的回收（#476）。
 *
 * 图片写路径是全量替换，换图时旧 `listings/…` 对象从 `listing_images` 摘除、并登记进
 * `listing_image_deletions`（见 `apps/api/src/modules/listings/image-cleanup.ts`）。本任务按
 * **保留期**（`LISTING_IMAGE_RETAIN_MS`，从 `removed_at` 即最后一次被引用时刻起算）取到期的
 * **可回收**行（查询里已排除仍被 `listing_images` 引用的键），逐行删对象、删行。
 *
 * 两处刻意的取舍：
 *
 * - **先删对象再删行**（与 `visual-embedding/cleanup.ts` 的到期查询图清理同一顺序）：反过来的话，
 *   删对象失败就再也查不到该删哪个键了。删对象失败**按行处理**（记日志、不删行、继续处理本批其余行）：
 *   若让异常冒出去中止本轮，这个"最早摘除"的行会永远排在 `ORDER BY removed_at` 的批次头部，把它后面
 *   所有可回收的对象一起挡住；按行吞掉后，失败行下一轮仍会被重试，其余行照常回收。
 * - **误删防线分两层**：候选集查询（`listReclaimableListingImageDeletions` 的相关 `NOT EXISTS`）先
 *   排除"查询那一刻仍被引用"的键；删对象前再对单行复核一次（`isListingImageKeyReferenced`）。同一把键
 *   被同一卖家的多条商品共享时，一条商品摘除它、另一条仍引用它，它就不会被删。把过滤放进 SQL 而不是
 *   只"取回来再跳过"还有一个原因：被引用的键可能长期留在台账里，只跳过会让它们永久占住
 *   `ORDER BY removed_at` 的批次头部，累计到批次上限后回收静默停摆；放进 SQL 后批次头部始终是可回收的行。
 *
 * 已知残留窗口（接受，且与既有清理同形）：单行复核通过后、`deleteObject` 之前，若有并发写请求把该键
 * **重新引用**回某条商品，对象仍会被删。该键必须已被摘除且超过保留期，正常前端拿不到它
 * （编辑态只下发当前图片组里的键），只有构造请求才可能触发；把它彻底关掉需要写路径在事务内对对象
 * 存储发请求，违反 #286 的"锁内不发网络请求"约定，代价大于收益。
 */
export const LISTING_IMAGE_CLEANUP_BATCH_SIZE = 100

export type ListingImageCleanupResult = { scanned: number; deleted: number; failed: number }

export async function cleanupRemovedListingImages(input: {
  db: Db
  storage: WorkerMediaStorage
  now: Date
  retainMs?: number
  limit?: number
}): Promise<ListingImageCleanupResult> {
  const retainMs = input.retainMs ?? LISTING_IMAGE_RETAIN_MS
  const cutoff = new Date(input.now.getTime() - retainMs)
  const rows = await listReclaimableListingImageDeletions(input.db, {
    cutoff,
    limit: input.limit ?? LISTING_IMAGE_CLEANUP_BATCH_SIZE,
  })

  let deleted = 0
  let failed = 0
  for (const row of rows) {
    // 候选集已排除"查询那一刻仍被引用"的键；删对象前再复核一次，把窗口从整批缩到单行。
    // 复核失败的行不会被下一轮重取（它此刻被引用，会被候选集过滤掉），所以不会占住批次头部。
    if (await isListingImageKeyReferenced(input.db, row.objectKey)) continue
    try {
      await input.storage.deleteObject(row.objectKey)
    } catch (error) {
      // 一行删不掉不该拖住整批：记日志后继续，行不删（下一轮同一行重试）。
      failed += 1
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[worker] 商品图对象删除失败（${row.objectKey}）：${detail}`)
      continue
    }
    await deleteListingImageDeletionRow(input.db, row.objectKey)
    deleted += 1
  }

  return { scanned: rows.length, deleted, failed }
}
