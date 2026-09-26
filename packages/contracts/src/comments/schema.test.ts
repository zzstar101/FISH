import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import {
  CommentContentSchema,
  CommentCreateInputSchema,
  CommentDtoSchema,
  CommentListQuerySchema,
  CommentReplySchema,
} from './schema'

const AUTHOR = {
  id: encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-00000000000a'),
  nickname: '阿岚',
  avatarUrl: null,
}
const LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-000000000011')
const REPLY_ID = encodePublicId(PUBLIC_ID_PREFIX.comment, '01930000-0000-7000-8000-000000000022')

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.comment, '01930000-0000-7000-8000-000000000021'),
    listingId: LISTING_ID,
    author: AUTHOR,
    content: '还在吗？',
    createdAt: '2026-09-12T03:40:10.000Z',
    isSeller: false,
    replies: [],
    ...overrides,
  }
}

describe('CommentContentSchema', () => {
  test('trims and accepts a normal comment', () => {
    expect(CommentContentSchema.parse('  还在吗  ')).toBe('还在吗')
  })

  test('rejects whitespace-only content', () => {
    expect(CommentContentSchema.safeParse('   ').success).toBe(false)
  })

  test('rejects content over 200 chars', () => {
    expect(CommentContentSchema.safeParse('字'.repeat(200)).success).toBe(true)
    expect(CommentContentSchema.safeParse('字'.repeat(201)).success).toBe(false)
  })
})

describe('CommentCreateInputSchema', () => {
  test('rejects extra fields (strict)', () => {
    expect(CommentCreateInputSchema.safeParse({ content: 'hi', parentId: 'x' }).success).toBe(false)
  })

  test('rejects an empty body', () => {
    expect(CommentCreateInputSchema.safeParse({}).success).toBe(false)
  })
})

describe('CommentListQuerySchema', () => {
  test('applies the default limit and coerces query strings', () => {
    expect(CommentListQuerySchema.parse({})).toEqual({ limit: 20 })
    expect(CommentListQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 })
  })

  test('rejects limit out of 1..50 and a blank cursor', () => {
    expect(CommentListQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(CommentListQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(CommentListQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  })

  test('rejects offset-style params (strict)', () => {
    expect(CommentListQuerySchema.safeParse({ page: 2 }).success).toBe(false)
  })
})

describe('CommentDtoSchema', () => {
  test('accepts a top-level comment with one level of replies', () => {
    const reply = comment({
      id: REPLY_ID,
      content: '还在的',
      isSeller: true,
    })
    expect(CommentDtoSchema.safeParse(comment({ replies: [reply] })).success).toBe(true)
  })

  test('accepts a null avatarUrl but rejects a malformed one', () => {
    expect(CommentDtoSchema.safeParse(comment()).success).toBe(true)
    expect(
      CommentDtoSchema.safeParse(comment({ author: { ...AUTHOR, avatarUrl: 'not-a-url' } }))
        .success,
    ).toBe(false)
  })

  test('rejects a non-uuid id before it can reach the uuid column', () => {
    expect(CommentDtoSchema.safeParse(comment({ id: 'cm-001' })).success).toBe(false)
  })
})

// 契约只允许一层回复；这是防「服务端漂移出二级回复」的回归用例（评审阻断项 1）。
describe('CommentReplySchema — 回复的 replies 必须为空', () => {
  test('accepts a reply with an empty replies array', () => {
    const reply = comment({ id: REPLY_ID })
    expect(CommentReplySchema.safeParse(reply).success).toBe(true)
  })

  test('rejects a reply that itself carries replies', () => {
    const nested = comment({ id: '01930000-0000-7000-8000-000000000023' })
    const reply = comment({
      id: '01930000-0000-7000-8000-000000000022',
      replies: [nested],
    })
    expect(CommentReplySchema.safeParse(reply).success).toBe(false)
  })

  test('rejects a top-level comment whose reply nests another reply', () => {
    const nested = comment({ id: '01930000-0000-7000-8000-000000000023' })
    const reply = comment({
      id: '01930000-0000-7000-8000-000000000022',
      replies: [nested],
    })
    expect(CommentDtoSchema.safeParse(comment({ replies: [reply] })).success).toBe(false)
  })
})
