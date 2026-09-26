import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { commentListPath, describeCommentFailure } from './comments-api'

describe('commentListPath', () => {
  test('sets the contract limit and passes the cursor through', () => {
    expect(commentListPath('listing-1')).toBe('/listings/listing-1/comments?limit=50')
    expect(commentListPath('listing-1', 'abc+/=')).toBe(
      '/listings/listing-1/comments?limit=50&cursor=abc%2B%2F%3D',
    )
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
