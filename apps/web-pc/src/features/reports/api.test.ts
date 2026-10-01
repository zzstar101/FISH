import { afterEach, describe, expect, mock, test } from 'bun:test'
import { ApiError } from '../../lib/api-client'
import { fetchMyReports, submitReport } from './api'

const originalFetch = globalThis.fetch

const LISTING_ID = 'lst_01jc000000e00800000000000t'
const REPORT_ID = 'rpt_01jc000000e00800000000000a'

const report = {
  id: REPORT_ID,
  targetType: 'LISTING',
  targetId: LISTING_ID,
  reason: 'MISLEADING',
  detailText: null,
  status: 'PENDING',
  createdAt: '2026-09-30T00:00:00.000Z',
  handledAt: null,
} as const

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('reports API', () => {
  test('posts the create payload to the contract route and parses the response', async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = []
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      return Response.json({ report, created: true }, { status: 201 })
    }) as unknown as typeof fetch

    const result = await submitReport({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
      detailText: '描述与实物不符',
    })

    expect(result.created).toBe(true)
    expect(calls).toEqual([
      {
        url: '/api/reports',
        method: 'POST',
        body: {
          targetType: 'LISTING',
          targetId: LISTING_ID,
          reason: 'MISLEADING',
          detailText: '描述与实物不符',
        },
      },
    ])
  })

  /**
   * 重复举报同一目标时服务端返回 **200 + `created: false`**（把已有的未决单原样交回），
   * 不是错误。契约刻意不用 409：超时重试在客户端看来也是一次失败，而举报其实已经受理了。
   * 这条断言是「端上不得把重复举报当失败弹错」这道验收的守卫。
   */
  test('treats a duplicate report (200 + created:false) as a successful submit', async () => {
    globalThis.fetch = mock(async () =>
      Response.json({ report, created: false }, { status: 200 }),
    ) as unknown as typeof fetch

    await expect(
      submitReport({ targetType: 'LISTING', targetId: LISTING_ID, reason: 'MISLEADING' }),
    ).resolves.toEqual({ report, created: false })
  })

  test('surfaces the contract error code when the target is gone', async () => {
    globalThis.fetch = mock(async () =>
      Response.json(
        { error: { code: 'REPORT_TARGET_NOT_FOUND', message: '举报目标不存在' } },
        { status: 404 },
      ),
    ) as unknown as typeof fetch

    const error = await submitReport({
      targetType: 'LISTING',
      targetId: LISTING_ID,
      reason: 'MISLEADING',
    }).catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('REPORT_TARGET_NOT_FOUND')
  })

  test('pages my reports with limit and, when given, the opaque cursor', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(url)
      return Response.json({ items: [report], nextCursor: null })
    }) as unknown as typeof fetch

    await expect(fetchMyReports()).resolves.toEqual({ items: [report], nextCursor: null })
    await expect(fetchMyReports('cur-1')).resolves.toEqual({ items: [report], nextCursor: null })
    expect(calls).toEqual(['/api/reports/mine?limit=20', '/api/reports/mine?limit=20&cursor=cur-1'])
  })
})
