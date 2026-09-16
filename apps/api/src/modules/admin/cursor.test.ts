import { describe, expect, test } from 'bun:test'
import { decodeCursor, encodeCursor } from './cursor'

const ID = '01930000-0000-7000-8000-00000000000a'

describe('admin cursor', () => {
  test('encode → decode round trip', () => {
    const encoded = encodeCursor('2026-09-12T03:40:10.123456Z', ID)
    expect(decodeCursor(encoded)).toEqual({ createdAt: '2026-09-12T03:40:10.123456Z', id: ID })
  })

  test('only accepts microsecond-precision timestamps', () => {
    // 毫秒精度（无 .123456）会让人在同一毫秒里的行翻页时被跳过（与 listings newes 同因）。
    expect(decodeCursor(encodeCursor('2026-09-12T03:40:10.123Z', ID))).toBeNull()
    expect(decodeCursor(encodeCursor('2026-09-12T03:40:10Z', ID))).toBeNull()
  })

  test('rejects invalid date values (would otherwise 500 on ::timestamptz)', () => {
    // Integer overflow: NaN / Infinity / out-of-range
    expect(decodeCursor(encodeCursor('2026-13-45T99:99:99.999999Z', ID))).toBeNull()
    expect(decodeCursor(encodeCursor('2026-02-31T10:00:00.000000Z', ID))).toBeNull()
  })

  test('rejects non-uuid ids and malformed cursors', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from('no-pipe-delimiter', 'utf8').toString('base64url'))).toBeNull()
    expect(decodeCursor(encodeCursor('2026-09-12T03:40:10.123456Z', 'listing-1'))).toBeNull()
  })
})
