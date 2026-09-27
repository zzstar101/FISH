import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from './cursor'

// 真实的 UUIDv7；内部查询仍绑定到 listings.id 这一 uuid 列。
const ID = '01930000-0000-7000-8000-000000000011'
const PUBLIC_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, ID)
const rawCursor = (id: string) =>
  Buffer.from(JSON.stringify({ sortKey: 1, id })).toString('base64url')

describe('cursor', () => {
  // newest 的 sortKey 是**微秒精度**的文本：用 Date.toISOString() 只会保留毫秒，
  // 同一毫秒内的行会在翻页时被跳过（见 store.test.ts 的回归用例）。
  test('round-trips a microsecond timestamp cursor', () => {
    const encoded = encodeCursor({ sortKey: '2026-09-12T03:40:10.123456Z', id: ID })
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      sortKey: '2026-09-12T03:40:10.123456Z',
      id: PUBLIC_ID,
    })
    expect(decodeCursor(encoded)).toEqual({ sortKey: '2026-09-12T03:40:10.123456Z', id: ID })
  })

  test('round-trips a price cursor', () => {
    const encoded = encodeCursor({ sortKey: 16000, id: ID })
    expect(decodeCursor(encoded)).toEqual({ sortKey: 16000, id: ID })
  })

  test('returns null for anything that is not a well-formed cursor', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from(`{"id":"${ID}"}`).toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('{"sortKey":1}').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('"plain-string"').toString('base64url'))).toBeNull()
    expect(
      decodeCursor(Buffer.from(`{"id":"${ID}","sortKey":null}`).toString('base64url')),
    ).toBeNull()
  })

  test('rejects non-finite numbers, which cannot be compared in SQL', () => {
    expect(decodeCursor(encodeCursor({ sortKey: Number.NaN, id: ID }))).toBeNull()
    expect(decodeCursor(encodeCursor({ sortKey: Number.POSITIVE_INFINITY, id: ID }))).toBeNull()
  })

  // 手写正则只能约束形状：`2026-13-45T99:99:99.999999Z` 与 `2026-02-31T…` 都能通过正则，
  // 却会被 PG 的 ::timestamptz 拒绝 → 500（实测）。契约 §2.1 要求 422，所以必须校验值域。
  test('rejects out-of-range timestamps that a shape-only check would let through', () => {
    expect(
      decodeCursor(encodeCursor({ sortKey: '2026-13-45T99:99:99.999999Z', id: ID })),
    ).toBeNull()
    expect(
      decodeCursor(encodeCursor({ sortKey: '2026-02-31T10:00:00.000000Z', id: ID })),
    ).toBeNull()
    expect(decodeCursor(encodeCursor({ sortKey: '2026-09-12T03:40:10.123Z', id: ID }))).toBeNull()
    expect(decodeCursor(encodeCursor({ sortKey: '2026-09-12T03:40:10Z', id: ID }))).toBeNull()
  })

  test('rejects bare UUID, wrong prefix and malformed public IDs before the DB lookup', () => {
    expect(decodeCursor(rawCursor(ID))).toBeNull()
    expect(decodeCursor(rawCursor(encodePublicId(PUBLIC_ID_PREFIX.user, ID)))).toBeNull()
    expect(decodeCursor(rawCursor(`${PUBLIC_ID}x`))).toBeNull()
    expect(decodeCursor(rawCursor('listing-1'))).toBeNull()
  })
})
