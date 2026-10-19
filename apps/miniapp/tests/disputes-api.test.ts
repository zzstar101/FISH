import { beforeEach, expect, mock, test } from 'bun:test'
import { DISPUTE_ROUTES } from '@fish/contracts/disputes/routes'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

/**
 * 争议 API 适配器（#497）：路径只从契约常量取、响应一律过 zod 校验。
 *
 * 这两件事都不会在 typecheck 里露馅 —— 拼错路径只在真机上 404，漏掉 `.parse()` 会让
 * 服务端多给的字段/坏形状直接进页面。所以这里把 `apiRequest` 换成记录器，断言
 * **请求形状**（path / method / query / body）并喂坏响应验证拒绝。
 */

const uuid = (suffix: number) => `0199a000-0000-7000-8000-${String(suffix).padStart(12, '0')}`

const userId = encodePublicId(PUBLIC_ID_PREFIX.user, uuid(1))
const otherUserId = encodePublicId(PUBLIC_ID_PREFIX.user, uuid(2))
const disputeId = encodePublicId(PUBLIC_ID_PREFIX.dispute, uuid(3))
const transactionId = encodePublicId(PUBLIC_ID_PREFIX.transaction, uuid(4))
const listingId = encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(5))
const mediaId = encodePublicId(PUBLIC_ID_PREFIX.media, uuid(6))
const messageId = encodePublicId(PUBLIC_ID_PREFIX.message, uuid(7))

const ME = { id: userId, nickname: '买家小周' }
const PEER = { id: otherUserId, nickname: '卖家小林' }

function disputeFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: disputeId,
    type: 'ITEM_MISMATCH',
    status: 'PENDING',
    detailText: '收到的耳机缺一只耳塞',
    initiator: ME,
    respondent: PEER,
    transaction: {
      id: transactionId,
      listingId,
      listingTitle: '索尼降噪耳机',
      buyer: ME,
      seller: PEER,
      amountCents: 32000,
      status: 'COMPLETED',
      completedAt: '2026-10-01T02:00:00.000Z',
      cancelledAt: null,
      createdAt: '2026-09-28T02:00:00.000Z',
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

const detailFixture = () => ({
  ...disputeFixture(),
  attachments: [
    {
      id: mediaId,
      url: 'https://media.example.com/uploads/dispute-media/token',
      mimeType: 'image/jpeg',
      sizeBytes: 120_000,
      width: 1200,
      height: 900,
      uploadedBy: ME,
      createdAt: '2026-10-02T03:00:00.000Z',
    },
  ],
  evidence: [
    {
      message: {
        id: messageId,
        type: 'TEXT',
        senderId: otherUserId,
        senderNickname: PEER.nickname,
        content: '我确认是全新未拆封的',
        recalledAt: null,
        createdAt: '2026-09-29T02:00:00.000Z',
      },
      addedBy: ME,
      createdAt: '2026-10-02T04:00:00.000Z',
    },
  ],
})

type Call = { path: string; method: string | undefined; query: unknown; body: unknown }
const calls: Call[] = []
let payload: unknown = {}

mock.module('@/lib/request', () => ({
  apiRequest: async (
    path: string,
    options: { method?: string; query?: unknown; body?: unknown } = {},
  ) => {
    calls.push({ path, method: options.method, query: options.query, body: options.body })
    return payload
  },
}))

const {
  addDisputeEvidence,
  confirmDisputeAttachment,
  createDispute,
  fetchDisputeDetail,
  fetchMyDisputePage,
  presignDisputeAttachment,
  withdrawDispute,
} = await import('@/features/disputes/api')

beforeEach(() => {
  calls.length = 0
  payload = {}
})

test('我的争议：走 /disputes/mine，带 limit 与不透明 cursor', async () => {
  payload = { items: [disputeFixture()], nextCursor: 'opaque' }
  const page = await fetchMyDisputePage()
  expect(page.items).toHaveLength(1)
  expect(page.nextCursor).toBe('opaque')
  await fetchMyDisputePage('opaque')
  expect(calls).toEqual([
    {
      path: DISPUTE_ROUTES.mine,
      method: undefined,
      query: { limit: 20, cursor: undefined },
      body: undefined,
    },
    {
      path: DISPUTE_ROUTES.mine,
      method: undefined,
      query: { limit: 20, cursor: 'opaque' },
      body: undefined,
    },
  ])
})

test('详情：路径取契约 detail(id)，且必须是 DisputeDetail 形状', async () => {
  payload = detailFixture()
  const detail = await fetchDisputeDetail(disputeId)
  expect(detail.attachments).toHaveLength(1)
  expect(detail.evidence[0]?.message.id).toBe(messageId)
  expect(calls[0]?.path).toBe(DISPUTE_ROUTES.detail(disputeId))
  expect(calls[0]?.path).toBe(`/disputes/${disputeId}`)
})

test('坏响应一律拒绝：不把缺字段/坏枚举的争议交给页面', async () => {
  payload = { items: [disputeFixture({ status: 'NOPE' })], nextCursor: null }
  await expect(fetchMyDisputePage()).rejects.toThrow()
  payload = { ...detailFixture(), attachments: undefined }
  await expect(fetchDisputeDetail(disputeId)).rejects.toThrow()
})

test('发起：POST /disputes，body 过 DisputeCreateInput；「其他」缺说明在发请求前就被拒', async () => {
  payload = { dispute: detailFixture(), created: true }
  const result = await createDispute({ transactionId, type: 'OTHER', detailText: '  情况说明  ' })
  expect(result.created).toBe(true)
  expect(calls[0]).toEqual({
    path: DISPUTE_ROUTES.create,
    method: 'POST',
    // `DisputeCreateInputSchema` 会 trim 后落库，端上不再自己 trim 一遍
    body: { transactionId, type: 'OTHER', detailText: '情况说明' },
    query: undefined,
  })

  calls.length = 0
  await expect(createDispute({ transactionId, type: 'OTHER' })).rejects.toThrow()
  expect(calls).toHaveLength(0)
})

test('撤回 / 附件 presign+confirm / 证据：路径与 method 与契约一致', async () => {
  payload = detailFixture()
  await withdrawDispute(disputeId)
  payload = {
    uploadUrl: 'https://media.example.com/put',
    objectKey: 'dispute-media/k',
    headers: { 'content-type': 'image/jpeg' },
    expiresAt: '2026-10-02T05:00:00.000Z',
  }
  await presignDisputeAttachment(disputeId, { contentType: 'image/jpeg', sizeBytes: 1024 })
  payload = { attachment: detailFixture().attachments[0], created: true }
  await confirmDisputeAttachment(disputeId, 'dispute-media/k')
  payload = { evidence: detailFixture().evidence[0], created: false }
  await addDisputeEvidence(disputeId, messageId)

  expect(calls).toEqual([
    {
      path: DISPUTE_ROUTES.withdraw(disputeId),
      method: 'POST',
      query: undefined,
      body: undefined,
    },
    {
      path: DISPUTE_ROUTES.attachmentPresign(disputeId),
      method: 'POST',
      query: undefined,
      body: { contentType: 'image/jpeg', sizeBytes: 1024 },
    },
    {
      path: DISPUTE_ROUTES.attachmentConfirm(disputeId),
      method: 'POST',
      query: undefined,
      body: { objectKey: 'dispute-media/k' },
    },
    {
      path: DISPUTE_ROUTES.evidenceMessages(disputeId),
      method: 'POST',
      query: undefined,
      body: { messageId },
    },
  ])
})
