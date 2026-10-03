import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  commentListPath,
  createComment,
  createReply,
  deleteComment,
  describeCommentDeleteFailure,
  describeCommentFailure,
} from './comments-api'

describe('commentListPath', () => {
  test('sets the contract limit and passes the cursor through', () => {
    expect(commentListPath('lst_01jc000000e00800000000000t')).toBe(
      '/listings/lst_01jc000000e00800000000000t/comments?limit=50',
    )
    expect(commentListPath('lst_01jc000000e00800000000000t', 'abc+/=')).toBe(
      '/listings/lst_01jc000000e00800000000000t/comments?limit=50&cursor=abc%2B%2F%3D',
    )
  })
})

describe('comment write contracts', () => {
  test('rejects an empty comment before making a request', async () => {
    const originalFetch = globalThis.fetch
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return new Response(null, { status: 500 })
    }) as unknown as typeof fetch
    try {
      await expect(createComment('lst_01jc000000e00800000000000t', '   ')).rejects.toBeDefined()
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('createReply', () => {
  test('parses the single-level reply response with CommentReplySchema', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id: 'cmt_01jc000000e00800000000004b',
          listingId: 'lst_01jc000000e00800000000004c',
          author: {
            id: 'usr_01jc000000e00800000000000b',
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
      const reply = await createReply('cmt_01jc000000e00800000000004a', '还在的')
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

describe('deleteComment', () => {
  const COMMENT_ID = 'cmt_01jc000000e00800000000004a'

  test('sends DELETE /comments/:id and parses the deleted count', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; method: string }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, method: init?.method ?? 'GET' })
      return new Response(JSON.stringify({ deleted: 3 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    try {
      const result = await deleteComment(COMMENT_ID)
      expect(result.deleted).toBe(3)
      expect(calls).toEqual([{ url: `/api/comments/${COMMENT_ID}`, method: 'DELETE' }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('a repeat delete is the idempotent { deleted: 0 }, not an error', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ deleted: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch
    try {
      await expect(deleteComment(COMMENT_ID)).resolves.toEqual({ deleted: 0 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('describeCommentDeleteFailure', () => {
  test('surfaces the server wording instead of inventing its own', () => {
    // 404 的语义就是「存在但不是本人的」（服务端不做存在性混淆，留言 id 本可由匿名接口枚举），
    // 端上原样透传，不另编一句更含蓄的话
    expect(describeCommentDeleteFailure(new ApiError('COMMENT_NOT_FOUND', 404, '留言不存在'))).toBe(
      '留言不存在',
    )
    expect(describeCommentDeleteFailure(new ApiError('LISTING_NOT_FOUND', 404, '商品不存在'))).toBe(
      '商品不存在',
    )
    expect(describeCommentDeleteFailure(new Error('network'))).toBe('删除失败，请重试')
  })
})
