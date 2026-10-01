import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeFavoritesCursor, encodeFavoritesCursor } from './cursor'

const listingUuid = '01990000-0000-7000-8000-0000000000b1'
const listingPublicId = encodePublicId(PUBLIC_ID_PREFIX.listing, listingUuid)
const stamp = '2026-09-12T03:00:00.123456Z'

/** 手搓一个"解码器会接受"的游标：只有形状合法、值域合法的才该被放行。 */
function raw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

describe('favorites cursor', () => {
  test('round-trips (createdAt, listingId)', () => {
    const encoded = encodeFavoritesCursor({ createdAt: stamp, listingId: listingUuid })
    expect(decodeFavoritesCursor(encoded)).toEqual({ createdAt: stamp, listingId: listingUuid })
  })

  test('carries only the listing public id, never the internal row id', () => {
    // 游标对端上是不透明的，但 base64url 可解 —— 里面不该出现内部行 uuid。
    const encoded = encodeFavoritesCursor({ createdAt: stamp, listingId: listingUuid })
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      listingId: string
    }
    expect(payload.listingId).toBe(listingPublicId)
    expect(payload.listingId.startsWith('lst_')).toBe(true)
  })

  test('keeps microseconds so same-millisecond rows stay distinguishable', () => {
    const later = encodeFavoritesCursor({
      createdAt: '2026-09-12T03:00:00.123700Z',
      listingId: listingUuid,
    })
    const earlier = encodeFavoritesCursor({
      createdAt: '2026-09-12T03:00:00.123300Z',
      listingId: listingUuid,
    })
    expect(later).not.toBe(earlier)
  })

  test('rejects anything it cannot prove valid instead of guessing', () => {
    expect(decodeFavoritesCursor('not-base64-json')).toBeNull()
    // 缺 listingId
    expect(decodeFavoritesCursor(raw({ createdAt: stamp }))).toBeNull()
    // 裸 uuid：进 uuid 列之前必须挡住，否则 SQL 500
    expect(decodeFavoritesCursor(raw({ createdAt: stamp, listingId: listingUuid }))).toBeNull()
    // 前缀不对（usr_ 而不是 lst_）
    expect(
      decodeFavoritesCursor(
        raw({ createdAt: stamp, listingId: encodePublicId(PUBLIC_ID_PREFIX.user, listingUuid) }),
      ),
    ).toBeNull()
    // 形状像时间戳但日期非法：会被 `::timestamptz` 拒绝 → 必须在这里判死
    expect(
      decodeFavoritesCursor(
        raw({ createdAt: '2026-13-45T99:99:99.999999Z', listingId: listingPublicId }),
      ),
    ).toBeNull()
    // 非对象
    expect(decodeFavoritesCursor(raw([stamp, listingPublicId]))).toBeNull()
  })
})
