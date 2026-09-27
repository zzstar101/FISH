import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { commentListPath, createReply, describeCommentFailure } from './comments-api'

describe('commentListPath', () => {
  test('sets the contract limit and passes the cursor through', () => {
    expect(commentListPath('listing-1')).toBe('/listings/listing-1/comments?limit=50')
    expect(commentListPath('listing-1', 'abc+/=')).toBe(
      '/listings/listing-1/comments?limit=50&cursor=abc%2B%2F%3D',
    )
  })
})

describe('createReply', () => {
  test('parses the single-level reply response with CommentReplySchema', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: '01930000-0000-7000-8000-000000000022',
          listingId: '01930000-0000-7000-8000-000000000011',
          author: {
            id: '01930000-0000-7000-8000-00000000000b',
            nickname: '小北',
            avatarUrl: null,
          },
          content: '还在的',
          createdAt: '2026-01-01T00:00:00.000Z',
          isSeller: false,
          replies: [],
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch
    try {
      const reply = await createReply('01930000-0000-7000-8000-000000000021', '还在的')
      expect(reply.replies).toEqual([])
      expect(reply.content).toBe('还在的')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('describeCommentFailure', () => {
  test('maps contract errors without pretending success', () => {
    expect(describeCommentFailure(new ApiError('COMMENT_CONTENT_BLOCKED', 422, 'blocked'))).toBe(
      '留言内容未通过审核，请修改后重试',
    )
    expect(describeCommentFailure(new ApiError('COMMENT_NOT_FOUND', 404, 'missing'))).toBe(
      '留言不存在或已失效',
    )
    expect(describeCommentFailure(new ApiError('LISTING_NOT_FOUND', 404, 'missing'))).toBe(
      '商品不存在或已下架',
    )
    expect(describeCommentFailure(new Error('network'))).toBe('提交失败，请重试')
  })
})
