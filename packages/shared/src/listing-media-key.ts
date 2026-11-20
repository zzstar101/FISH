import { isPublicId, PUBLIC_ID_PREFIX } from './public-id'

/**
 * 公开商品图键与它们的列表缩略图键（#620）。
 *
 * 放在 `@fish/shared` 而不是 `apps/api`：API 在写入与拼读地址时用它派生缩略图键，worker 在回收
 * 被替换掉的商品图时用它把同一个缩略图对象一并删掉。两边各写一份名字规则迟早会漂移
 * （同 `image-mime` 的取舍：API 与 worker 都需要同一个实现）。
 *
 * 缩略图是**派生对象**：`listings/{usr}/{med}.{ext}` → `listings/{usr}/{med}-thumb.webp`。
 * 派生只对规范公开键成立 —— legacy UUID 键、审核中的私有键、seed 演示键都没有缩略图。
 */
export const LISTING_THUMBNAIL_SUFFIX = '-thumb.webp'

const PUBLIC_LISTING_KEY = /^listings\/([^/]+)\/([^/.]+)\.(?:jpg|png|webp)$/
const LISTING_THUMBNAIL_KEY = /^listings\/([^/]+)\/([^/.]+)-thumb\.webp$/

/**
 * 规范公开键：`listings/{usr_…}/{med_…}.{jpg|png|webp}`。
 *
 * 两段都必须是规范 TypeID：只匹配前缀形状的话，`listings/seed-k380/0.jpg` 也会被当成用户媒体，
 * 而它走的是演示数据链路、没有缩略图。
 */
export function isPublicListingKey(key: string): boolean {
  const match = PUBLIC_LISTING_KEY.exec(key)
  return Boolean(
    match &&
      isPublicId(PUBLIC_ID_PREFIX.user, match[1]) &&
      isPublicId(PUBLIC_ID_PREFIX.media, match[2]),
  )
}

/** 缩略图键形状：`listings/{usr_…}/{med_…}-thumb.webp`（两段都必须是规范 TypeID）。 */
export function isListingThumbnailKey(key: string): boolean {
  const match = LISTING_THUMBNAIL_KEY.exec(key)
  return Boolean(
    match &&
      isPublicId(PUBLIC_ID_PREFIX.user, match[1]) &&
      isPublicId(PUBLIC_ID_PREFIX.media, match[2]),
  )
}

/** 公开固化键 → 缩略图键；不是规范公开键时返回 `null`（调用方必须保留原 URL）。 */
export function listingThumbnailKeyOf(publicKey: string): string | null {
  if (!isPublicListingKey(publicKey)) return null
  return `${publicKey.slice(0, publicKey.lastIndexOf('.'))}${LISTING_THUMBNAIL_SUFFIX}`
}
