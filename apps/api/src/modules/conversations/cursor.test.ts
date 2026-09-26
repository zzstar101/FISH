import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCursor, encodeCursor, isCursorTimestamp } from './cursor'

const ID = '01930000-0000-7000-8000-0000000000a1'
const TS = '2026-09-12T03:40:10.123456Z'
const rawCursor = (id: string) =>
  Buffer.from(JSON.stringify({ sortKey: TS, id })).toString('base64url')

describe('conversations cursor', () => {
  test('round-trips sortKey and id without exposing a UUID', () => {
    const encoded = encodeCursor({ sortKey: TS, id: ID })
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      sortKey: TS,
      id: encodePublicId(PUBLIC_ID_PREFIX.conversation, ID),
    })
    expect(decodeCursor(encoded)).toEqual({ sortKey: TS, id: ID })
  })

  test('transaction cursors use txn_ and reject a conversation cursor', () => {
    const transactionCursor = encodeCursor({ sortKey: TS, id: ID }, PUBLIC_ID_PREFIX.transaction)
    expect(JSON.parse(Buffer.from(transactionCursor, 'base64url').toString('utf8')).id).toBe(
      encodePublicId(PUBLIC_ID_PREFIX.transaction, ID),
    )
    expect(decodeCursor(transactionCursor, PUBLIC_ID_PREFIX.transaction)).toEqual({
      sortKey: TS,
      id: ID,
    })
    expect(decodeCursor(transactionCursor)).toBeNull()
    expect(
      decodeCursor(encodeCursor({ sortKey: TS, id: ID }), PUBLIC_ID_PREFIX.transaction),
    ).toBeNull()
  })

  test('rejects malformed base64 / json / shapes', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from('{"id":"x"}').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
    expect(
      decodeCursor(Buffer.from(`{"id":"${ID}","sortKey":123}`).toString('base64url')),
    ).toBeNull()
    // Bare UUID / wrong prefix / malformed ID must not reach the UUID column.
    expect(decodeCursor(rawCursor(ID))).toBeNull()
    expect(decodeCursor(rawCursor(encodePublicId(PUBLIC_ID_PREFIX.user, ID)))).toBeNull()
    expect(decodeCursor(rawCursor('cnv_bad'))).toBeNull()
  })

  test('isCursorTimestamp requires microsecond precision and valid calendar values', () => {
    expect(isCursorTimestamp(TS)).toBe(true)
    // JS Date 只有毫秒：毫秒精度输入会被放过后丢精度，必须拒绝
    expect(isCursorTimestamp('2026-09-12T03:40:10.123Z')).toBe(false)
    // 形状合法但日历值非法（PG ::timestamptz 会拒绝 → 500）
    expect(isCursorTimestamp('2026-13-45T99:99:99.999999Z')).toBe(false)
    expect(isCursorTimestamp('2026-02-31T10:00:00.000000Z')).toBe(false)
  })
})
