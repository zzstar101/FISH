import { describe, expect, mock, test } from 'bun:test'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * 容器层只做「查询状态 → 展示 props」的映射，这里桩掉数据源，专测分段计数的真值口径：
 * 首屏失败 → 未知（`—`）；翻页失败但第一页已到手 → 计数保留第一页 total。
 * 视图本身的分支在 `my-comments-view.test.tsx`，不重复覆盖。
 */
type SegmentKind = 'comment' | 'review'

const state: Record<SegmentKind, unknown> = { comment: null, review: null }

mock.module('./queries', () => ({
  useMyComments: (_ownerId: string, kind: SegmentKind) => state[kind],
}))

mock.module('../auth/auth-provider', () => ({
  useAuth: () => ({ me: { id: 'usr_01jc000000e00800000000000a' } }),
}))

// 空态里有真 `Link`，没有 router context 时会炸（与 my-comments-view.test.tsx 同款 stub）。
mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

const { MyCommentsPage } = await import('./my-comments-page')

/** 第一页已到手的查询结果；`overrides` 用来摆出首屏失败 / 翻页失败等状态。 */
function list(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [{ items: [], nextCursor: null, total: 12 }], pageParams: [null] },
    isError: false,
    isFetchNextPageError: false,
    isPending: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    refetch: () => {},
    fetchNextPage: () => {},
    ...overrides,
  }
}

function render(): string {
  return renderToStaticMarkup(createElement(MyCommentsPage))
}

describe('MyCommentsPage 分段计数', () => {
  test('两段都到手时各显示自己的 total', () => {
    state.comment = list()
    state.review = list({
      data: { pages: [{ items: [], nextCursor: null, total: 4 }], pageParams: [null] },
    })

    const html = render()

    expect(html).toContain('>12</span>')
    expect(html).toContain('>4</span>')
  })

  test('翻页失败但第一页已在，计数保留而不是变成未知', () => {
    state.comment = list()
    state.review = list({
      data: { pages: [{ items: [], nextCursor: 'cur_1', total: 4 }], pageParams: [null] },
      isError: true,
      isFetchNextPageError: true,
      hasNextPage: true,
    })

    const html = render()

    expect(html).toContain('>4</span>')
    expect(html).not.toContain('>—</span>')
  })

  test('首屏失败导致第一页缺失时，该段显示未知而不是 0', () => {
    state.comment = list()
    state.review = list({ data: undefined, isError: true, isFetchNextPageError: false })

    const html = render()

    expect(html).toContain('>12</span>')
    expect(html).toContain('>—</span>')
  })
})
