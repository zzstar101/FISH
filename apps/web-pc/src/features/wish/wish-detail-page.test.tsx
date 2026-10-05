import { describe, expect, mock, test } from 'bun:test'
import type { WishDto } from '@fish/contracts/wishes/schema'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiError } from '../../lib/api-client'

/**
 * 页面分支只看 useWishDetail 的返回值：pending → 加载态；403/404 → 「愿望不存在或不可见」；
 * 其它错误 → ErrorState（可重试）；成功 → 愿望信息 + 匹配入口。
 * MatchListDialog 是 radix 弹窗（静态渲染为空），桩掉只留按钮。
 */
let detailResult: Record<string, unknown>

mock.module('./queries', () => ({
  useWishDetail: () => detailResult,
}))

mock.module('../auth/auth-provider', () => ({
  useAuth: () => ({ me: { id: 'usr_01jc000000e00800000000000a' } }),
}))

mock.module('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement('a', { href: to, ...rest }, children),
}))

mock.module('./match-list', () => ({
  MatchListDialog: () => null,
  budgetLabel: (min: number, max: number) => `${min}-${max}`,
}))

const { WishDetailPage } = await import('./wish-detail-page')

const WISH: WishDto = {
  id: 'wsh_01jc000000e00800000000003t',
  userId: 'usr_01jc000000e00800000000000a',
  keyword: '考研数学书',
  category: 'BOOKS',
  budgetMinCents: 1000,
  budgetMaxCents: 5000,
  description: '整套即可',
  acceptSimilar: true,
  status: 'ACTIVE',
  matchCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function render(): string {
  return renderToStaticMarkup(createElement(WishDetailPage, { wishId: WISH.id }))
}

describe('WishDetailPage（#446 wishId 通知落点）', () => {
  test('加载中给加载态', () => {
    detailResult = {
      isPending: true,
      isError: false,
      data: undefined,
      error: null,
      refetch: () => undefined,
    }
    expect(render()).toContain('正在加载愿望')
  })

  test('404（愿望不存在）渲染「愿望不存在或不可见」+ 返回入口，不给重试', () => {
    detailResult = {
      isPending: false,
      isError: true,
      data: undefined,
      error: new ApiError('NOT_FOUND', 404, '愿望不存在'),
      refetch: () => undefined,
    }
    const html = render()
    expect(html).toContain('愿望不存在或不可见')
    expect(html).toContain('返回许愿墙')
    // 不存在是终态：重试只会再得 404
    expect(html).not.toContain('重试')
  })

  test('403（不是本人的愿望）同样走「不存在或不可见」，不给必然再 403 的重试按钮', () => {
    detailResult = {
      isPending: false,
      isError: true,
      data: undefined,
      error: new ApiError('FORBIDDEN', 403, '无权查看该愿望'),
      refetch: () => undefined,
    }
    const html = render()
    expect(html).toContain('愿望不存在或不可见')
    expect(html).toContain('返回许愿墙')
    expect(html).not.toContain('愿望加载失败')
    expect(html).not.toContain('重试')
  })

  test('其它错误（如 500）仍走 ErrorState + 重试，不被并进「不可见」', () => {
    detailResult = {
      isPending: false,
      isError: true,
      data: undefined,
      error: new ApiError('INTERNAL_ERROR', 500, '服务器开小差了'),
      refetch: () => undefined,
    }
    const html = render()
    expect(html).toContain('愿望加载失败')
    expect(html).toContain('重试')
    expect(html).not.toContain('愿望不存在或不可见')
  })

  test('成功渲染愿望信息与匹配入口（有匹配时可点）', () => {
    detailResult = {
      isPending: false,
      isError: false,
      data: WISH,
      error: null,
      refetch: () => undefined,
    }
    const html = render()
    expect(html).toContain('考研数学书')
    expect(html).toContain('许愿中')
    expect(html).toContain('查看匹配结果')
    // disabled:xx 会出现在按钮的样式类里，属性断言要带引号
    expect(html).not.toContain('disabled=""')
  })

  test('无匹配时匹配入口禁用', () => {
    detailResult = {
      isPending: false,
      isError: false,
      data: { ...WISH, matchCount: 0 },
      error: null,
      refetch: () => undefined,
    }
    expect(render()).toContain('暂无匹配结果')
  })
})
