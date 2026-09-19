import { describe, expect, test } from 'bun:test'
import { decodeCommentCursor, encodeCommentCursor } from './cursor'

const ID = '01930000-0000-7000-8000-000000000021'

describe('comment cursor', () => {
  test('round-trips a microsecond timestamp cursor', () => {
    const encoded = encodeCommentCursor({ createdAt: '2026-09-12T03:40:10.123456Z', id: ID })
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

  // 非 UUID 的 id 会被绑到 comments.id（uuid 列）→ 类型错误 → 500；契约要求 422。
  test('rejects a non-UUID id before it can reach the uuid column', () => {
    expect(
      decodeCommentCursor(
        encodeCommentCursor({ createdAt: '2026-09-12T03:40:10.000000Z', id: 'cm-1' }),
      ),
    ).toBeNull()
    expect(
      decodeCommentCursor(
        encodeCommentCursor({ createdAt: '2026-09-12T03:40:10.000000Z', id: `${ID}x` }),
      ),
    ).toBeNull()
  })
})
