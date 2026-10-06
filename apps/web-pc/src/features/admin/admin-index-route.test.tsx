import { describe, expect, mock, test } from 'bun:test'
import type { AdminOverview } from '@fish/contracts/admin/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * `beb81a89` 补了 /admin/ index 路由（此前只有子路由，`/admin` 深链是空的），
 * admin-shell 的导航与「返回概览」都指向它，却一直没有任何用例证明「这行注册还在、
 * 渲染的是概览页」（#472 审查发现 §5：fix 提交必须带一个修复前会失败的用例）。
 *
 * 这里**不桩 admin-queries**：概览页走真实的 `useAdminOverview`，靠预置查询缓存喂数据
 * ——`mock.module` 在同进程内共享，少一个桩就少一分踩到本目录其它测试文件的风险。
 * router 桩只负责让 `<Link>` 在没有 router context 时也能静态渲染（`createFileRoute`
 * 一并桩掉并保持 `{ path, options }` 形状，本目录其它文件的桩也补齐了这个导出）。
 */
void mock.module('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
  Link: (props: { to?: string; children?: ReactNode }) =>
    createElement('a', { href: props.to ?? '#' }, props.children),
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => {},
}))

const { adminKeys } = await import('./admin-queries')
const { Route } = await import('../../routes/admin.index')

const OVERVIEW: AdminOverview = {
  totalUsers: 12,
  newUsersLast24h: 2,
  activeListings: 30,
  completedTransactions: 5,
  pendingReviewRecords: 1,
  pendingReports: 3,
  reportsLast7d: 4,
  activeRestrictions: 0,
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

/** 渲染 /admin/ 路由自己的 component（真实 OverviewPage），数据来自预置缓存。 */
function renderIndexRoute(): string {
  const component = Route.options.component
  if (component === undefined) throw new Error('/admin/ 路由没有 component')

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(adminKeys.overview(), OVERVIEW)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(component, null)),
  )
}

describe('admin index 路由（beb81a89）', () => {
  test('路由可渲染，渲染出的是平台概览（八个统计口径）', () => {
    const html = renderIndexRoute()
    const text = textOf(html)
    expect(text).toContain('平台概览')
    expect(text).toContain('累计用户')
    expect(text).toContain('待处理举报')
    expect(html).toContain('>12<')
  })
})
