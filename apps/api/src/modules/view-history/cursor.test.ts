import { describe, expect, test } from 'bun:test'
import { decodeViewHistoryCursor, encodeViewHistoryCursor } from './cursor'

const listingId = '01930000-0000-7000-8000-0000000000b1'

describe('view history cursor', () => {
  test('往返：微秒时间戳与商品 id 原样回来', () => {
    const encoded = encodeViewHistoryCursor({
      viewedAt: '2026-10-02T01:02:03.000400Z',
      listingId,
    })
    expect(decodeViewHistoryCursor(encoded)).toEqual({
      viewedAt: '2026-10-02T01:02:03.000400Z',
      listingId,
    })
  })

  test('游标里只出现商品 Public ID，不带内部行 uuid', () => {
    const encoded = encodeViewHistoryCursor({ viewedAt: '2026-10-02T01:02:03.000400Z', listingId })
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      listingId: string
    }
    expect(decoded.listingId.startsWith('lst_')).toBe(true)
  })

  test('坏输入一律 null（不宽容解析）', () => {
    expect(decodeViewHistoryCursor('not-base64-json')).toBeNull()
    expect(decodeViewHistoryCursor(Buffer.from('[]', 'utf8').toString('base64url'))).toBeNull()

    // 裸 uuid：必须是 lst_ 前缀的公开 id。
    const bareUuid = Buffer.from(
      JSON.stringify({ viewedAt: '2026-10-02T01:02:03.000400Z', listingId }),
      'utf8',
    ).toString('base64url')
    expect(decodeViewHistoryCursor(bareUuid)).toBeNull()

    // 形状合法但日期非法（会被 ::timestamptz 拒绝 → 500），必须在进 SQL 前挡住。
    const badDate = Buffer.from(
      JSON.stringify({ viewedAt: '2026-13-99T99:99:99.000400Z', listingId: 'lst_x' }),
      'utf8',
    ).toString('base64url')
    expect(decodeViewHistoryCursor(badDate)).toBeNull()

    // 缺字段 / 类型不对。
    const missing = Buffer.from(JSON.stringify({ listingId: 'lst_x' }), 'utf8').toString(
      'base64url',
    )
    expect(decodeViewHistoryCursor(missing)).toBeNull()
  })
})
