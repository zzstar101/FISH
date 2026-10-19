import { beforeEach, expect, mock, test } from 'bun:test'

/**
 * 详情取数的错误分类（#497）。
 *
 * 非参与人看到的 404 与「争议不存在」是**同一个码**，所以 404 必须落「看不到这条争议」的
 * 友好态，而不是「加载失败 + 重试」；其余失败（5xx / 断网）才给重试。这条分界线错了，
 * 用户会对着一个永远重试不出来的按钮打转。
 */

// `features/load-failure` 在模块加载时读构建期注入的常量，bun 里没有 => 先补上
Object.assign(globalThis, { __ALLOW_MOCK_FALLBACK__: false, __DEMO_AUTH__: false })

class MockApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

let failure: unknown = null

mock.module('@/lib/request', () => ({
  apiRequest: async () => {
    throw failure
  },
  isApiError: (error: unknown) => error instanceof MockApiError,
  isUnauthenticatedError: () => false,
}))

const { loadDisputeDetail } = await import('@/features/disputes/load')

beforeEach(() => {
  failure = null
})

test('404 / DISPUTE_NOT_FOUND 落 notFound：非参与人也要看到友好态', async () => {
  failure = new MockApiError('DISPUTE_NOT_FOUND', 404)
  await expect(loadDisputeDetail('dsp_x')).resolves.toEqual({ state: 'notFound' })
  // 规范化 ID 之外的 404 也按不可见处理（服务端对非法 ID 直接 404）
  failure = new MockApiError('SOMETHING_ELSE', 404)
  await expect(loadDisputeDetail('dsp_x')).resolves.toEqual({ state: 'notFound' })
})

test('5xx 与断网落 failed：给重试，不伪装成「不存在」', async () => {
  failure = new MockApiError('INTERNAL_ERROR', 500)
  expect(await loadDisputeDetail('dsp_x')).toEqual({ state: 'failed' })
  failure = new Error('request:fail')
  expect(await loadDisputeDetail('dsp_x')).toEqual({ state: 'failed' })
})
