import { describe, expect, mock, test } from 'bun:test'
import { ListingIdSchema, UserIdSchema } from '@fish/contracts/system/public-id'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 静态渲染没有 router context：Link 桩成插值 params / search 的 <a>（本仓测试惯例，
// 见 admin-pages.test.tsx）。四个列表页都从 '@tanstack/react-router' 取 Link / useNavigate，
// 而 `mock.module` 在同进程内共享，桩必须与目录内其它文件同名同形。
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
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => {},
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

const { NotFoundInline } = await import('./admin-filter')
const { RejectedIdNotice, checkPublicIds } = await import('./admin-id-guard')
const { checkAuditIds } = await import('./audit-page')
const { checkListingIds } = await import('./listings-page')
const { checkModerationIds } = await import('./moderation-page')
const { checkTransactionIds } = await import('./transactions-page')

const USER_ID = 'usr_01jc000000e00800000000000a'
const LISTING_ID = 'lst_01jc000000e00800000000000a'
const MODERATION_ID = 'mdr_01jc000000e00800000000000a'

/** 判定只依赖 `safeParse` 这个形状，测试用一个最小的 spec 表就能覆盖分流逻辑。 */
const ID_SPECS = {
  a: { label: '甲', prefix: 'usr_', schema: UserIdSchema },
  b: { label: '乙', prefix: 'lst_', schema: ListingIdSchema },
} as const

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

describe('checkPublicIds（#467 五审 P0 的共用判定）', () => {
  test('合法值进 valid、形态不对的进 rejected（带上前缀，供提示文案用）', () => {
    const result = checkPublicIds(ID_SPECS, { a: USER_ID, b: 'not-an-id' })
    expect(result.valid).toEqual({ a: USER_ID })
    expect(result.rejected).toEqual([{ field: 'b', label: '乙', prefix: 'lst_', raw: 'not-an-id' }])
  })

  test('空前缀（不是公开 ID）也进 rejected，绝不放行给服务端', () => {
    expect(checkPublicIds(ID_SPECS, { a: 'abc' }).rejected).toEqual([
      { field: 'a', label: '甲', prefix: 'usr_', raw: 'abc' },
    ])
    // 长度对但 UUID 版本不对（v4）同样不是规范公开 ID
    expect(checkPublicIds(ID_SPECS, { a: 'usr_01AAAAAAAAAAAAAAAAAAAAAA' }).rejected).toHaveLength(1)
  })

  test('空串与 undefined 直接跳过：URL 上没有这个条件，不算「非法」', () => {
    expect(checkPublicIds(ID_SPECS, { a: '', b: undefined })).toEqual({ valid: {}, rejected: [] })
  })
})

describe('四个列表页的 ID 守卫（P0：非法值不进 filters、不发服务端）', () => {
  test('商品页 sellerId', () => {
    expect(checkListingIds({ sellerId: 'abc' })).toEqual({
      valid: {},
      rejected: [{ field: 'sellerId', label: '卖家 ID', prefix: 'usr_', raw: 'abc' }],
    })
    expect(checkListingIds({ sellerId: USER_ID }).valid).toEqual({ sellerId: USER_ID })
  })

  test('审核记录页 listingId（以前非法值会换来整页 422 早返回）', () => {
    expect(checkModerationIds({ listingId: 'oops', tab: 'records' }).rejected).toEqual([
      { field: 'listingId', label: '商品 ID', prefix: 'lst_', raw: 'oops' },
    ])
    expect(checkModerationIds({ listingId: LISTING_ID, tab: 'records' }).valid).toEqual({
      listingId: LISTING_ID,
    })
  })

  test('审计页 actorId / targetId（targetType 决定 targetId 用哪个 schema）', () => {
    expect(checkAuditIds({ actorId: 'nope' }).rejected).toEqual([
      { field: 'actorId', label: '操作者 ID', prefix: 'usr_', raw: 'nope' },
    ])
    // 未指定 targetType：按契约的联合 schema 判
    expect(checkAuditIds({ targetId: LISTING_ID }).valid).toEqual({ targetId: LISTING_ID })
    expect(checkAuditIds({ targetId: 'lst_a' }).rejected).toHaveLength(1)
    // 指定 targetType：按该类型的 schema 判（usr_ 目标配 LISTING 类型同样 422），前缀提示收窄到该类型
    expect(checkAuditIds({ targetId: USER_ID, targetType: 'LISTING' }).rejected).toEqual([
      {
        field: 'targetId',
        label: '目标 ID',
        prefix: 'lst_',
        raw: USER_ID,
      },
    ])
    expect(
      checkAuditIds({ targetId: MODERATION_ID, targetType: 'MODERATION_RECORD' }).valid,
    ).toEqual({ targetId: MODERATION_ID })
  })

  test('交易页走同一判定（抽件后口径不变）', () => {
    expect(checkTransactionIds({ sellerId: 'abc' }).rejected).toEqual([
      { field: 'sellerId', label: '卖家 ID', prefix: 'usr_', raw: 'abc' },
    ])
    expect(checkTransactionIds({ buyerId: USER_ID, listingId: LISTING_ID }).valid).toEqual({
      buyerId: USER_ID,
      listingId: LISTING_ID,
    })
  })
})

describe('RejectedIdNotice（非法 ID 的红色提示 + 清除入口）', () => {
  test('role=alert、逐条说明、带清除按钮', () => {
    const html = renderToStaticMarkup(
      createElement(RejectedIdNotice, {
        items: [
          { field: 'sellerId', label: '卖家 ID', prefix: 'usr_', raw: 'abc' },
          { field: 'listingId', label: '商品 ID', prefix: 'lst_', raw: 'oops' },
        ],
        onClear: () => undefined,
      }),
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('bg-danger-soft')
    const text = textOf(html)
    expect(text).toContain('卖家 ID「abc」不是规范的公开 ID（应为 usr_ 开头）')
    expect(text).toContain('商品 ID「oops」不是规范的公开 ID（应为 lst_ 开头）')
    expect(text).toContain('已忽略该条件、未发给服务端')
    expect(text).toContain('清除')
  })

  test('没有非法项时整条不渲染', () => {
    expect(
      renderToStaticMarkup(
        createElement(RejectedIdNotice, { items: [], onClear: () => undefined }),
      ),
    ).toBe('')
  })
})

describe('NotFoundInline（#467 五审 P3：404 不给「重试」）', () => {
  test('给缺失文案 + 返回列表入口，没有重试按钮', () => {
    const html = renderToStaticMarkup(
      createElement(NotFoundInline, { label: '商品', to: '/admin/listings' }),
    )
    expect(html).toContain('href="/admin/listings"')
    const text = textOf(html)
    expect(text).toContain('商品不存在或已被删除')
    expect(text).toContain('返回列表')
    expect(text).not.toContain('重试')
  })
})
