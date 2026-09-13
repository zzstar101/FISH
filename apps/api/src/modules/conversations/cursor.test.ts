import { describe, expect, test } from 'bun:test'
import { decodeCursor, encodeCursor, isCursorTimestamp } from './cursor'

const ID = '01930000-0000-7000-8000-0000000000a1'
const TS = '2026-09-12T03:40:10.123456Z'

describe('conversations cursor', () => {
  test('round-trips sortKey and id', () => {
    expect(decodeCursor(encodeCursor({ sortKey: TS, id: ID }))).toEqual({
      sortKey: TS,
      id: ID,
    })
  })

  test('rejects malformed base64 / json / shapes', () => {
    expect(decodeCursor('not-base64!!')).toBeNull()
    expect(decodeCursor(Buffer.from('{"id":"x"}').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
    expect(
      decodeCursor(Buffer.from(`{"id":"${ID}","sortKey":123}`).toString('base64url')),
    ).toBeNull()
    // 非 uuid 的 id 会在 SQL 绑定列上炸成 500，必须在入口挡掉
    expect(decodeCursor(encodeCursor({ sortKey: TS, id: 'conv-1' }))).toBeNull()
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
