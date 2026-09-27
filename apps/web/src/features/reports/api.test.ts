import { afterEach, expect, mock, test } from 'bun:test'
import { fetchMyReports, submitReport } from './api'

const originalFetch = globalThis.fetch
const targetId = 'lst_01jc000000e00800000000000k'
const report = {
  id: 'rpt_01jc000000e00800000000000a',
  targetType: 'LISTING',
  targetId,
  reason: 'FRAUD',
  detailText: null,
  status: 'PENDING',
  createdAt: '2026-09-26T00:00:00.000Z',
  handledAt: null,
} as const

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('创建举报按资源前缀校验并解析 200 已存在结果', async () => {
  let calls = 0
  let requestBody: unknown
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1
    requestBody = JSON.parse(String(init?.body))
    return Response.json({ report, created: false })
  }) as unknown as typeof fetch

  await expect(
    submitReport({
      targetType: 'LISTING',
      targetId: 'usr_01jc000000e00800000000000a',
      reason: 'FRAUD',
    }),
  ).rejects.toThrow()
  expect(calls).toBe(0)

  const result = await submitReport({ targetType: 'LISTING', targetId, reason: 'FRAUD' })
  expect(result.created).toBe(false)
  expect(result.report.id).toBe(report.id)
  expect(requestBody).toEqual({ targetType: 'LISTING', targetId, reason: 'FRAUD' })
})

test('我的举报透传不透明游标并拒绝错误前缀的响应', async () => {
  let url = ''
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    url = String(input)
    return Response.json({ items: [report], nextCursor: 'next+/=' })
  }) as unknown as typeof fetch

  const result = await fetchMyReports('prev+/=')
  expect(url).toBe('/api/reports/mine?limit=20&cursor=prev%2B%2F%3D')
  expect(result.nextCursor).toBe('next+/=')

  globalThis.fetch = mock(async () =>
    Response.json({
      items: [{ ...report, targetId: '01930000-0000-7000-8000-000000000013' }],
      nextCursor: null,
    }),
  ) as unknown as typeof fetch
  await expect(fetchMyReports()).rejects.toThrow()
})
