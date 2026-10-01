import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import {
  findListingByNumber,
  isAbortError,
  isListingNumberQuery,
  listingNumberPath,
  lookupErrorMessage,
  numberQueryHint,
} from './number-lookup'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** 契约注释里的示例编号（`router.test.ts` 同款）。 */
const VALID_NO = '348572910466'

describe('isListingNumberQuery（输入分类：编号 vs 关键词）', () => {
  test('合法 12 位数字（首位非 0）命中，前后空格先 trim', () => {
    expect(isListingNumberQuery(VALID_NO)).toBe(true)
    expect(isListingNumberQuery(`  ${VALID_NO}  `)).toBe(true)
    expect(isListingNumberQuery('100000000000')).toBe(true)
  })

  test('编号按字符串判，首位 0 / 位数不对 / 带字母都不是编号', () => {
    // 首位 0：契约明确 never coerce to number，这里若数字强转就会丢前导零变合法。
    expect(isListingNumberQuery('012345678901')).toBe(false)
    expect(isListingNumberQuery('12345678901')).toBe(false)
    expect(isListingNumberQuery('1234567890123')).toBe(false)
    expect(isListingNumberQuery('34857291046a')).toBe(false)
    expect(isListingNumberQuery('')).toBe(false)
  })

  test('普通关键词（含短数字串）都不算编号', () => {
    expect(isListingNumberQuery('自行车')).toBe(false)
    expect(isListingNumberQuery('12345')).toBe(false)
  })
})

describe('numberQueryHint（像编号但不合法 → 提示，不发 by-number 请求）', () => {
  test('纯数字 9–14 位但不满足契约 → 给提示', () => {
    expect(numberQueryHint('12345678901')).not.toBeNull()
    expect(numberQueryHint('012345678901')).not.toBeNull()
    expect(numberQueryHint('1234567890123')).not.toBeNull()
  })

  test('合法编号、短关键词、带字母的输入都不提示', () => {
    expect(numberQueryHint(VALID_NO)).toBeNull()
    expect(numberQueryHint('12345')).toBeNull()
    expect(numberQueryHint('自行车')).toBeNull()
    expect(numberQueryHint('34857291046a')).toBeNull()
  })

  test('提示是「已按关键词搜索」的口径：不打断搜索，只解释发生了什么', () => {
    expect(numberQueryHint('12345678901')).toContain('已按关键词搜索')
  })
})

describe('listingNumberPath（path 拼装）', () => {
  test('走 by-number 端点，编号原样进路径（字符串，无数字强转）', () => {
    expect(listingNumberPath(VALID_NO)).toBe(`/listings/by-number/${VALID_NO}`)
    expect(listingNumberPath('100000000000')).toBe('/listings/by-number/100000000000')
  })
})

describe('findListingByNumber', () => {
  function stubFetch(payload: unknown, status: number) {
    return mock(async () => Response.json(payload, { status })) as unknown as typeof fetch
  }

  test('GET /listings/by-number/:no，命中返回 canonical lst_ ID', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Response.json({ id: 'lst_01jc000000e00800000000000t' })
    }) as unknown as typeof fetch

    const id = await findListingByNumber(VALID_NO)

    expect(calls).toEqual([`/api/listings/by-number/${VALID_NO}`])
    expect(id).toBe('lst_01jc000000e00800000000000t')
  })

  test('404 LISTING_NOT_FOUND 收敛成 null：编号不存在 / 已下架 / 不可见是同一个 404（无存在性 oracle）', async () => {
    globalThis.fetch = stubFetch(
      { error: { code: 'LISTING_NOT_FOUND', message: '商品不存在或不可见' } },
      404,
    )
    expect(await findListingByNumber(VALID_NO)).toBeNull()
  })

  test('其它来源的裸 404（如代理层，被包成 INTERNAL_ERROR）不吞成「没这件商品」', async () => {
    globalThis.fetch = stubFetch({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 404)
    await expect(findListingByNumber(VALID_NO)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  test('非法入参在函数内被拦下，一个请求都不发（编号不能未验证就拼进 URL）', async () => {
    let called = 0
    globalThis.fetch = mock(async () => {
      called += 1
      return Response.json({ id: 'lst_01jc000000e00800000000000t' })
    }) as unknown as typeof fetch

    await expect(findListingByNumber('012345678901')).rejects.toThrow('非法的商品编号')
    await expect(findListingByNumber('34857291046a')).rejects.toThrow('非法的商品编号')
    expect(called).toBe(0)
  })

  test('429 限频必须抛出，不能当成「没这件商品」', async () => {
    globalThis.fetch = stubFetch(
      {
        error: {
          code: 'LISTING_LOOKUP_RATE_LIMITED',
          message: '查询太频繁',
          retryAfterSeconds: 30,
        },
      },
      429,
    )
    try {
      await findListingByNumber(VALID_NO)
      throw new Error('应当抛错')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).retryAfterSeconds).toBe(30)
    }
  })

  test('响应形状漂移在进 UI 前暴露', async () => {
    globalThis.fetch = stubFetch({ id: 'not-a-listing-id' }, 200)
    await expect(findListingByNumber(VALID_NO)).rejects.toThrow()
  })
})

describe('lookupErrorMessage', () => {
  test('429 优先消费服务端 retryAfterSeconds', () => {
    expect(
      lookupErrorMessage(
        new ApiError('LISTING_LOOKUP_RATE_LIMITED', 429, '查询太频繁', undefined, 30),
      ),
    ).toBe('查询太频繁，请 30 秒后再试')
    expect(lookupErrorMessage(new ApiError('LISTING_LOOKUP_RATE_LIMITED', 429, '查询太频繁'))).toBe(
      '查询太频繁，请稍后再试',
    )
  })

  test('503（匿名 IP 拿不到）给「稍后再试」，其余透传服务端 message', () => {
    expect(lookupErrorMessage(new ApiError('LISTING_LOOKUP_IP_UNAVAILABLE', 503, 'x'))).toBe(
      '暂时无法查询编号，请稍后再试',
    )
    expect(lookupErrorMessage(new ApiError('INTERNAL_ERROR', 500, '请求失败'))).toBe('请求失败')
    expect(lookupErrorMessage(new TypeError('fetch failed'))).toBe('网络异常，请稍后重试')
  })
})

describe('isAbortError', () => {
  test('只有名为 AbortError 的错误算取消，其余不算', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(isAbortError(abort)).toBe(true)
    expect(isAbortError(new TypeError('fetch failed'))).toBe(false)
  })
})
