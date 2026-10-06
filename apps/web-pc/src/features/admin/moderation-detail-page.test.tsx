import { describe, expect, mock, test } from 'bun:test'
import type { AdminModerationDetail, AdminModerationQueueItem } from '@fish/contracts/admin/schema'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * `b47c81fe` 修的是「审核 409（已被其他管理员处理）应当关弹窗、立页级提示、并让决定
 * 入口随详情刷新消失」，此前零用例（#472 审查发现 §5）。web-pc 没有 jsdom，
 * 交互状态按本仓纪律抽成纯函数（`moderationDecisionStateAfter`）+ 静态渲染，
 * 于是这里既能断言 409 的状态迁移，也能断言横幅与入口的可见性。
 *
 * `admin-queries` **不桩**（走真实的 `useModerationDecision`，用 QueryClientProvider 提供
 * 上下文）：`mock.module` 在同进程内共享，少一个桩就少一分踩到本目录其它测试文件的风险。
 */
void mock.module('@tanstack/react-router', () => ({
  Link: (props: {
    to?: string
    params?: Record<string, string | undefined>
    children?: ReactNode
  }) => {
    let href = props.to ?? '#'
    for (const [key, value] of Object.entries(props.params ?? {})) {
      href = href.replace(`$${key}`, String(value))
    }
    return createElement('a', { href }, props.children)
  },
  Outlet: () => createElement('div', null),
  useNavigate: () => async () => {},
  createFileRoute: (path: string) => (options: unknown) => ({ path, options }),
}))

const {
  MODERATION_DECISION_IDLE,
  ModerationConflictBanner,
  ModerationDetailView,
  moderationDecisionStateAfter,
} = await import('./moderation-detail-page')
const { moderationDecisionError } = await import('./admin-messages')
const { ApiError } = await import('../../lib/api-client')

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

/** 给静态渲染补上 react-query 上下文（`ModerationDetailView` 用 `useModerationDecision`）。 */
function render(node: ReactNode): string {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node))
}

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

const DETAIL: AdminModerationDetail = {
  item: QUEUE_ITEM,
  history: [],
  machineDecision: 'REVIEW',
  humanDecision: null,
}

const DECIDED: AdminModerationDetail = {
  ...DETAIL,
  humanDecision: {
    decision: 'ALLOW',
    reason: '内容正常',
    actor: { id: 'usr_01AAAAAAAAAAAAAAAAAAAAAA', nickname: '管理员甲' },
    decidedAt: '2026-10-06T08:00:00.000Z',
  },
}

describe('审核 409 的界面状态迁移（b47c81fe）', () => {
  test('409 冲突：关弹窗 + 立页级横幅，不把冲突文案塞回弹窗', () => {
    const outcome = moderationDecisionError(
      new ApiError('MODERATION_CONFLICT', 409, '该审核记录已被其他管理员处理'),
    )
    expect(outcome.conflict).toBe(true)

    const next = moderationDecisionStateAfter(
      { conflict: false, dialogError: null, dialogOpen: true },
      { kind: 'failed', outcome },
    )
    expect(next).toEqual({ conflict: true, dialogError: null, dialogOpen: false })
  })

  test('非冲突失败（422）：弹窗留着并显示错误，不立页级横幅', () => {
    const outcome = moderationDecisionError(
      new ApiError('VALIDATION_FAILED', 422, '请求参数不合法'),
    )
    expect(outcome.conflict).toBe(false)

    const next = moderationDecisionStateAfter(
      { conflict: false, dialogError: null, dialogOpen: true },
      { kind: 'failed', outcome },
    )
    expect(next).toEqual({ conflict: false, dialogError: outcome.message, dialogOpen: true })
  })

  test('网络异常（非 ApiError）同样留在弹窗内', () => {
    const outcome = moderationDecisionError(new Error('socket hang up'))
    expect(outcome.conflict).toBe(false)

    const next = moderationDecisionStateAfter(
      { conflict: false, dialogError: null, dialogOpen: true },
      { kind: 'failed', outcome },
    )
    expect(next).toEqual({ conflict: false, dialogError: '网络异常，请稍后重试', dialogOpen: true })
  })

  test('打开弹窗清掉上次错误；提交成功关弹窗', () => {
    expect(
      moderationDecisionStateAfter(
        { conflict: false, dialogError: '上一次的失败文案', dialogOpen: false },
        { kind: 'open' },
      ),
    ).toEqual({ conflict: false, dialogError: null, dialogOpen: true })

    expect(
      moderationDecisionStateAfter(
        { conflict: false, dialogError: null, dialogOpen: true },
        { kind: 'succeeded' },
      ),
    ).toEqual({ conflict: false, dialogError: null, dialogOpen: false })

    // 初始态就是「没弹窗、没错误、没冲突」。
    expect(MODERATION_DECISION_IDLE).toEqual({
      conflict: false,
      dialogError: null,
      dialogOpen: false,
    })
  })
})

describe('页级冲突横幅（静态渲染）', () => {
  test('role=alert + danger 底色 + 页面级文案', () => {
    const html = render(createElement(ModerationConflictBanner))
    expect(html).toContain('role="alert"')
    expect(html).toContain('bg-danger-soft')
    expect(textOf(html)).toContain('该审核记录已被其他管理员处理，详情已刷新。')
  })
})

describe('决定入口的可见性（静态渲染）', () => {
  test('未决定：有「作出决定」按钮、无「已决定：」徽标', () => {
    const html = render(
      createElement(ModerationDetailView, {
        detail: DETAIL,
        recordId: 'mdr_01AAAAAAAAAAAAAAAAAAAAAA',
        tab: 'queue',
      }),
    )
    const text = textOf(html)
    expect(text).toContain('作出决定')
    expect(text).toContain('尚未决定')
    expect(text).not.toContain('已决定：')
  })

  test('已被处理（409 后详情刷新）：入口消失、改显示决定徽标', () => {
    const html = render(
      createElement(ModerationDetailView, {
        detail: DECIDED,
        recordId: 'mdr_01AAAAAAAAAAAAAAAAAAAAAA',
        tab: 'queue',
      }),
    )
    const text = textOf(html)
    expect(text).not.toContain('作出决定')
    expect(text).toContain('已决定：放行')
    expect(text).toContain('管理员甲')
  })
})
