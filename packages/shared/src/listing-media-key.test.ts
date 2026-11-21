import { describe, expect, test } from 'bun:test'
import {
  isListingThumbnailKey,
  isPublicListingKey,
  LISTING_THUMBNAIL_SUFFIX,
  listingThumbnailKeyOf,
} from './listing-media-key'
import { encodePublicId, PUBLIC_ID_PREFIX } from './public-id'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const MEDIA_ID = '01930000-0000-7000-8000-0000000000c2'
const USER_KEY = encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)
const MEDIA_KEY = encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA_ID)

describe('listingThumbnailKeyOf', () => {
  test('规范公开键派生出 -thumb.webp 兄弟对象', () => {
    const original = `listings/${USER_KEY}/${MEDIA_KEY}.jpg`

    expect(isPublicListingKey(original)).toBe(true)
    expect(listingThumbnailKeyOf(original)).toBe(
      `listings/${USER_KEY}/${MEDIA_KEY}${LISTING_THUMBNAIL_SUFFIX}`,
    )
    expect(isListingThumbnailKey(listingThumbnailKeyOf(original) ?? '')).toBe(true)
  })

  test('没有缩略图的键返回 null（调用方保留原 URL）', () => {
    // seed 演示键的段名是固定 slug，不是 TypeID。
    expect(listingThumbnailKeyOf('listings/seed-k380/0.jpg')).toBeNull()
    // #286 之前的 legacy 键：第二段是裸 UUID，读地址走加密 token 代理。
    expect(
      listingThumbnailKeyOf(`listings/${USER_KEY}/01930000-0000-4000-8000-000000000001.jpg`),
    ).toBeNull()
    // 审核中的图在私有前缀下，从不生成缩略图。
    expect(listingThumbnailKeyOf(`listing-review-media/${USER_KEY}/${MEDIA_KEY}.jpg`)).toBeNull()
    // 允许的图片格式只有契约里的三种。
    expect(listingThumbnailKeyOf(`listings/${USER_KEY}/${MEDIA_KEY}.gif`)).toBeNull()
  })

  test('缩略图键只接受 webp 后缀', () => {
    expect(isListingThumbnailKey(`listings/${USER_KEY}/${MEDIA_KEY}-thumb.webp`)).toBe(true)
    expect(isListingThumbnailKey(`listings/${USER_KEY}/${MEDIA_KEY}-thumb.png`)).toBe(false)
    expect(isListingThumbnailKey(`listings/${USER_KEY}/${MEDIA_KEY}.webp`)).toBe(false)
    expect(isListingThumbnailKey(`listings/seed-k380/0-thumb.webp`)).toBe(false)
  })
})
