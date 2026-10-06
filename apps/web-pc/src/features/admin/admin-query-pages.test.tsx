import { describe, expect, mock, test } from 'bun:test'
import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { FilterChips } from './admin-filter'

/**
 * 举报 / 交易两页的筛选接线测试（#467 审查发现 Spec a-① a-② c-① 的回归防护）：
 * 1. 举报「全部」可达（修复前 FilterChips 传出的 undefined 被 `?? 'PENDING'` 强转回待处理）；
 * 2. 举报「原因」筛选有了 UI 与「正在按原因过滤」提示条；
 * 3. 交易页把契约已有的 buyerId/sellerId/listingId 暴露成输入框 + 提示条 + 清除；
 * 4. 二审 S1：三个 ID 的形态校验（非法值不发给服务端、就地标红）；
 * 5. 二审 S2：点「全部」胶囊确实把 `status=ALL` 写进 URL（而不只是「读到 ALL 时怎么渲染」）。
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

type NavigateOptions = { to: string; search: Record<string, unknown> }

let lastReportsFilters: CapturedReportsFilters | null = null
let lastTransactionsFilters: CapturedTransactionsFilters | null = null
const navigateCalls: NavigateOptions[] = []

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
  useNavigate: () => async (options: NavigateOptions) => {
    navigateCalls.push(options)
  },
}))

const { ReportsPage, REPORTS_STATUS_ALL, parseReportsSearch } = await import('./reports-page')
const { TransactionsPage, checkTransactionIds, parseTransactionsSearch } = await import(
  './transactions-page'
)

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

type ChipsOnChange = (value: string | undefined) => void

/**
 * 从元素树里取某个 `FilterChips` 的 `onChange`。`ReportsPage` / `TransactionsPage` 自身只调用
 * 被桩掉的 `useNavigate` / `useAdminReports`，所以可以直接调用组件拿元素树；`FilterChips` 只是
 * 被找到、不被执行，因此不涉及任何真实 hook。拿到的 `onChange(undefined)` 就是点「全部」胶囊。
 */
function findChipsOnChange(node: ReactNode, ariaLabel: string): ChipsOnChange | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue
    const props = child.props as {
      ariaLabel?: string
      children?: ReactNode
      onChange?: ChipsOnChange
    }
    if (child.type === FilterChips && props.ariaLabel === ariaLabel) return props.onChange ?? null
    const deeper = findChipsOnChange(props.children, ariaLabel)
    if (deeper !== null) return deeper
  }
  return null
}

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

  test('点「全部」胶囊把 status=ALL 写进 URL（#467 二审 S2：不只测「读到 ALL 怎么渲染」）', () => {
    navigateCalls.length = 0
    const onChange = findChipsOnChange(
      ReportsPage({ search: { status: 'PENDING' } }),
      '举报状态筛选',
    )
    expect(typeof onChange).toBe('function')
    // FilterChips 把「全部」映射成 undefined 传出（见 admin-filter.tsx 的 ALL 哨兵）。
    onChange?.(undefined)
    expect(navigateCalls).toEqual([{ to: '/admin/reports', search: { status: 'ALL' } }])
  })

  test('点具体状态胶囊写的是该状态本身（对照：只有「全部」才写 ALL）', () => {
    navigateCalls.length = 0
    const onChange = findChipsOnChange(
      ReportsPage({ search: { status: REPORTS_STATUS_ALL } }),
      '举报状态筛选',
    )
    onChange?.('HANDLED')
    expect(navigateCalls).toEqual([{ to: '/admin/reports', search: { status: 'HANDLED' } }])
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

  test('parseTransactionsSearch 只做「非空字符串」，形态校验留给页面边界', () => {
    // 原始值必须留在 search 里：输入框要回显用户打的内容，提示条要点名是哪个值不合法。
    expect(
      parseTransactionsSearch({ buyerId: 'usr_a', listingId: 'lst_b', sellerId: 'usr_c' }),
    ).toEqual({
      buyerId: 'usr_a',
      listingId: 'lst_b',
      sellerId: 'usr_c',
    })
    expect(parseTransactionsSearch({ buyerId: 'abc' })).toEqual({ buyerId: 'abc' })
  })
})

describe('交易页 ID 形态校验（#467 二审 S1：非法 ID 不得发给服务端）', () => {
  test('输入 abc：不发服务端（filters 里没有该 ID），并就地标红提示', () => {
    const html = renderToStaticMarkup(
      createElement(TransactionsPage, { search: { buyerId: 'abc' } }),
    )
    const text = textOf(html)
    expect(lastTransactionsFilters?.buyerId).toBeUndefined()
    expect(html).toContain('role="alert"')
    expect(text).toContain('买家 ID「abc」不是规范的公开 ID（应为 usr_ 开头）')
    expect(text).toContain('已忽略该条件、未发给服务端')
    // 非法值不进「正在按 ID 过滤」那条正常态提示。
    expect(text).not.toContain('正在按 ID 过滤')
  })

  test('前缀不匹配也算非法：buyerId 必须是 usr_，不能拿 lst_ 顶替', () => {
    const html = renderToStaticMarkup(
      createElement(TransactionsPage, { search: { buyerId: 'lst_01jc000000e00800000000000a' } }),
    )
    expect(lastTransactionsFilters?.buyerId).toBeUndefined()
    expect(textOf(html)).toContain('应为 usr_ 开头')
  })

  test('只拦非法的那一个：合法的 listingId 照常透传并出现在提示条里', () => {
    const html = renderToStaticMarkup(
      createElement(TransactionsPage, {
        search: { buyerId: 'abc', listingId: 'lst_01jc000000e00800000000000a' },
      }),
    )
    const text = textOf(html)
    expect(lastTransactionsFilters?.buyerId).toBeUndefined()
    expect(lastTransactionsFilters?.listingId).toBe('lst_01jc000000e00800000000000a')
    expect(text).toContain('正在按 ID 过滤')
    expect(text).toContain('（商品 lst_01jc000000e00800000000000a）')
    expect(text).not.toContain('（买家 abc）')
  })

  test('checkTransactionIds 的判定口径：契约 schema 说了算', () => {
    expect(checkTransactionIds({ buyerId: 'abc' })).toEqual({
      valid: {},
      rejected: [{ field: 'buyerId', label: '买家 ID', prefix: 'usr_', raw: 'abc' }],
    })
    expect(checkTransactionIds({ buyerId: 'usr_a' }).rejected).toHaveLength(1)
    expect(
      checkTransactionIds({
        buyerId: 'usr_01jc000000e00800000000000a',
        listingId: 'lst_01jc000000e00800000000000a',
        sellerId: 'usr_01jc000000e00800000000000b',
      }),
    ).toEqual({
      valid: {
        buyerId: 'usr_01jc000000e00800000000000a',
        listingId: 'lst_01jc000000e00800000000000a',
        sellerId: 'usr_01jc000000e00800000000000b',
      },
      rejected: [],
    })
    expect(checkTransactionIds({})).toEqual({ valid: {}, rejected: [] })
  })
})
