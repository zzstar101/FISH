import { beforeEach, expect, mock, test } from 'bun:test'
import type { Dispute } from '@fish/contracts/disputes/schema'

/**
 * 详情取数的错误分类（#497）。
 *
 * 非参与人看到的 404 与「争议不存在」是**同一个码**，所以 404 必须落「看不到这条争议」的
 * 友好态，而不是「加载失败 + 重试」；其余失败（5xx / 断网）才给重试。这条分界线错了，
 * 用户会对着一个永远重试不出来的按钮打转。
 */

// `features/load-failure` 在模块加载时读构建期注入的常量，bun 里没有 => 先补上
Object.assign(globalThis, { __ALLOW_MOCK_FALLBACK__: false, __DEMO_AUTH__: false })

class MockApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number) {
    super(code)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

let failure: unknown = null

mock.module('@/lib/request', () => ({
  apiRequest: async () => {
    throw failure
  },
  isApiError: (error: unknown) => error instanceof MockApiError,
  isUnauthenticatedError: () => false,
}))

// ── 订单入口 / 列表分页用的 fixtures ──
const buyer = { id: 'usr_buyer', nickname: '买家小周' }
const seller = { id: 'usr_seller', nickname: '卖家小林' }

function disputeFixture(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: 'dsp_1',
    type: 'ITEM_MISMATCH',
    status: 'PENDING',
    detailText: null,
    initiator: buyer,
    respondent: seller,
    transaction: {
      id: 'txn_1',
      listingId: 'lst_1',
      listingTitle: '索尼降噪耳机',
      buyer,
      seller,
      amountCents: 32_000,
      status: 'COMPLETED',
      completedAt: '2026-10-19T03:00:00.000Z',
      cancelledAt: null,
      createdAt: '2026-10-18T03:00:00.000Z',
    },
    resolution: null,
    resolutionNote: null,
    handledBy: null,
    handledAt: null,
    withdrawnAt: null,
    createdAt: '2026-10-19T04:00:00.000Z',
    updatedAt: '2026-10-19T04:00:00.000Z',
    ...overrides,
  }
}

type FakePage = { items: Dispute[]; nextCursor: string | null }
let pageResponder: (cursor?: string) => FakePage = () => ({ items: [], nextCursor: null })
const pageCursors: (string | undefined)[] = []

mock.module('../src/features/disputes/api', () => ({
  fetchDisputeDetail: async () => {
    throw failure
  },
  fetchMyDisputePage: async (cursor?: string) => {
    pageCursors.push(cursor)
    return pageResponder(cursor)
  },
}))

const { findDisputeForTransaction, loadDisputeDetail, loadDisputePage } = await import(
  '@/features/disputes/load'
)

beforeEach(() => {
  failure = null
  pageCursors.length = 0
  pageResponder = () => ({ items: [], nextCursor: null })
})

test('404 / DISPUTE_NOT_FOUND 落 notFound：非参与人也要看到友好态', async () => {
  failure = new MockApiError('DISPUTE_NOT_FOUND', 404)
  await expect(loadDisputeDetail('dsp_x')).resolves.toEqual({ state: 'notFound' })
  // 规范化 ID 之外的 404 也按不可见处理（服务端对非法 ID 直接 404）
  failure = new MockApiError('SOMETHING_ELSE', 404)
  await expect(loadDisputeDetail('dsp_x')).resolves.toEqual({ state: 'notFound' })
})

test('5xx 与断网落 failed：给重试，不伪装成「不存在」', async () => {
  failure = new MockApiError('INTERNAL_ERROR', 500)
  expect(await loadDisputeDetail('dsp_x')).toEqual({ state: 'failed' })
  failure = new Error('request:fail')
  expect(await loadDisputeDetail('dsp_x')).toEqual({ state: 'failed' })
})

test('订单入口：本人 PENDING 一命中就收工，同时带上对方的可见争议', async () => {
  pageResponder = (cursor) =>
    cursor === undefined
      ? {
          items: [
            disputeFixture({
              id: 'dsp_other',
              initiator: seller,
              respondent: buyer,
            }),
            disputeFixture({ id: 'dsp_mine_resolved', status: 'RESOLVED' }),
          ],
          nextCursor: 'c2',
        }
      : { items: [disputeFixture({ id: 'dsp_mine_pending' })], nextCursor: null }

  expect(await findDisputeForTransaction('txn_1', buyer.id)).toEqual({
    mine: { id: 'dsp_mine_pending', status: 'PENDING' },
    other: { id: 'dsp_other', status: 'PENDING' },
    failed: false,
  })
  expect(pageCursors).toEqual([undefined, 'c2'])
})

test('订单入口：没有本人 PENDING 时 mine/other 都带出来给「查看」入口', async () => {
  pageResponder = () => ({
    items: [
      disputeFixture({ id: 'dsp_mine', status: 'WITHDRAWN' }),
      disputeFixture({ id: 'dsp_other', initiator: seller, respondent: buyer }),
      // 别的交易的争议不参与归类
      disputeFixture({
        id: 'dsp_other_tx',
        initiator: seller,
        respondent: buyer,
        transaction: { ...disputeFixture().transaction, id: 'txn_2' },
      }),
    ],
    nextCursor: null,
  })

  expect(await findDisputeForTransaction('txn_1', buyer.id)).toEqual({
    mine: { id: 'dsp_mine', status: 'WITHDRAWN' },
    other: { id: 'dsp_other', status: 'PENDING' },
    failed: false,
  })
})

test('订单入口：游标不前进就收敛，不会无限翻页', async () => {
  pageResponder = () => ({ items: [], nextCursor: 'c-same' })
  expect(await findDisputeForTransaction('txn_1', buyer.id)).toEqual({
    mine: null,
    other: null,
    failed: false,
  })
  // 第一页拿到的 nextCursor 与请求游标相同 → 立刻收手（否则会原地打转）
  expect(pageCursors).toEqual([undefined, 'c-same'])
})

test('列表页：DTO 压成列表行（角色/状态/交易摘要），失败落 failed', async () => {
  pageResponder = () => ({
    items: [disputeFixture()],
    nextCursor: 'c2',
  })
  const page = await loadDisputePage(undefined, buyer.id, Date.parse('2026-10-20T12:00:00.000Z'))
  expect(page.failed).toBe(false)
  expect(page.nextCursor).toBe('c2')
  expect(page.items).toHaveLength(1)
  expect(page.items[0]?.roleLabel).toBe('我发起')
  expect(page.items[0]?.listingTitle).toBe('索尼降噪耳机')
  expect(page.items[0]?.amountText).toBe('320')
  expect(page.items[0]?.statusLabel).toBe('处理中')

  pageResponder = () => {
    throw new Error('request:fail')
  }
  const failedPage = await loadDisputePage('c2', buyer.id, Date.parse('2026-10-20T12:00:00.000Z'))
  expect(failedPage.failed).toBe(true)
})
