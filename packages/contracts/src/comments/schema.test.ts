import { describe, expect, test } from 'bun:test'
import {
  CommentContentSchema,
  CommentCreateInputSchema,
  CommentDtoSchema,
  CommentListQuerySchema,
} from './schema'

const AUTHOR = { id: '01930000-0000-7000-8000-00000000000a', nickname: '阿岚', avatarUrl: null }
const LISTING_ID = '01930000-0000-7000-8000-000000000011'

function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: '01930000-0000-7000-8000-000000000021',
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
      id: '01930000-0000-7000-8000-000000000022',
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
