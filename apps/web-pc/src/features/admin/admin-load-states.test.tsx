import { describe, expect, mock, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../lib/api-client'

/**
 * 只读页失败态的分支（#467 五审 P3）：403 → 整页无权限、404 → 缺失态（**都不给「重试」**）、
 * 其余才给可重试的错误态。
 *
 * 手法：**不桩 `./admin-queries`**（`mock.module` 在同进程内共享，桩掉它会把别的测试文件
 * 一起带偏——本目录已经踩过一次：`useAdminOverview` 被桩成无数据后，`admin-index-route.test.tsx`
 * 的概览页渲染崩在 `overview.totalUsers`）。这里改为用真实 hook + 预置 query 缓存的 error 态，
 * 让页面自己走到失败分支，断言「页面渲染出来是什么」。
 * `retryOnMount: false`（`retry: false` 只管重试次数）保证不会真的发请求：预置的是 error 态，
 * 页面 hooks 的 staleTime 为 0，不关掉挂载重试就会在渲染时打一次网络。
 */

void mock.module('@tanstack/react-router', () => ({
  Link: (props: { to?: string; children?: ReactNode }) =>
    createElement('a', { href: props.to ?? '#' }, props.children),
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => undefined,
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

const { adminKeys } = await import('./admin-queries')
const { ListingDetailPage } = await import('./listing-detail-page')
const { MetricsPage } = await import('./metrics-page')
const { ModerationDetailPage } = await import('./moderation-detail-page')
const { OverviewPage } = await import('./overview-page')
const { ReportDetailPage } = await import('./report-detail-page')
const { UserDetailPage } = await import('./user-detail-page')

const LISTING_ID = 'lst_01jc000000e00800000000000a'
const USER_ID = 'usr_01jc000000e00800000000000a'
const RECORD_ID = 'mdr_01jc000000e00800000000000a'
const REPORT_ID = 'rpt_01jc000000e00800000000000a'

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

/** 把某个 queryKey 预置成 error 态，再静态渲染页面：页面里的真实 hook 会直接读到失败。 */
function renderFailed(node: ReactNode, queryKey: readonly unknown[], error: Error): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: false, retryOnMount: false },
    },
  })
  const query = client.getQueryCache().build(client, {
    queryFn: async () => undefined,
    queryKey,
  })
  query.setState({ error, fetchStatus: 'idle', status: 'error' })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node))
}

const detailPages: ReadonlyArray<{
  name: string
  node: () => ReactNode
  key: readonly unknown[]
}> = [
  {
    key: adminKeys.listingDetail(LISTING_ID),
    name: '商品详情',
    node: () => createElement(ListingDetailPage, { listingId: LISTING_ID, search: {} }),
  },
  {
    key: adminKeys.userDetail(USER_ID),
    name: '用户详情',
    node: () => createElement(UserDetailPage, { search: {}, userId: USER_ID }),
  },
  {
    key: adminKeys.moderationDetail(RECORD_ID),
    name: '审核详情',
    node: () =>
      createElement(ModerationDetailPage, { recordId: RECORD_ID, search: { tab: 'queue' } }),
  },
  {
    key: adminKeys.reportDetail(REPORT_ID),
    name: '举报详情',
    node: () =>
      createElement(ReportDetailPage, { reportId: REPORT_ID, search: { status: 'PENDING' } }),
  },
]

describe('只读页失败态（#467 五审 P3：403 / 404 不给重试）', () => {
  test('404：给缺失态文案与返回列表入口，页面里没有「重试」', () => {
    const error = new ApiError('ADMIN_NOT_FOUND', 404, '目标不存在')
    for (const page of detailPages) {
      const text = textOf(renderFailed(page.node(), page.key, error))
      expect(`${page.name}:${text.includes('不存在或已被删除')}`).toBe(`${page.name}:true`)
      expect(`${page.name}:${text.includes('返回列表')}`).toBe(`${page.name}:true`)
      expect(`${page.name}:${text.includes('重试')}`).toBe(`${page.name}:false`)
    }
  })

  test('403：给整页无权限态，页面里没有「重试」', () => {
    const error = new ApiError('FORBIDDEN', 403, '无权限')
    for (const page of detailPages) {
      const text = textOf(renderFailed(page.node(), page.key, error))
      expect(`${page.name}:${text.includes('无管理权限')}`).toBe(`${page.name}:true`)
      expect(`${page.name}:${text.includes('重试')}`).toBe(`${page.name}:false`)
    }
  })

  test('概览 / 指标页同样区分 403（以前只有一个可重试的错误态）', () => {
    const error = new ApiError('FORBIDDEN', 403, '无权限')

    const overview = textOf(renderFailed(createElement(OverviewPage), adminKeys.overview(), error))
    expect(overview).toContain('无管理权限')
    expect(overview).not.toContain('重试')

    const metrics = textOf(
      renderFailed(
        createElement(MetricsPage, { search: { window: '24h' } }),
        adminKeys.metrics('24h'),
        error,
      ),
    )
    expect(metrics).toContain('无管理权限')
    expect(metrics).not.toContain('重试')
  })

  test('404 之外的非权限失败仍可重试，文案来自后端 message', () => {
    const error = new ApiError('INTERNAL_ERROR', 500, '服务器开小差了')
    const text = textOf(
      renderFailed(
        createElement(UserDetailPage, { search: {}, userId: USER_ID }),
        adminKeys.userDetail(USER_ID),
        error,
      ),
    )
    expect(text).toContain('服务器开小差了')
    expect(text).toContain('重试')
  })
})
