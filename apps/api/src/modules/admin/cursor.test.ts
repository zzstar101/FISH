import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor } from './cursor'

const ID = '01930000-0000-7000-8000-00000000000a'
const PREFIX = PUBLIC_ID_PREFIX.auditLog

describe('admin cursor', () => {
  test('encode → decode round trip', () => {
    const encoded = encodeCursor('2026-09-12T03:40:10.123456Z', ID, PREFIX)
    expect(decodeCursor(encoded, PREFIX)).toEqual({
      createdAt: '2026-09-12T03:40:10.123456Z',
      id: ID,
    })
  })

  test('public admin cursors use the matching resource prefix and reject bare UUIDs', () => {
    const timestamp = '2026-09-12T03:40:10.123456Z'
    const prefixes = [
      PUBLIC_ID_PREFIX.user,
      PUBLIC_ID_PREFIX.listing,
      PUBLIC_ID_PREFIX.auditLog,
      PUBLIC_ID_PREFIX.moderationRecord,
      PUBLIC_ID_PREFIX.transaction,
    ] as const
    for (const prefix of prefixes) {
      const encoded = encodeCursor(timestamp, ID, prefix)
      expect(Buffer.from(encoded, 'base64url').toString('utf8')).toBe(
        `${timestamp}|${encodePublicId(prefix, ID)}`,
      )
      expect(decodeCursor(encoded, prefix)).toEqual({ createdAt: timestamp, id: ID })
      const legacy = Buffer.from(`${timestamp}|${ID}`).toString('base64url')
      expect(decodeCursor(legacy, prefix)).toBeNull()
      expect(decodeCursor(encoded, PUBLIC_ID_PREFIX.report)).toBeNull()
    }
  })

  test('only accepts microsecond-precision timestamps', () => {
    // 毫秒精度（无 .123456）会让人在同一毫秒里的行翻页时被跳过（与 listings newes 同因）。
    expect(decodeCursor(encodeCursor('2026-09-12T03:40:10.123Z', ID, PREFIX), PREFIX)).toBeNull()
    expect(decodeCursor(encodeCursor('2026-09-12T03:40:10Z', ID, PREFIX), PREFIX)).toBeNull()
  })

  test('rejects invalid date values (would otherwise 500 on ::timestamptz)', () => {
    // Integer overflow: NaN / Infinity / out-of-range
    expect(decodeCursor(encodeCursor('2026-13-45T99:99:99.999999Z', ID, PREFIX), PREFIX)).toBeNull()
    expect(decodeCursor(encodeCursor('2026-02-31T10:00:00.000000Z', ID, PREFIX), PREFIX)).toBeNull()
  })

  test('rejects non-uuid ids and malformed cursors', () => {
    expect(decodeCursor('not-base64!!', PREFIX)).toBeNull()
    expect(
      decodeCursor(Buffer.from('no-pipe-delimiter', 'utf8').toString('base64url'), PREFIX),
    ).toBeNull()
    const invalid = Buffer.from('2026-09-12T03:40:10.123456Z|listing-1').toString('base64url')
    expect(decodeCursor(invalid, PREFIX)).toBeNull()
  })
})
