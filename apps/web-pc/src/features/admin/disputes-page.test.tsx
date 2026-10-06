import { describe, expect, mock, test } from 'bun:test'
import type {
  AdminDisputeDetail,
  AdminDisputeItem,
  Dispute,
  DisputeEvidence,
} from '@fish/contracts/disputes/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 静态渲染没有 router context：把 Link 桩成插值 params 的 <a>（本仓测试惯例，见
// admin-pages.test.tsx）。disputes-page 还消费 useNavigate（筛选跳转），一并桩掉。
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
    // search 也拼进 href：下钻/返回是否透传筛选只能从链接上看出来。
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(props.search ?? {})) {
      if (value !== undefined) query.set(key, String(value))
    }
    const qs = query.toString()
    return createElement('a', { href: qs ? `${href}?${qs}` : href }, props.children)
  },
  // Outlet 与本目录其它测试文件保持一致：mock.module 在同进程内是共享的（不带 --isolate 时
  // admin-shell.test.tsx 会消费本模块的 mock，缺 Outlet 直接把它的用例炸成 SyntaxError）。
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => {},
  // createFileRoute 与本目录其它测试文件保持一致（mock.module 在同进程内是共享的；
  // /admin/ index 路由的用例要 import 路由文件，靠它拿到 { path, options }）。
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

// Radix Dialog 走 Portal，静态渲染拿不到内容：把展示壳桩成内联渲染，好断言弹窗自己的文案。
void mock.module('@fish/ui/dialog', () => ({
  Dialog: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  DialogContent: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  DialogDescription: (props: { children?: ReactNode }) => createElement('p', null, props.children),
  DialogFooter: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  DialogHeader: (props: { children?: ReactNode }) => createElement('div', null, props.children),
  DialogTitle: (props: { children?: ReactNode }) => createElement('h2', null, props.children),
}))

const { DisputeRow, parseDisputesSearch } = await import('./disputes-page')
const { DisputeDetailView, disputeResolvePanel } = await import('./dispute-detail-page')
const { DisputeResolveDialog } = await import('./dispute-resolve-dialog')

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

const DISPUTE_ID = 'dsp_01jc000000e00800000000000a'
const OTHER_DISPUTE_ID = 'dsp_01jc000000e00800000000000b'
const BUYER_ID = 'usr_01jc000000e00800000000000d'
const SELLER_ID = 'usr_01jc000000e00800000000000e'
const TX_ID = 'txn_01jc000000e00800000000000f'
const LISTING_ID = 'lst_01jc000000e00800000000000b'
const MSG_ID = 'msg_01jc000000e00800000000000c'
const MEDIA_ID = 'med_01jc000000e00800000000000f'

// `as const` 必须留着：对象字面量会把 `id` 拓宽成 `string`，而契约要的是 `` `usr_${string}` ``。
const BUYER = { id: BUYER_ID, nickname: '买家小林' } as const
const SELLER = { id: SELLER_ID, nickname: '卖家老陈' } as const

function dispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: DISPUTE_ID,
    type: 'ITEM_MISMATCH',
    status: 'PENDING',
    detailText: '收到的书缺了一本',
    initiator: BUYER,
    respondent: SELLER,
    transaction: {
      id: TX_ID,
      listingId: LISTING_ID,
      listingTitle: '考研数学资料',
      buyer: BUYER,
      seller: SELLER,
      amountCents: 2800,
      status: 'COMPLETED',
      completedAt: '2026-10-01T02:00:00.000Z',
      cancelledAt: null,
      createdAt: '2026-09-30T02:00:00.000Z',
    },
    resolution: null,
    resolutionNote: null,
    handledBy: null,
    handledAt: null,
    withdrawnAt: null,
    createdAt: '2026-10-02T02:00:00.000Z',
    updatedAt: '2026-10-02T02:00:00.000Z',
    ...overrides,
  }
}

