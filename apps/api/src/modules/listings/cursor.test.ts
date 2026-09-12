import { describe, expect, test } from 'bun:test'
import { decodeCursor, encodeCursor } from './cursor'

// 真实的 UUIDv7（契约里 id 是 z.uuid()，且它最终会绑到 listings.id 这一 uuid 列上）
const ID = '01930000-0000-7000-8000-000000000011'

describe('cursor', () => {
  // newest 的 sortKey 是**微秒精度**的文本：用 Date.toISOString() 只会保留毫秒，
  // 同一毫秒内的行会在翻页时被跳过（见 store.test.ts 的回归用例）。
  test('round-trips a microsecond timestamp cursor', () => {
    const encoded = encodeCursor({ sortKey: '2026-09-12T03:40:10.123456Z', id: ID })
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

  // 非 UUID 的 id 会被绑到 listings.id（uuid 列）→ PostgreSQL 报类型错误 → 500；
  // 契约要求这种情况是 422（§2.1「非法 cursor → 422」），所以必须在解码阶段拒掉。
  test('rejects a non-UUID id before it can reach the uuid column', () => {
    expect(decodeCursor(encodeCursor({ sortKey: 1, id: 'listing-1' }))).toBeNull()
    expect(decodeCursor(encodeCursor({ sortKey: 1, id: '1' }))).toBeNull()
    expect(decodeCursor(encodeCursor({ sortKey: 1, id: `${ID}x` }))).toBeNull()
  })
})
