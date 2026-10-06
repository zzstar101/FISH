import { describe, expect, mock, test } from 'bun:test'

/**
 * 订单取数失败的**分类**（#304 / #182）。
 *
 * 以前三种失败在页面上是同一句话（`LoadError` 的默认「加载失败 / 检查网络后重试」），
 * 但用户能做的事完全不同：401 是登录态没了（重新登录）、`request:fail` 是请求根本没到
 * 服务端（检查网络/稍后重试）、404 / 5xx 是服务端答了一个错误信封（重试也没用，得看日志）。
 *
 * 这里只替换 `@/features/transaction/api` —— 分类判据（`isUnauthenticatedError` /
 * `isNetworkFailure`）、留痕与文案都走真实模块，用例覆盖的是「真实错误形状 → 真实分类」。
 * `__ALLOW_MOCK_FALLBACK__` 取 false：这个文件是**真实联调/生产口径**，失败就是失败，
 * 不许摆演示订单（演示构建那条分支见 `order-list-state.test.ts`）。
 */

mock.module('@tarojs/taro', () => ({ default: {} }))

// 必须在动态 import 之前：`features/load-failure.ts` 在模块求值阶段就读这个常量。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: false })

/** 形状对齐 `src/lib/request.ts` 的 `isApiError`：`name === 'ApiError'` + string code + number status。 */
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

let failure: unknown = new Error('用例没有设置失败')

mock.module('@/features/transaction/api', () => ({
  fetchAllTransactions: () => Promise.reject(failure),
}))

const { classifyFailure, failureCopy } = await import('../src/features/load-failure')
const { loadOrders } = await import('../src/features/fetchers')

describe('loadOrders：真实失败不摆演示订单，三类失败各自可辨（#304）', () => {
  test('401 UNAUTHENTICATED → unauthenticated', async () => {
    failure = new FakeApiError(401, 'UNAUTHENTICATED', '请先登录')

    expect(await loadOrders('buyer')).toEqual({
      items: [],
      failureKind: 'unauthenticated',
      truncated: false,
    })
  })

  test('请求没到服务端（request:fail）→ network', async () => {
    failure = new Error('request:fail network error')

    expect(await loadOrders('buyer')).toEqual({
      items: [],
      failureKind: 'network',
      truncated: false,
    })
  })

  test('服务端错误信封（404）→ server', async () => {
    failure = new FakeApiError(404, 'NOT_FOUND', '找不到这笔交易')

    expect(await loadOrders('seller')).toEqual({
      items: [],
      failureKind: 'server',
      truncated: false,
    })
  })

  test('契约解析失败 → server（不是 network）', async () => {
    // 契约漂移时 zod 抛的是普通 Error，不能因为「不是 ApiError」就被当成断网。
    failure = new Error('Invalid input: expected string, received undefined')

    expect(classifyFailure(failure)).toBe('server')
  })
})

describe('failureCopy：三类失败给出可区分的文案（#304）', () => {
  test('三种分类的标题与正文两两不同，且都非空', () => {
    const kinds = ['unauthenticated', 'network', 'server'] as const

    for (const kind of kinds) {
      expect(failureCopy(kind).title.length).toBeGreaterThan(0)
      expect(failureCopy(kind).text.length).toBeGreaterThan(0)
    }

    const titles = kinds.map((kind) => failureCopy(kind).title)
    const texts = kinds.map((kind) => failureCopy(kind).text)
    expect(new Set(titles).size).toBe(3)
    expect(new Set(texts).size).toBe(3)
  })
})