function item(
  overrides: Partial<Dispute> = {},
  counts?: Partial<AdminDisputeItem>,
): AdminDisputeItem {
  return {
    dispute: dispute(overrides),
    attachmentCount: 2,
    evidenceCount: 1,
    disputeCount: 1,
    ...counts,
  }
}

const EVIDENCE: DisputeEvidence = {
  message: {
    id: MSG_ID,
    type: 'TEXT',
    senderId: SELLER_ID,
    senderNickname: '卖家老陈',
    content: '书我确实漏发了一本，下周补给你',
    recalledAt: null,
    createdAt: '2026-10-01T03:00:00.000Z',
  },
  addedBy: BUYER,
  createdAt: '2026-10-02T02:05:00.000Z',
}

function detail(overrides: Partial<AdminDisputeDetail> = {}): AdminDisputeDetail {
  return {
    item: item(),
    attachments: [
      {
        id: MEDIA_ID,
        url: 'https://web.example.com/api/uploads/dispute-media/token-1',
        mimeType: 'image/png',
        sizeBytes: 40_960,
        width: 800,
        height: 600,
        uploadedBy: BUYER,
        createdAt: '2026-10-02T02:03:00.000Z',
      },
    ],
    evidence: [EVIDENCE],
    related: [],
    ...overrides,
  }
}

/** 详情视图消费 useMutation（处理争议），静态渲染必须给 QueryClientProvider。 */
function renderDetail(value: AdminDisputeDetail, search: Record<string, unknown> = {}): string {
  const queryClient = new QueryClient()
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(DisputeDetailView, {
        detail: value,
        disputeId: value.item.dispute.id,
        search,
      }),
    ),
  )
}

describe('DisputeRow（争议队列行）', () => {
  test('状态徽标、类型、金额、双方与计数都渲染，并链到详情', () => {
    const html = renderToStaticMarkup(createElement(DisputeRow, { item: item(), search: {} }))
    const text = textOf(html)

    expect(text).toContain('待处理')
    expect(text).toContain('商品与描述不符')
    expect(text).toContain('考研数学资料')
    expect(text).toContain('¥28')
    expect(text).toContain('买家小林 → 卖家老陈')
    expect(text).toContain('附件 2')
    expect(text).toContain('证据 1')
    expect(html).toContain(`href="/admin/disputes/${DISPUTE_ID}"`)
  })

  test('同交易多起争议时给出计数徽标，单起不显示', () => {
    const many = renderToStaticMarkup(
      createElement(DisputeRow, { item: item({}, { disputeCount: 3 }), search: {} }),
    )
    expect(textOf(many)).toContain('同交易 3 起')

    const one = renderToStaticMarkup(createElement(DisputeRow, { item: item(), search: {} }))
    expect(textOf(one)).not.toContain('同交易')
  })

  test('已撤回的争议显示撤回徽标而不是待处理', () => {
    const html = renderToStaticMarkup(
      createElement(DisputeRow, {
        item: item({ status: 'WITHDRAWN', withdrawnAt: '2026-10-03T02:00:00.000Z' }),
        search: {},
      }),
    )
    const text = textOf(html)
    expect(text).toContain('已撤回')
    expect(text).not.toContain('待处理')
  })

  test('行链接透传队列筛选、丢掉 cursor（返回时不会凭空多出 status）', () => {
    const html = renderToStaticMarkup(
      createElement(DisputeRow, {
        item: item(),
        search: { status: 'RESOLVED', type: 'OTHER', q: '书', from: '2026-10-01', cursor: 'c1' },
      }),
    )
    // React 把属性里的 `&` 转义成 `&amp;`，断言按渲染后的形态写。
    expect(html).toContain(
      `href="/admin/disputes/${DISPUTE_ID}?status=RESOLVED&amp;type=OTHER&amp;q=%E4%B9%A6&amp;from=2026-10-01"`,
    )
    expect(html).not.toContain('cursor=')
  })
})

