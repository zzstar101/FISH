import { describe, expect, mock, test } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 举报 / 交易两页的筛选接线测试（#467 审查发现 Spec a-① a-② c-① 的回归防护）：
 * 1. 举报「全部」可达（修复前 FilterChips 传出的 undefined 被 `?? 'PENDING'` 强转回待处理）；
 * 2. 举报「原因」筛选有了 UI 与「正在按原因过滤」提示条；
 * 3. 交易页把契约已有的 buyerId/sellerId/listingId 暴露成输入框 + 提示条 + 清除。
 * 手法沿用 `admin-pages.test.tsx`：桩掉 router 与查询 hook，静态渲染、抓 hook 入参。
 */

type CapturedReportsFilters = {
  status?: string
  targetType?: string
  reason?: string
}

type CapturedTransactionsFilters = {
  q?: string
  status?: string
  buyerId?: string
  sellerId?: string
  listingId?: string
  createdFrom?: string
  createdTo?: string
}

let lastReportsFilters: CapturedReportsFilters | null = null
let lastTransactionsFilters: CapturedTransactionsFilters | null = null

/** 空的一页无限查询结果：界面会走「空态」分支，同时把入参留给断言。 */
function emptyInfiniteResult() {
  return {
    data: { pageParams: [], pages: [{ items: [], nextCursor: null }] },
    error: null,
    fetchNextPage: () => undefined,
    hasNextPage: false,
    isError: false,
    isFetchNextPageError: false,
    isFetchingNextPage: false,
    isPending: false,
    isSuccess: true,
    refetch: () => undefined,
  }
}

void mock.module('./admin-queries', () => ({
  useAdminReports: (filters: CapturedReportsFilters) => {
    lastReportsFilters = filters
    return emptyInfiniteResult()
  },
  useAdminTransactions: (filters: CapturedTransactionsFilters) => {
    lastTransactionsFilters = filters
    return emptyInfiniteResult()
  },
}))

void mock.module('@tanstack/react-router', () => ({
  Link: (props: { to?: string; children?: ReactNode }) =>
    createElement('a', { href: props.to ?? '#' }, props.children),
  // Outlet 与本目录其它测试文件保持一致（mock.module 在同进程内是共享的）。
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => {},
}))

const { ReportsPage, REPORTS_STATUS_ALL, parseReportsSearch } = await import('./reports-page')
const { TransactionsPage, parseTransactionsSearch } = await import('./transactions-page')

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

describe('举报页 status（「全部」可达）', () => {
  test('缺省仍是待处理，显式 ALL 解析为全状态视图', () => {
    expect(parseReportsSearch({})).toEqual({ status: 'PENDING' })
    expect(parseReportsSearch({ status: 'HANDLED' })).toEqual({ status: 'HANDLED' })
    expect(parseReportsSearch({ status: REPORTS_STATUS_ALL })).toEqual({
      status: REPORTS_STATUS_ALL,
    })
  })

  test('?status=ALL 时按全状态查询（不再回落 PENDING），空态文案对应全状态', () => {
    const html = renderToStaticMarkup(
      createElement(ReportsPage, { search: { status: REPORTS_STATUS_ALL } }),
    )
    expect(lastReportsFilters?.status).toBeUndefined()
    expect(textOf(html)).toContain('还没有任何举报。')
  })

  test('待处理视图把 PENDING 透传给服务端，空态文案保持队列口径', () => {
    const html = renderToStaticMarkup(createElement(ReportsPage, { search: { status: 'PENDING' } }))
    expect(lastReportsFilters?.status).toBe('PENDING')
    expect(textOf(html)).toContain('没有待处理的举报。')
  })
})

describe('举报页 reason 筛选（契约已有但 UI 缺失）', () => {
  test('八种原因全部可选，选中的原因透传并给出提示条与清除', () => {
    const html = renderToStaticMarkup(
      createElement(ReportsPage, { search: { reason: 'FRAUD', status: 'PENDING' } }),
    )
    const text = textOf(html)
    // FilterChips 的组名渲染成 sr-only legend（不是 aria-label）。
    expect(text).toContain('举报原因筛选')
    for (const label of [
      '描述与实物不符',
      '违禁品或禁售物',
      '涉嫌欺诈',
      '垃圾广告或引流',
      '骚扰',
      '冒充他人',
      '辱骂或恶意行为',
      '其他',
    ]) {
      expect(text).toContain(label)
    }
    expect(lastReportsFilters?.reason).toBe('FRAUD')
    expect(text).toContain('正在按原因过滤（涉嫌欺诈）')
    expect(text).toContain('清除')
  })
})

describe('交易页 ID 筛选（契约已有但 UI 缺失）', () => {
  test('三个 ID 有输入框，深链带入时透传并给出提示条与清除', () => {
    const html = renderToStaticMarkup(
      createElement(TransactionsPage, {
        search: {
          buyerId: 'usr_01jc000000e00800000000000a',
          listingId: 'lst_01jc000000e00800000000000a',
          sellerId: 'usr_01jc000000e00800000000000b',
        },
      }),
    )
    const text = textOf(html)
    expect(html).toContain('aria-label="买家 ID"')
    expect(html).toContain('aria-label="卖家 ID"')
    expect(html).toContain('aria-label="商品 ID"')
    expect(lastTransactionsFilters?.buyerId).toBe('usr_01jc000000e00800000000000a')
    expect(lastTransactionsFilters?.sellerId).toBe('usr_01jc000000e00800000000000b')
    expect(lastTransactionsFilters?.listingId).toBe('lst_01jc000000e00800000000000a')
    expect(text).toContain('（买家 usr_01jc000000e00800000000000a）')
    expect(text).toContain('（卖家 usr_01jc000000e00800000000000b）')
    expect(text).toContain('（商品 lst_01jc000000e00800000000000a）')
    expect(text).toContain('清除')
  })

  test('无 ID 条件时不渲染提示条', () => {
    const html = renderToStaticMarkup(createElement(TransactionsPage, { search: {} }))
    expect(textOf(html)).not.toContain('正在按 ID 过滤')
  })

  test('parseTransactionsSearch 保留三个 ID 参数', () => {
    expect(
      parseTransactionsSearch({ buyerId: 'usr_a', listingId: 'lst_b', sellerId: 'usr_c' }),
    ).toEqual({
      buyerId: 'usr_a',
      listingId: 'lst_b',
      sellerId: 'usr_c',
    })
  })
})
