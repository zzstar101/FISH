import type { Db } from '@fish/db/client'
import { forgetListingImages, registerRemovedListingImages } from '@fish/db/listing-image-deletions'
import { isPublicListingKey } from '../uploads/storage'

/** 与 `listings/store.ts` 的事务执行器同一形状（那里把 `tx` 传给本模块）。 */
type ListingWriteExecutor = Pick<Db, 'insert' | 'delete'>

/**
 * 图片**全量替换**后的孤儿对象登记（#476）。
 *
 * 图片写路径是全量替换（`store.updateListingAtomic` 先删后插 `listing_images`），所以一次编辑
 * 里「被摘除的键」= 旧图片组 ∖ 新图片组。这些键从 `listing_images` 摘除后，`listings/…` 对象
 * 本体留在对象存储里无人引用；本函数把它们登记进待删台账，由 worker 在保留期后回收
 * （见 `apps/worker/src/jobs/listing-image-cleanup.ts`）。调用点必须与图片的删/插**同一事务**。
 *
 * 只登记**公开键**（`isPublicListingKey`）：
 * - 审核中的图在私有前缀 `listing-review-media/…` 下，从不匿名可读，也从不进待删台账
 *   —— 「并发评审中的图不得进入待删集合」因此是结构性的，不靠回收时的判断；
 * - 历史遗留键（#286 之前的裸 UUID 前缀）不属于本票要回收的公开 `listings/…` 对象，不登记。
 *
 * 另一半是**取消登记**：本次提交里仍被引用的公开键从台账删掉（例如"换回上一张图"、或这条商品
 * 与另一条共享同一张图）。漏掉它会让一个正在被引用的键一直躺在待删集合里、每轮都被复核一遍。
 */
export async function recordListingImageReplacement(
  executor: ListingWriteExecutor,
  input: { previousKeys: readonly string[]; nextKeys: readonly string[] },
): Promise<void> {
  const next = new Set(input.nextKeys)
  const removed = [...new Set(input.previousKeys)].filter(
    (key) => !next.has(key) && isPublicListingKey(key),
  )
  const kept = [...new Set(input.nextKeys)].filter(isPublicListingKey)
  // `removed` 与 `kept` 按构造互斥（前者不在 next 里、后者在 next 里），两次写作用在不相交的
  // 键集合上，顺序无关；先登记更贴合"这张图不再被引用"的语义。
  await registerRemovedListingImages(executor, removed)
  await forgetListingImages(executor, kept)
}