describe('disputeResolvePanel（处理入口与冲突横幅的显示条件）', () => {
  test('待处理且未冲突才可提交；冲突后入口消失、横幅出现', () => {
    expect(disputeResolvePanel({ status: 'PENDING', conflict: false })).toEqual({
      canResolve: true,
      showConflictBanner: false,
    })
    expect(disputeResolvePanel({ status: 'PENDING', conflict: true })).toEqual({
      canResolve: false,
      showConflictBanner: true,
    })
    expect(disputeResolvePanel({ status: 'RESOLVED', conflict: false })).toEqual({
      canResolve: false,
      showConflictBanner: false,
    })
    expect(disputeResolvePanel({ status: 'WITHDRAWN', conflict: false })).toEqual({
      canResolve: false,
      showConflictBanner: false,
    })
  })
})

describe('DisputeDetailView（争议详情）', () => {
  test('待处理争议给出处理入口，附件、证据与关联交易都渲染', () => {
    const html = renderDetail(detail())
    const text = textOf(html)

    expect(text).toContain('处理争议')
    expect(text).toContain('收到的书缺了一本')
    expect(text).toContain('发起人 买家小林 → 被诉方 卖家老陈')
    expect(text).toContain('成交价 ¥28')
    expect(text).toContain('800×600')
    expect(html).toContain('src="https://web.example.com/api/uploads/dispute-media/token-1"')
    expect(text).toContain('书我确实漏发了一本，下周补给你')
    expect(text).toContain('卖家老陈')
    expect(html).toContain(`href="/admin/transactions?listingId=${LISTING_ID}"`)
    expect(html).toContain(`href="/admin/listings/${LISTING_ID}"`)
  })

  test('已处理争议不给处理入口，展示结论与处理人', () => {
    const html = renderDetail(
      detail({
        item: item({
          status: 'RESOLVED',
          resolution: 'UPHELD',
          resolutionNote: '缺页属实，已与双方确认',
          handledBy: { id: 'usr_01jc000000e00800000000000a', nickname: '管理员阿May' },
          handledAt: '2026-10-04T02:00:00.000Z',
        }),
      }),
    )
    const text = textOf(html)
    expect(text).toContain('已处理')
    expect(text).toContain('反馈成立')
    expect(text).toContain('缺页属实，已与双方确认')
    expect(text).toContain('处理人 管理员阿May')
    expect(text).not.toContain('处理争议')
  })

  test('已撤回争议不给处理入口并说明不可再处理', () => {
    const html = renderDetail(
      detail({
        item: item({ status: 'WITHDRAWN', withdrawnAt: '2026-10-03T02:00:00.000Z' }),
      }),
    )
    const text = textOf(html)
    expect(text).toContain('已撤回')
    expect(text).toContain('该争议不可再处理')
    expect(text).not.toContain('处理争议')
  })

  test('返回队列时原样带回筛选、丢掉 cursor', () => {
    const html = renderDetail(detail(), { status: 'RESOLVED', q: '书', cursor: 'c9' })
    expect(html).toContain('href="/admin/disputes?status=RESOLVED&amp;q=%E4%B9%A6"')
    expect(html).not.toContain('cursor=')
  })

  test('已撤回的消息证据仍然展示正文，并标注发送者已撤回', () => {
    const html = renderDetail(
      detail({
        evidence: [
          {
            ...EVIDENCE,
            message: { ...EVIDENCE.message, recalledAt: '2026-10-01T04:00:00.000Z' },
          },
        ],
      }),
    )
    const text = textOf(html)
    expect(text).toContain('发送者已撤回')
    expect(text).toContain('书我确实漏发了一本，下周补给你')
  })

  test('同交易的其它未决争议逐条列出并可跳转', () => {
    const html = renderDetail(
      detail({
        item: item({}, { disputeCount: 2 }),
        related: [
          dispute({
            id: OTHER_DISPUTE_ID,
            type: 'PAYMENT_ISSUE',
            initiator: SELLER,
            respondent: BUYER,
          }),
        ],
      }),
    )
    const text = textOf(html)
    expect(text).toContain('同交易的其它未决争议')
    expect(text).toContain('支付问题')
    expect(text).toContain('卖家老陈 → 买家小林')
    expect(text).toContain('同交易共 2 起')
    expect(html).toContain(`href="/admin/disputes/${OTHER_DISPUTE_ID}"`)
  })

  test('没有附件与证据时给出空态文案', () => {
    const text = textOf(renderDetail(detail({ attachments: [], evidence: [] })))
    expect(text).toContain('没有附件')
    expect(text).toContain('没有关联聊天证据')
  })
})

