import { expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  isListingReviewMediaKey,
  listingReviewMediaPrefix,
  REVIEW_MEDIA_URL_TTL_SECONDS,
  reviewMediaKey,
  reviewMediaToken,
} from './review-media'

const userId = '01930000-0000-7000-8000-000000000001'
const mediaId = '01930000-0000-7000-8000-000000000002'
const key = `${listingReviewMediaPrefix(userId)}${encodePublicId(PUBLIC_ID_PREFIX.media, mediaId)}.jpg`
const secret = 'a-secret-for-test-purposes-longer-than-32-characters'
const now = 1_800_000_000

test('审核中图片的读取令牌可稳定解出对象键，且不暴露对象键或 UUID', () => {
  const expiresAt = now + REVIEW_MEDIA_URL_TTL_SECONDS
  const token = reviewMediaToken(key, secret, expiresAt)
  expect(token).toBe(reviewMediaToken(key, secret, expiresAt))
  expect(token).not.toContain('listing-review-media')
  expect(token).not.toContain(userId)
  expect(reviewMediaKey(token, secret, now)).toBe(key)
  expect(reviewMediaKey(token, `${secret}wrong`, now)).toBeNull()
  expect(reviewMediaKey(`${token.slice(0, -1)}!`, secret, now)).toBeNull()
  expect(reviewMediaKey(Buffer.from(key).toString('base64url'), secret, now)).toBeNull()
})

test('令牌到期即失效，有效期常量与缓存策略一致', () => {
  expect(REVIEW_MEDIA_URL_TTL_SECONDS).toBe(900)
  const expiresAt = now + REVIEW_MEDIA_URL_TTL_SECONDS
  const token = reviewMediaToken(key, secret, expiresAt)
  expect(reviewMediaKey(token, secret, expiresAt - 1)).toBe(key)
  expect(reviewMediaKey(token, secret, expiresAt)).toBeNull()
  expect(reviewMediaKey(token, secret, expiresAt + 1)).toBeNull()
})

test('畸形令牌一律拒绝，不进入解密路径', () => {
  expect(reviewMediaKey('', secret, now)).toBeNull()
  expect(reviewMediaKey('!!!!', secret, now)).toBeNull()
  expect(reviewMediaKey('a'.repeat(500), secret, now)).toBeNull()
  expect(reviewMediaKey(`${reviewMediaToken(key, secret, now + 60)}!`, secret, now)).toBeNull()
})

test('只能封装审核中私有键，其他前缀、路径遍历与脏 TypeID 都拒', () => {
  const expiresAt = now + REVIEW_MEDIA_URL_TTL_SECONDS
  expect(() => reviewMediaToken('listings/u/1.jpg', secret, expiresAt)).toThrow()
  expect(() => reviewMediaToken(`listing-review-media/../${key}`, secret, expiresAt)).toThrow()
  expect(() => reviewMediaToken(key, secret, 0)).toThrow()
  expect(() => reviewMediaToken(key, secret, 1.5)).toThrow()

  expect(isListingReviewMediaKey(key)).toBe(true)
  expect(isListingReviewMediaKey(`listing-media/${userId}/x.jpg`)).toBe(false)
  expect(isListingReviewMediaKey('listing-review-media/seed-1/2.jpg')).toBe(false)
  expect(
    isListingReviewMediaKey(
      `listing-review-media/${userId}/01930000-0000-4000-8000-000000000002.jpg`,
    ),
  ).toBe(false)
})
