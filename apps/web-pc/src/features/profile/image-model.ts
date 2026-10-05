import type { ListingImage, ListingModerationStatus } from '@fish/contracts/listings/schema'

/**
 * 编辑商品弹窗的图片模型（#446）。**不引用任何 React**，供静态渲染测试。
 *
 * 契约边界（`packages/contracts/src/listings/schema.ts` 的 `ListingImageSchema`）：
 * - `objectKey` 只在卖家本人视角、且这把键当前**可被重新引用**时出现；
 * - **缺席 = 这张图不能保留** —— 被判 BLOCK 的图服务端会拒掉带着它的写请求
 *   （`IMAGE_CONTENT_BLOCKED`），所以进入编辑态时它被强制标记移除；
 * - PATCH 的 `objectKeys` 一旦出现就是**全量替换**，下标即 sortOrder（0 = 封面）。
 *
 * 因此「动图与否」是二态的：`dirty === false` 时不发 objectKeys（服务端不触碰图片），
 * `dirty === true` 时提交完整列表。不存在「只删一张、其余保持不动」的部分替换。
 */

export type EditExistingImage = {
  id: string
  url: string
  /** null = 契约未给键（不可重新引用），编辑态必须移除。 */
  objectKey: string | null
  moderationStatus: ListingModerationStatus | null
  removed: boolean
}

export type EditNewImage = {
  id: string
  previewUrl: string
  /** null = 上传中或失败；失败原因在 error。 */
  objectKey: string | null
  error: string | null
}

export type EditImageState = {
  dirty: boolean
  existing: EditExistingImage[]
  added: EditNewImage[]
}

export function existingImagesFromDetail(images: ReadonlyArray<ListingImage>): EditExistingImage[] {
  return images.map((image, index) => ({
    id: `existing-${index}`,
    url: image.url,
    objectKey: image.objectKey ?? null,
    moderationStatus: image.moderationStatus ?? null,
    removed: false,
  }))
}

/** 进入编辑态：不可重新引用的原图立即标记移除（保留它 = 提交必 422）。 */
export function enterImageEditMode(existing: EditExistingImage[]): EditExistingImage[] {
  return existing.map((image) => (image.objectKey === null ? { ...image, removed: true } : image))
}

/** 本次提交会带上的 objectKeys：保留的现有图 + 上传完成的新图，顺序即 sortOrder。 */
export function collectObjectKeys(
  existing: readonly EditExistingImage[],
  added: readonly EditNewImage[],
): { ok: true; keys: string[] } | { ok: false; error: string } {
  // 防御性守卫：正常流程里不可引用的行在进入编辑态时已被强制移除；
  // 若状态被改坏，宁可拦下提交也不静默丢图。
  if (existing.some((image) => image.objectKey === null && !image.removed)) {
    return { ok: false, error: '有原图无法保留，请先移除它再保存' }
  }

  const keys = [
    ...existing
      .filter((image) => !image.removed && image.objectKey !== null)
      .map((image) => image.objectKey as string),
    ...added.filter((image) => image.objectKey !== null).map((image) => image.objectKey as string),
  ]

  // 与契约 `ObjectKeyListSchema`（min 1 / 不重复）同口径；该 schema 未导出，
  // 端上按同一文案校验，漂移会以 422 形式暴露。
  if (keys.length < 1) return { ok: false, error: '至少上传 1 张图片' }
  if (new Set(keys).size !== keys.length) return { ok: false, error: '同一张图片不能重复' }
  return { ok: true, keys }
}

/** 还能再加几张：上限减去保留中的现有图与已就绪的新图。 */
export function remainingImageSlots(
  existing: readonly EditExistingImage[],
  added: readonly EditNewImage[],
  maxImages: number,
): number {
  const kept = existing.filter((image) => !image.removed).length
  const ready = added.length
  return maxImages - kept - ready
}