describe('DisputeResolveDialog（处理弹窗）', () => {
  test('三个结论选项与原因输入都在，未选择前不提交', () => {
    const html = renderToStaticMarkup(
      createElement(DisputeResolveDialog, {
        errorMessage: null,
        onClose: () => {},
        onSubmit: () => {},
        pending: false,
        subjectLabel: '商品与描述不符「考研数学资料」',
      }),
    )
    const text = textOf(html)
    expect(text).toContain('处理争议')
    expect(text).toContain('反馈成立')
    expect(text).toContain('反馈不成立')
    expect(text).toContain('无法认定')
    expect(text).toContain('0/500')
    expect(text).toContain('提交处理结论')
    expect(text).toContain('不改成交事实、不执行处罚')
    // 复用 admin-dialog-parts 之后结构必须与原来逐字一致：三列卡片、同一个 radio 组名、
    // 契约上限经 maxLength 传入（#465 审查 Duplicated Code 的最小修复不得改行为）。
    expect(html).toContain('grid grid-cols-3 gap-2 border-0 p-0 m-0')
    expect(html).toContain('name="dispute-resolve-resolution"')
    expect(html).toContain('maxLength="500"')
    expect(html).toContain('placeholder="写进审计、不可抵赖；1–500 字"')
  })

  test('服务端错误渲染在弹窗内部（#448 教训）', () => {
    const html = renderToStaticMarkup(
      createElement(DisputeResolveDialog, {
        errorMessage: '该争议已被处理或已撤回，请刷新后重试',
        onClose: () => {},
        onSubmit: () => {},
        pending: false,
        subjectLabel: '其他「考研数学资料」',
      }),
    )
    expect(textOf(html)).toContain('该争议已被处理或已撤回，请刷新后重试')
    expect(html).toContain('role="alert"')
    expect(html).toContain('bg-danger-soft text-danger')
  })
})

describe('parseDisputesSearch（URL 筛选参数）', () => {
  test('合法状态/类型/关键词/日期/游标都保留', () => {
    expect(
      parseDisputesSearch({
        cursor: 'abc',
        from: '2026-10-01',
        q: '  缺页  ',
        status: 'RESOLVED',
        to: '2026-10-05',
        type: 'PAYMENT_ISSUE',
      }),
    ).toEqual({
      cursor: 'abc',
      from: '2026-10-01',
      q: '缺页',
      status: 'RESOLVED',
      to: '2026-10-05',
      type: 'PAYMENT_ISSUE',
    })
  })

  test('非法枚举值被丢弃而不是抛错（URL 可手改）', () => {
    expect(parseDisputesSearch({ status: 'BOGUS', type: 'HARASSMENT' })).toEqual({})
  })

  test('日期必须是 YYYY-MM-DD，空白关键词与空游标丢弃', () => {
    expect(parseDisputesSearch({ from: '10/01', q: '   ', to: 42 })).toEqual({})
    expect(parseDisputesSearch({ from: '2026-10-01' })).toEqual({ from: '2026-10-01' })
  })

  test('缺省不注入任何筛选（队列默认看全部）', () => {
    expect(parseDisputesSearch({})).toEqual({})
  })
})
