import { describe, expect, mock, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'

/**
 * `fetchMyListings` 的翻页上限与「这份列表是不是全部」。
 *
 * 它封顶 5 页（250 件）防 cursor 异常时无限循环。封顶意味着**结果可能不是全部**，
 * 而页面上有两处会据此下结论：分段计数与「已经到底了 · N 件」。所以这个函数必须把
 * 「后面还有」这件事如实交给调用方（`truncated`），否则页面会拿一份不完整的列表
 * 当全部来断言（与 `components/order-list` 的 `truncated` 同一问题）。
 *
 * 替换的是 `@/lib/request` 的 `apiRequest`（只此一处），这样用例同时覆盖真实模块的
 * **请求构造**（路径、query、cursor 的原样回传）与契约解析。手法与
 * `wishes-api.test.ts` 一致：`mock.module` 后再动态 import 被测模块。
 */

type ApiCall = {
  path: string
  query?: Record<string, unknown>
  method?: string
}

const calls: ApiCall[] = []

/** 一页 feed 响应；`nextCursor` 为 null 表示这是最后一页 */
function page(count: number, nextCursor: string | null) {
  return {
    items: Array.from({ length: count }, (_, i) => card(`${i}-${nextCursor ?? 'last'}`)),
    nextCursor,
  }
}

function card(id: string): ListingCard {
  return {
    id: crypto.randomUUID(),
    title: `闲置 ${id}`,
    priceCents: 1000,
    category: 'BOOKS',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    moderationStatus: 'APPROVED',
  }
}

let respond: (call: ApiCall) => unknown = () => page(0, null)

/*
 * 顶替 `@/lib/request` 时**必须给出它的全部导出**：`mock.module` 在 Bun 里是按模块路径
 * 全局注册的，同一个进程里别的测试文件（`wishes-api.test.ts` / `order-list-state.test.ts`……）
 * 若从同一模块取 `isUnauthenticatedError`，缺这个键就会 `SyntaxError: Export named … not found`，
 * 整个文件被跳过。`ApiError` 给个真实类，`isApiError` 在这里用不到（本文件不覆盖失败路径）。
 */
class FakeApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

mock.module('@/lib/request', () => ({
  ApiError: FakeApiError,
  isApiError: (error: unknown) => error instanceof FakeApiError,
  isUnauthenticatedError: (error: unknown) =>
    error instanceof FakeApiError && error.status === 401 && error.code === 'UNAUTHENTICATED',
  apiRequest: (
    path: string,
    options: { query?: Record<string, unknown>; method?: string } = {},
  ) => {
    const call: ApiCall = { path, query: options.query, method: options.method }
    calls.push(call)
    return Promise.resolve(respond(call))
  },
}))

const { fetchMyListings } = await import('../src/features/listing/api')

const SELLER = '11111111-1111-4111-8111-111111111111'

describe('fetchMyListings —— 翻页与 truncated', () => {
  test('遇到 nextCursor 为 null 就停：列表是全部，truncated 为 false', async () => {
    let n = 0
    respond = () => {
      n += 1
      return n === 1 ? page(50, 'c1') : page(3, null)
    }
    calls.length = 0

    const result = await fetchMyListings(SELLER)

    expect(result.items).toHaveLength(53)
    expect(result.truncated).toBe(false)
    expect(calls).toHaveLength(2)
    // 只查本人、只翻这一页：cursor 原样回传上一页的 nextCursor（契约禁止解析）
    expect(calls[0]?.query).toMatchObject({ sellerId: SELLER, cursor: undefined })
    expect(calls[1]?.query).toMatchObject({ sellerId: SELLER, cursor: 'c1' })
  })

  test('走满 5 页仍然后面还有：truncated 为 true，且不再继续拉第 6 页', async () => {
    let pageNo = 0
    respond = () => {
      pageNo += 1
      return page(50, `c${pageNo}`)
    }
    calls.length = 0

    const result = await fetchMyListings(SELLER)

    expect(result.items).toHaveLength(250)
    expect(result.truncated).toBe(true)
    expect(calls).toHaveLength(5)
  })

  test('一条都没有时不算「不完整」（空列表也是确定的全部）', async () => {
    respond = () => page(0, null)
    calls.length = 0

    const result = await fetchMyListings(SELLER)

    expect(result.items).toEqual([])
    expect(result.truncated).toBe(false)
  })

  test('游标没前进（服务端重复给同一页）时不收这一页，按「不完整」返回', async () => {
    /*
     * 服务端若把同一个 cursor 再给一遍，收下就等于把同一页叠 5 次：250 张重复卡片、
     * React key 重复，而且「仅显示最近 250 件」是句假话（其实只有 50 件不同的）。
     * 判据与 `fetchAllTransactions` 同源：不前进 = 后面还有，只是这一页不能算数。
     */
    respond = (call) => (call.query?.cursor === undefined ? page(50, 'c1') : page(50, 'c1'))
    calls.length = 0

    const result = await fetchMyListings(SELLER)

    // 第一页收下（它把 cursor 推到了 c1），第二页发现没前进就停下
    expect(result.items).toHaveLength(50)
    expect(result.truncated).toBe(true)
    expect(calls).toHaveLength(2)
  })
})
