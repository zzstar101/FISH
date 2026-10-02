import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCommentCursor, decodeMyCommentsCursor, encodeCommentCursor } from './cursor'

const ID = '01930000-0000-7000-8000-000000000021'
const REVIEW_ID = '01930000-0000-7000-8000-0000000000b1'

describe('comment cursor', () => {
  test('round-trips a microsecond timestamp cursor', () => {
    const encoded = encodeCommentCursor({ createdAt: '2026-09-12T03:40:10.123456Z', id: ID })
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toMatchObject({
      id: encodePublicId(PUBLIC_ID_PREFIX.comment, ID),
    })
    expect(decodeCommentCursor(encoded)).toEqual({
      createdAt: '2026-09-12T03:40:10.123456Z',
      id: ID,
    })
  })

  test('returns null for anything that is not a well-formed cursor', () => {
    expect(decodeCommentCursor('not-base64!!')).toBeNull()
    expect(decodeCommentCursor(Buffer.from(`{"id":"${ID}"}`).toString('base64url'))).toBeNull()
    expect(decodeCommentCursor(Buffer.from('[1,2]').toString('base64url'))).toBeNull()
    expect(
      decodeCommentCursor(Buffer.from(`{"id":"${ID}","createdAt":null}`).toString('base64url')),
    ).toBeNull()
  })

  // 形状合法但日期非法的串会被 PG 的 ::timestamptz 拒绝 → 500，而契约要求 422（与 listings 同款回归）。
  test('rejects out-of-range timestamps that a shape-only check would let through', () => {
    expect(
      decodeCommentCursor(
        encodeCommentCursor({ createdAt: '2026-13-45T99:99:99.999999Z', id: ID }),
      ),
    ).toBeNull()
    expect(
      decodeCommentCursor(encodeCommentCursor({ createdAt: '2026-09-12T03:40:10.123Z', id: ID })),
    ).toBeNull()
  })

  test('rejects a bare UUID, wrong prefix, and malformed public ID before SQL', () => {
    for (const id of [ID, encodePublicId(PUBLIC_ID_PREFIX.listing, ID), 'cm-1']) {
      const forged = Buffer.from(
        JSON.stringify({ createdAt: '2026-09-12T03:40:10.000000Z', id }),
      ).toString('base64url')
      expect(decodeCommentCursor(forged)).toBeNull()
    }
  })
})

describe('my-comments cursor（#195 PR2：来源感知 + PR1 旧游标兼容）', () => {
  const TS = '2026-09-12T03:40:10.123456Z'

  test('PR1 旧游标（无 source 字段）按 comment 解释：kind=comment|all 可用', () => {
    // PR1 的 encodeCommentCursor 签出的就是这种两字段格式
    const legacy = Buffer.from(
      JSON.stringify({ createdAt: TS, id: encodePublicId(PUBLIC_ID_PREFIX.comment, ID) }),
    ).toString('base64url')
    const decoded = decodeMyCommentsCursor(legacy, 'comment')
    expect(decoded).toEqual({ createdAt: TS, id: ID, source: 'comment' })
    expect(decodeMyCommentsCursor(legacy, 'all')?.source).toBe('comment')
  })

  test('PR1 旧游标在 kind=review 下被拒（评价页不认留言游标）', () => {
    const legacy = Buffer.from(
      JSON.stringify({ createdAt: TS, id: encodePublicId(PUBLIC_ID_PREFIX.comment, ID) }),
    ).toString('base64url')
    expect(decodeMyCommentsCursor(legacy, 'review')).toBeNull()
  })

  test('review 游标按 rvw_ 前缀校验与解码；错源游标拒绝', () => {
    const encoded = encodeCommentCursor({ createdAt: TS, id: REVIEW_ID }, 'review')
    expect(decodeMyCommentsCursor(encoded, 'review')).toEqual({
      createdAt: TS,
      id: REVIEW_ID,
      source: 'review',
    })
    expect(decodeMyCommentsCursor(encoded, 'comment')).toBeNull()
    // cmt_ 前缀的 id 冒充 review 游标 → 前缀校验挡下
    const forged = Buffer.from(
      JSON.stringify({
        createdAt: TS,
        id: encodePublicId(PUBLIC_ID_PREFIX.comment, ID),
        source: 'review',
      }),
    ).toString('base64url')
    expect(decodeMyCommentsCursor(forged, 'all')).toBeNull()
  })

  test('未知 source 值一律 null（不宽容解析）', () => {
    const forged = Buffer.from(JSON.stringify({ createdAt: TS, id: ID, source: 'wish' })).toString(
      'base64url',
    )
    expect(decodeMyCommentsCursor(forged, 'all')).toBeNull()
  })
})
