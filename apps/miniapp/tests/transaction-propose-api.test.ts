import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

/**
 * 「立即购买」提案端点的请求构造与失败映射（对齐 PC buy-dialog 的语义）。
 *
 * 替换 `@/lib/request` 的 `apiRequest`（只此一处），**不**替换
 * `features/transaction/api` —— 这样用例同时覆盖真实模块的**请求构造**
 * （路径、method、body）与契约解析（`messageDtoSchema` 收口），
 * 手法与 `wishes-api.test.ts` 一致：`mock.module` 后再动态 import 被测模块。
 */

/** 契约错误信封在客户端侧的形状（`@/lib/request` 的 `isApiError` 按 name+code+status 认） */
class FakeApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type ApiCall = { path: string; method?: string; body?: unknown }

const calls: ApiCall[] = []

/** 规范 UUIDv7 → 公开 ID（契约对 msg_/cnv_ 前缀与形状有断言，测试不喂裸串）。 */
const uuid = (n: number) => `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const CONVERSATION_ID = encodePublicId(PUBLIC_ID_PREFIX.conversation, uuid(1))
const MESSAGE_ID = encodePublicId(PUBLIC_ID_PREFIX.message, uuid(2))

/** 提案响应就是那条 `tx.proposal` SYSTEM 消息（`features/transaction/api` 注释同源）。 */
const PROPOSAL_MESSAGE: MessageDto = {
  id: MESSAGE_ID,
  conversationId: CONVERSATION_ID,
  senderId: null,
  sender: null,
  type: 'SYSTEM',
  content: JSON.stringify({ type: 'tx.proposal', amountCents: 76000 }),
  createdAt: '2026-10-04T03:30:00.000Z',
  recalledAt: null,
  replyTo: null,
}

mock.module('@/lib/request', () => ({
  apiRequest: async (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, method: init?.method, body: init?.body })
    return PROPOSAL_MESSAGE
  },
  isApiError: (error: unknown): error is FakeApiError =>
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'ApiError' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { status?: unknown }).status === 'number',
}))

const { proposeTransaction, describeProposeFailure } = await import(
  '../src/features/transaction/api'
)

beforeEach(() => {
  calls.length = 0
})

describe('proposeTransaction — 请求构造与解析', () => {
  test('POST /transactions/proposals，body 带 conversationId 与整数分金额', async () => {
    const message = await proposeTransaction(CONVERSATION_ID, 76000)
    expect(calls).toEqual([
      {
        path: TRANSACTION_ROUTES.proposals,
        method: 'POST',
        body: { conversationId: CONVERSATION_ID, amountCents: 76000 },
      },
    ])
    expect(message.type).toBe('SYSTEM')
    expect(message.conversationId).toBe(CONVERSATION_ID)
  })
})

describe('describeProposeFailure — 失败映射（口径对齐 PC）', () => {
  test('LISTING_NOT_ACTIVE 要求页面重取详情（状态漂移）', () => {
    const view = describeProposeFailure(new FakeApiError(409, 'LISTING_NOT_ACTIVE', '商品已不在售'))
    expect(view).toEqual({ message: '商品已不在售，可能已被他人拍下', refresh: true })
  })

  test('身份/归属/校验类错误给安全文案，不触发刷新', () => {
    expect(describeProposeFailure(new FakeApiError(403, 'NOT_CONVERSATION_BUYER', 'x'))).toEqual({
      message: '只有买家可以发起交易确认',
      refresh: false,
    })
    expect(describeProposeFailure(new FakeApiError(404, 'CONVERSATION_NOT_FOUND', 'x'))).toEqual({
      message: '会话不存在或不可访问',
      refresh: false,
    })
    expect(describeProposeFailure(new FakeApiError(422, 'VALIDATION_FAILED', 'x'))).toEqual({
      message: '金额不合法，请核对后重试',
      refresh: false,
    })
  })

  test('非 ApiError（网络失败等）给通用兜底文案', () => {
    expect(describeProposeFailure(new Error('request:fail'))).toEqual({
      message: '发起交易确认失败，请重试',
      refresh: false,
    })
  })
})
