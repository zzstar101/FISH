import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { decodeCommentCursor, encodeCommentCursor } from './cursor'

const ID = '01930000-0000-7000-8000-000000000021'

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
