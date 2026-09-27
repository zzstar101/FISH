import { describe, expect, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  conversationStartError,
  listingMatchPath,
  myListingsForMatchesPath,
  parseBudgetCents,
  wishActionError,
  wishListPath,
  wishMatchError,
  wishMatchPath,
} from './api'

describe('wish api paths', () => {
  test('wish list uses page/pageSize and optional status', () => {
    expect(wishListPath()).toBe('/wishes?page=1&pageSize=50')
    expect(wishListPath('ACTIVE')).toBe('/wishes?page=1&pageSize=50&status=ACTIVE')
    expect(wishListPath('FULFILLED', 2, 20)).toBe('/wishes?page=2&pageSize=20&status=FULFILLED')
  })

  test('match paths keep the target and limit query parameters', () => {
    expect(wishMatchPath('wish-1')).toBe('/matches?wishId=wish-1&limit=50')
    expect(listingMatchPath('listing-1', 10)).toBe('/matches?listingId=listing-1&limit=10')
  })

  test('my listing match entry keeps cursor opaque', () => {
    expect(myListingsForMatchesPath('owner-1')).toBe('/listings?sellerId=owner-1&limit=50')
    expect(myListingsForMatchesPath('owner-1', 'abc+/=')).toBe(
      '/listings?sellerId=owner-1&limit=50&cursor=abc%2B%2F%3D',
    )
  })
})

describe('wish form model', () => {
  test('parses yuan budget to integer cents without rounding extra precision', () => {
    expect(parseBudgetCents('')).toBeNull()
    expect(parseBudgetCents('', true)).toBe(0)
    expect(parseBudgetCents('0')).toBe(0)
    expect(parseBudgetCents('12.50')).toBe(1250)
    expect(parseBudgetCents('12.345')).toBeNull()
    expect(parseBudgetCents('-1')).toBeNull()
  })
})

describe('wish errors', () => {
  test('state conflicts refresh while permission errors stay explicit', () => {
    expect(wishActionError(new ApiError('CONFLICT', 409, '状态冲突'))).toEqual({
      message: '愿望状态已变化，正在刷新最新状态',
      refresh: true,
    })
    expect(wishActionError(new ApiError('FORBIDDEN', 403, '无权操作'))).toEqual({
      message: '只能操作自己的愿望',
      refresh: false,
    })
  })

  test('match and conversation errors do not masquerade as empty data', () => {
    expect(wishMatchError(new ApiError('NOT_TARGET_OWNER', 403, '无权查看'))).toBe(
      '只能查看自己愿望或商品的匹配结果',
    )
    expect(wishMatchError(new ApiError('MATCH_TARGET_NOT_FOUND', 404, '不存在'))).toBe(
      '匹配目标不存在或当前账号无权查看',
    )
    expect(conversationStartError(new ApiError('CANNOT_CHAT_WITH_SELF', 409, '不能聊自己'))).toBe(
      '不能和自己的商品发起会话',
    )
  })
})
