import { describe, expect, mock, test } from 'bun:test'
import type { AdminModerationQueueItem, AdminOverview } from '@fish/contracts/admin/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 静态渲染没有 router context：把 Link 桩成插值 params / search 的 <a>（本仓测试惯例，
// 见 history-view.test.tsx）。search 序列化进查询串，才能断言「返回时回到来处」这类
// URL-only 状态；moderation-page 还消费 useNavigate（容器段的筛选跳转），一并桩掉。
void mock.module('@tanstack/react-router', () => ({
  Link: (props: {
    to?: string
    params?: Record<string, string | undefined>
    search?: Record<string, unknown>
    children?: ReactNode
  }) => {
    let href = props.to ?? '#'
    for (const [key, value] of Object.entries(props.params ?? {})) {
      href = href.replace(`$${key}`, String(value))
    }
    const query = Object.entries(props.search ?? {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('&')
    if (query.length > 0) href = `${href}?${query}`
    return createElement('a', { href }, props.children)
  },
  // Outlet 与本目录其它测试文件保持一致（mock.module 在同进程内是共享的）。
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => {},
  // createFileRoute 与本目录其它测试文件保持一致（mock.module 在同进程内是共享的；
  // /admin/ index 路由的用例要 import 路由文件，靠它拿到 { path, options }）。
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

const { OverviewView } = await import('./overview-page')
const { ModerationRow } = await import('./moderation-page')

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

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

describe('OverviewView（概览全量统计）', () => {
  test('八个口径全部渲染、待审核与举报可点击', () => {
    const html = renderToStaticMarkup(createElement(OverviewView, { overview: OVERVIEW }))
    const text = textOf(html)
    expect(text).toContain('累计用户')
    expect(text).toContain('近 24h 新增用户')
    expect(text).toContain('待人工审核')
    expect(text).toContain('待处理举报')
    expect(text).toContain('生效中限制')
    expect((html.match(/href="\/admin\/moderation"/g) ?? []).length).toBe(1)
    // 「待处理举报」与「近 7 日举报」两张卡都链到举报队列。
    expect((html.match(/href="\/admin\/reports"/g) ?? []).length).toBe(2)
  })
})

const QUEUE_ITEM: AdminModerationQueueItem = {
  record: {
    id: 'mdr_01AAAAAAAAAAAAAAAAAAAAAA',
    listingId: 'lst_01AAAAAAAAAAAAAAAAAAAAAA',
    sellerId: 'usr_01AAAAAAAAAAAAAAAAAAAAAA',
    action: 'LISTING_SUBMIT',
    titleSnapshot: '考研数学资料',
    descriptionSnapshot: '全套四科，九成新',
    decision: 'REVIEW',
    matchedRules: ['EXTERNAL_CONTACT'],
    matchedTermsMasked: ['威*'],
    ruleVersion: 'r1',
    provider: 'LOCAL',
    providerRequestId: null,
    suggestion: 'Review',
    label: null,
    subLabel: 'EXTERNAL_CONTACT',
    score: null,
    createdAt: '2026-10-05T08:00:00.000Z',
  },
  listing: {
    id: 'lst_01AAAAAAAAAAAAAAAAAAAAAA',
    title: '考研数学资料',
    description: '全套四科，九成新',
    status: 'ACTIVE',
    moderationStatus: 'REVIEW',
    moderationReason: null,
    createdAt: '2026-10-05T08:00:00.000Z',
  },
  seller: { id: 'usr_01AAAAAAAAAAAAAAAAAAAAAA', nickname: '小明' },
}

describe('ModerationRow（队列行）', () => {
  test('标题、卖家、判定徽标与详情链接渲染，来源 tab 写进链接', () => {
    const html = renderToStaticMarkup(
      createElement(ModerationRow, { highlight: 'REVIEW', item: QUEUE_ITEM, tab: 'queue' }),
    )
    const text = textOf(html)
    expect(text).toContain('考研数学资料')
    expect(text).toContain('小明')
    expect(text).toContain('转人工')
    expect(text).toContain('本地词表')
    expect(html).toContain('/admin/moderation/mdr_01AAAAAAAAAAAAAAAAAAAAAA?tab=queue')
  })

  test('历史检索 tab 的行带 tab=records（返回时回到历史而非待审队列）', () => {
    const html = renderToStaticMarkup(
      createElement(ModerationRow, {
        highlight: 'BLOCK',
        item: { ...QUEUE_ITEM, record: { ...QUEUE_ITEM.record, decision: 'BLOCK' } },
        tab: 'records',
      }),
    )
    expect(html).toContain('/admin/moderation/mdr_01AAAAAAAAAAAAAAAAAAAAAA?tab=records')
  })

  test('provider 文案取自 MODERATION_PROVIDER_META（不再内联三元）', () => {
    const html = renderToStaticMarkup(
      createElement(ModerationRow, {
        highlight: 'REVIEW',
        item: { ...QUEUE_ITEM, record: { ...QUEUE_ITEM.record, provider: 'TENCENT_TMS' } },
        tab: 'queue',
      }),
    )
    expect(textOf(html)).toContain('腾讯文本')
  })

  test('商品已删除时回退展示快照标题', () => {
    const html = renderToStaticMarkup(
      createElement(ModerationRow, {
        highlight: 'REVIEW',
        item: { ...QUEUE_ITEM, listing: null },
        tab: 'queue',
      }),
    )
    expect(textOf(html)).toContain('（商品已删除）考研数学资料')
  })
})
