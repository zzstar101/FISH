import { and, asc, eq, inArray, lte, notExists, sql } from 'drizzle-orm'
import type { Db } from './client'
import { listingImageDeletions } from './schema/listing-image-deletions'
import { listingImages } from './schema/listings'

/**
 * `listing_image_deletions` 台账的读写（#476）。语义见 `schema/listing-image-deletions.ts`。
 *
 * 登记 / 取消登记在 **listings 写路径的同一个事务**里执行（`executor` 是那个 `tx`）；取到期行、
 * 引用复核、删行在 worker 的回收任务里执行（`db` 是连接池）。所以读写两侧分开暴露，不共用一个
 * "store 对象"。
 */

/** 写路径事务的执行器切片（与 `listings/store.ts` 的 `enqueueListingJobsWith` 同一取舍）。 */
type WriteExecutor = Pick<Db, 'insert' | 'delete'>

/**
 * 登记一批「已从商品图片组里摘除、等待回收」的公开图片键。
 *
 * 幂等：同一个键再次被登记时只刷新 `removed_at`（把保留期从**最后一次**被引用重新起算）。
 * `ON CONFLICT DO UPDATE` 要求同一个键在一条语句里只出现一次，所以先去重 —— 调用方传重键是
 * 可能的（同一张图在图片组里重复），去重放在这里而不是让每个调用方自己记得。
 */
export async function registerRemovedListingImages(
  executor: WriteExecutor,
  objectKeys: readonly string[],
): Promise<void> {
  const unique = [...new Set(objectKeys)]
  if (unique.length === 0) return
  await executor
    .insert(listingImageDeletions)
    .values(unique.map((objectKey) => ({ objectKey, removedAt: sql`now()` })))
    .onConflictDoUpdate({
      target: listingImageDeletions.objectKey,
      set: { removedAt: sql`now()` },
    })
}

/**
 * 取消登记：这些键当前**仍被商品引用**（刚被写回图片组），不该在待删集合里。
 *
 * 幂等（`DELETE` 命中 0 行是正常情况）：绝大多数编辑提交的键本来就不在台账里。
 */
export async function forgetListingImages(
  executor: WriteExecutor,
  objectKeys: readonly string[],
): Promise<void> {
  const unique = [...new Set(objectKeys)]
  if (unique.length === 0) return
  await executor
    .delete(listingImageDeletions)
    .where(inArray(listingImageDeletions.objectKey, unique))
}

/**
 * 到期（`removed_at <= cutoff`）**且此刻没有任何商品引用**的待删行，按 `removed_at` 升序取一批。
 *
 * 引用过滤放在 SQL 里（相关 `NOT EXISTS`），不是取回后再逐行判断：被引用的键可能长期留在台账里
 * （同一张图被多条商品共享、只有一条摘除了它），若把它们一起取回再跳过，它们会永久占住
 * `ORDER BY removed_at` 的批次头部，累计到批次上限后真正可回收的行就再也扫不到了 —— 回收静默停摆。
 * 直接从候选集里排除，批次头部就始终是"可回收的行"。
 *
 * 这同时也是删除前的**唯一**误删判据：`listing_media_objects` 台账刻意不看（它永久保留旧
 * `final_key`，拿它当"仍被引用"会让任何键都删不掉）；真正表示"还在用"的只有
 * `listing_images.object_key`。而"已 confirm 但尚未被任何商品引用"的中间态对象**不会**出现在本台账里
 * （它从没被摘除过），所以不在候选集里，也不会被误删。
 */
export async function listReclaimableListingImageDeletions(
  db: Db,
  input: { cutoff: Date; limit: number },
): Promise<{ objectKey: string; removedAt: Date }[]> {
  return db
    .select({
      objectKey: listingImageDeletions.objectKey,
      removedAt: listingImageDeletions.removedAt,
    })
    .from(listingImageDeletions)
    .where(
      and(
        lte(listingImageDeletions.removedAt, input.cutoff),
        notExists(
          db
            .select({ one: sql`1` })
            .from(listingImages)
            .where(eq(listingImages.objectKey, listingImageDeletions.objectKey)),
        ),
      ),
    )
    .orderBy(asc(listingImageDeletions.removedAt), asc(listingImageDeletions.objectKey))
    .limit(input.limit)
}

/**
 * 该键此刻是否仍被**任何**商品引用（跨全部 `listing_images`，不只原来那条）。
 *
 * 候选集查询（`listReclaimableListingImageDeletions`）已经排除了"查询那一刻被引用"的键；这里供
 * 回收任务在**删对象之前**再复核一次，把"候选集查出 → 删对象"之间的窗口从整批缩到单行。
 * 复核失败的行不会被下一轮重取（它此刻被引用，会被候选集过滤掉），所以不会占住批次头部。
 */
export async function isListingImageKeyReferenced(db: Db, objectKey: string): Promise<boolean> {
  const rows = await db
    .select({ one: sql`1` })
    .from(listingImages)
    .where(eq(listingImages.objectKey, objectKey))
    .limit(1)
  return rows.length > 0
}

/** 删掉一条待删行（对象已删除后调用）。 */
export async function deleteListingImageDeletionRow(db: Db, objectKey: string): Promise<void> {
  await db.delete(listingImageDeletions).where(eq(listingImageDeletions.objectKey, objectKey))
}
