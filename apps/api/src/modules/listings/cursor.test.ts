import { describe, expect, test } from 'bun:test'
import { decodeCursor, encodeCursor } from './cursor'

describe('cursor', () => {
  test('round-trips a timestamp cursor', () => {
    const encoded = encodeCursor({ sortKey: '2026-09-12T03:40:10.000Z', id: 'listing-1' })
    expect(decodeCursor(encoded)).toEqual({ sortKey: '2026-09-12T03:40:10.000Z', id: 'listing-1' })
  })

  test('round-trips a price cursor', () => {
    const encoded = encodeCursor({ sortKey: 16000, id: 'listing-1' })
    expect(decodeCursor(encoded)).toEqual({ sortKey: 16000, id: 'listing-1' })
  })

  // 契约 §2.1 规定 cursor 不透明：前端只能原样回传，所以这里刻意不承诺可读性，
  // 只承诺"伪造/截断的游标必须被拒"，否则用户会看到静默错乱的列表。
  test('returns null for anything that is not a well-formed cursor', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from('{"id":"x"}').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('{"sortKey":1}').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('"plain-string"').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('{"id":"x","sortKey":null}').toString('base64url'))).toBeNull()
  })

  test('rejects non-finite numbers, which cannot be compared in SQL', () => {
    expect(decodeCursor(encodeCursor({ sortKey: Number.NaN, id: 'x' }))).toBeNull()
    expect(decodeCursor(encodeCursor({ sortKey: Number.POSITIVE_INFINITY, id: 'x' }))).toBeNull()
  })
})
