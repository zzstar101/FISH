/**
 * 到期查询图清理（#324 M2/M9）。
 *
 * 查询图的隐私承诺是"用完即删"（#324 安全要求），而它由两部分组成：
 * - **行**（`visual_query_images`）：TTL 到点后不再被搜索接口接受（`findUsableVisualQueryImage`
 *   带 `expires_at > now`），所以过期行本身不构成泄漏；
 * - **对象**（`visual-search/…`）：还在桶里，**必须真的删掉**。
 *
 * 顺序不能反（见 `packages/db/src/visual-query-store.ts`）：先删对象再删行。反过来的话，
 * 删对象失败就再也不知道该删哪个键了——对象会一直留到永远；行删不掉只是多清一次。
 * 因此 `deleteObject` 失败会抛错，本轮中止，下一轮重新捡起同一批（`expires_at` 升序）。
 *
 * 一次只取一批：清理是**后台杂务**，不该和查询图上传抢连接，也不该在一次运行里扫全表。
 */
import type { Db } from '@fish/db/client'
import {
  deleteVisualQueryImageRow,
  listExpiredVisualQueryImages,
} from '@fish/db/visual-query-store'
import type { WorkerMediaStorage } from '../../media-storage'

/** 一轮最多清多少个对象：与 worker 轮询间隔（1s）配合，够用且不会长时间占住连接。 */
export const VISUAL_QUERY_CLEANUP_BATCH_SIZE = 100

export type VisualQueryCleanupResult = { scanned: number; deleted: number }

export async function cleanupExpiredVisualQueryImages(input: {
  db: Db
  storage: WorkerMediaStorage
  now: Date
  limit?: number
}): Promise<VisualQueryCleanupResult> {
  const rows = await listExpiredVisualQueryImages(input.db, {
    now: input.now,
    limit: input.limit ?? VISUAL_QUERY_CLEANUP_BATCH_SIZE,
  })

  let deleted = 0
  for (const row of rows) {
    await input.storage.deleteObject(row.objectKey)
    await deleteVisualQueryImageRow(input.db, row.id)
    deleted += 1
  }

  return { scanned: rows.length, deleted }
}
