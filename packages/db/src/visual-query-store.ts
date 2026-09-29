import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm'
import type { Db } from './client'
import { newId } from './ids'
import { visualQueryImages } from './schema/visual-query-images'

/**
 * 查询图台账（#324 M2）：登记上传、标记消费、取到期对象供清理。
 *
 * 三个函数对应生命周期三段，**没有第四个**：查询图不进 Listing 媒体、不参与任何读模型，
 * 所以不存在"查询图的查询接口"。
 */

export type VisualQueryImageRow = {
  id: string
  objectKey: string
  subjectType: string
  subjectKey: string
  expiresAt: Date
}

export type InsertVisualQueryImageInput = {
  objectKey: string
  /** `user`（登录）或 `session`（匿名）。原始 IP 永不落库。 */
  subjectType: 'user' | 'session'
  subjectKey: string
  contentType: string
  sizeBytes: number
  expiresAt: Date
}

export async function insertVisualQueryImage(
  executor: Pick<Db, 'insert'>,
  input: InsertVisualQueryImageInput,
): Promise<void> {
  await executor.insert(visualQueryImages).values({
    id: newId(),
    objectKey: input.objectKey,
    subjectType: input.subjectType,
    subjectKey: input.subjectKey,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    expiresAt: input.expiresAt,
  })
}

/**
 * 查一个对象键是否是**本主体**登记过的查询图。
 *
 * 这是"服务端不相信客户端给的 objectKey"的落地：搜索接口只接受
 * 「键形状合法 + 台账里存在 + 主体一致 + 未过期」的键，否则任何人都能拿别人的键
 * 或一个任意 `listings/…` 键来搜索（后者会把公开商品图当成查询图，虽然不泄漏什么，
 * 但会让"查询图生命周期"这套约束形同虚设）。
 */
export async function findUsableVisualQueryImage(
  executor: Pick<Db, 'select'>,
  input: { objectKey: string; subjectType: 'user' | 'session'; subjectKey: string; now: Date },
): Promise<VisualQueryImageRow | null> {
  const rows = await executor
    .select({
      id: visualQueryImages.id,
      objectKey: visualQueryImages.objectKey,
      subjectType: visualQueryImages.subjectType,
      subjectKey: visualQueryImages.subjectKey,
      expiresAt: visualQueryImages.expiresAt,
    })
    .from(visualQueryImages)
    .where(
      and(
        eq(visualQueryImages.objectKey, input.objectKey),
        eq(visualQueryImages.subjectType, input.subjectType),
        eq(visualQueryImages.subjectKey, input.subjectKey),
        sql`${visualQueryImages.expiresAt} > ${input.now}`,
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * 标记"这张查询图被真的用于一次搜索"。只写一次（`used_at is null` 守卫），
 * 返回值 = 本次是否首次标记：第一次搜索才算一次有效使用，重复搜索不重复计数。
 */
export async function markVisualQueryImageUsed(
  executor: Pick<Db, 'update'>,
  objectKey: string,
): Promise<boolean> {
  const rows = await executor
    .update(visualQueryImages)
    .set({ usedAt: sql`now()` })
    .where(and(eq(visualQueryImages.objectKey, objectKey), isNull(visualQueryImages.usedAt)))
    .returning({ id: visualQueryImages.id })

  return rows.length > 0
}

/** 取下一批到期对象（按到期时刻升序，先到期的先删）。 */
export async function listExpiredVisualQueryImages(
  executor: Pick<Db, 'select'>,
  input: { now: Date; limit: number },
): Promise<VisualQueryImageRow[]> {
  return executor
    .select({
      id: visualQueryImages.id,
      objectKey: visualQueryImages.objectKey,
      subjectType: visualQueryImages.subjectType,
      subjectKey: visualQueryImages.subjectKey,
      expiresAt: visualQueryImages.expiresAt,
    })
    .from(visualQueryImages)
    .where(lt(visualQueryImages.expiresAt, input.now))
    .orderBy(asc(visualQueryImages.expiresAt))
    .limit(input.limit)
}

/**
 * 删台账行。**调用方必须先删对象再删行**：反过来的话，删除对象失败就再也不知道该删哪个键了
 * （对象会一直留到永远）。行删不掉只是多清一次，对象删不掉才是真的泄漏。
 */
export async function deleteVisualQueryImageRow(
  executor: Pick<Db, 'delete'>,
  id: string,
): Promise<void> {
  await executor.delete(visualQueryImages).where(eq(visualQueryImages.id, id))
}
