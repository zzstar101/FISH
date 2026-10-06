import { expect, test } from 'bun:test'
import {
  AdminDisputeQueueQuerySchema,
  AdminDisputeResolveInputSchema,
  DISPUTE_WINDOW_DAYS,
  DisputeAttachmentSchema,
  DisputeCreateInputSchema,
  DisputeErrorCodeSchema,
  DisputeEvidenceMessageSchema,
  DisputeMineQuerySchema,
  DisputeSchema,
  MAX_DISPUTE_ATTACHMENTS,
  MAX_DISPUTE_DETAIL_LENGTH,
} from './schema'

const disputeId = 'dsp_01jc000000e00800000000000a'
const transactionId = 'txn_01jc000000e00800000000000b'
const listingId = 'lst_01jc000000e00800000000000c'
const userId = 'usr_01jc000000e00800000000000d'
const otherUserId = 'usr_01jc000000e00800000000000e'
const mediaId = 'med_01jc000000e00800000000000f'
const messageId = 'msg_01jc000000e00800000000000g'

const userSummary = { id: userId, nickname: '买家' }

const dispute = {
  id: disputeId,
  type: 'ITEM_MISMATCH',
  status: 'PENDING',
  detailText: '收到的商品与描述不符',
  initiator: userSummary,
  respondent: { id: otherUserId, nickname: '卖家' },
  transaction: {
    id: transactionId,
    listingId,
    listingTitle: '二手显示器',
    buyer: userSummary,
    seller: { id: otherUserId, nickname: '卖家' },
    amountCents: 12000,
    status: 'COMPLETED',
    completedAt: '2026-09-20T00:00:00.000Z',
    cancelledAt: null,
    createdAt: '2026-09-18T00:00:00.000Z',
  },
  resolution: null,
  resolutionNote: null,
  handledBy: null,
  handledAt: null,
  withdrawnAt: null,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
} as const

test('争议主体要求交易摘要与双方公开 ID 前缀正确', () => {
  expect(DisputeSchema.safeParse(dispute).success).toBe(true)
  // 交易摘要里的 listingId 用错前缀 → 整条争议不可表达。
  expect(
    DisputeSchema.safeParse({
      ...dispute,
      transaction: { ...dispute.transaction, listingId: userId },
    }).success,
  ).toBe(false)
  // 发起人 id 用错前缀同样拒绝。
  expect(
    DisputeSchema.safeParse({ ...dispute, initiator: { id: mediaId, nickname: 'x' } }).success,
  ).toBe(false)
})

test('发起争议：请求体不可指定被诉方，OTHER 必须带说明', () => {
  expect(DisputeCreateInputSchema.safeParse({ transactionId, type: 'NOT_COMPLETED' }).success).toBe(
    true,
  )
  expect(DisputeCreateInputSchema.safeParse({ transactionId, type: 'OTHER' }).success).toBe(false)
  expect(
    DisputeCreateInputSchema.safeParse({ transactionId, type: 'OTHER', detailText: '其他情况' })
      .success,
  ).toBe(true)
  // 被诉方由交易推导，客户端无从指定（strictObject 直接拒收多余字段）。
  expect(
    DisputeCreateInputSchema.safeParse({
      transactionId,
      type: 'ITEM_MISMATCH',
      respondentId: otherUserId,
    }).success,
  ).toBe(false)
  // 裸 UUID（未编码的 transactionId）不是公开 ID。
  expect(
    DisputeCreateInputSchema.safeParse({
      transactionId: '01930000-0000-7000-8000-000000000001',
      type: 'ITEM_MISMATCH',
    }).success,
  ).toBe(false)
})

test('补充说明长度上限为 1000（与举报的 200 分开：争议要描述交易过程）', () => {
  expect(MAX_DISPUTE_DETAIL_LENGTH).toBe(1000)
  expect(
    DisputeCreateInputSchema.safeParse({
      transactionId,
      type: 'ITEM_MISMATCH',
      detailText: 'a'.repeat(MAX_DISPUTE_DETAIL_LENGTH),
    }).success,
  ).toBe(true)
  expect(
    DisputeCreateInputSchema.safeParse({
      transactionId,
      type: 'ITEM_MISMATCH',
      detailText: 'a'.repeat(MAX_DISPUTE_DETAIL_LENGTH + 1),
    }).success,
  ).toBe(false)
  // 纯空白不算说明。
  expect(
    DisputeCreateInputSchema.safeParse({ transactionId, type: 'OTHER', detailText: '   ' }).success,
  ).toBe(false)
})

test('附件契约：url 必须是合法 URL，id 是 med_ 前缀，上限常量与产品口径一致', () => {
  expect(MAX_DISPUTE_ATTACHMENTS).toBe(6)
  const attachment = {
    id: mediaId,
    url: 'https://example.com/api/uploads/dispute-media/token',
    mimeType: 'image/jpeg',
    sizeBytes: 1024,
    width: 640,
    height: 480,
    uploadedBy: userSummary,
    createdAt: '2026-09-21T00:00:00.000Z',
  }
  expect(DisputeAttachmentSchema.safeParse(attachment).success).toBe(true)
  expect(DisputeAttachmentSchema.safeParse({ ...attachment, url: 'not-a-url' }).success).toBe(false)
  expect(DisputeAttachmentSchema.safeParse({ ...attachment, mimeType: 'image/heic' }).success).toBe(
    false,
  )
  expect(DisputeAttachmentSchema.safeParse({ ...attachment, sizeBytes: 0 }).success).toBe(false)
})

test('证据只投影单条消息，SYSTEM 消息允许没有发送者，且不带 conversationId', () => {
  const message = {
    id: messageId,
    type: 'SYSTEM',
    senderId: null,
    senderNickname: null,
    content: '卖家接受了交易确认',
    recalledAt: null,
    createdAt: '2026-09-21T00:00:00.000Z',
  }
  expect(DisputeEvidenceMessageSchema.safeParse(message).success).toBe(true)
  // 证据结构里没有 conversationId 这个字段（strict 之外也断言一次：解析结果不带它）。
  expect('conversationId' in DisputeEvidenceMessageSchema.parse(message)).toBe(false)
  expect(
    DisputeEvidenceMessageSchema.safeParse({ ...message, conversationId: 'cnv_x' }).success,
  ).toBe(true) // 非 strict：多余字段被剥离而不是报错；关键是它不会出现在解析结果里
  expect(
    DisputeEvidenceMessageSchema.safeParse({ ...message, senderId: otherUserId }).success,
  ).toBe(true)
})

test('我的争议列表：limit 默认 20、服务端封顶 50', () => {
  expect(DisputeMineQuerySchema.parse({}).limit).toBe(20)
  expect(DisputeMineQuerySchema.safeParse({ limit: '50' }).success).toBe(true)
  expect(DisputeMineQuerySchema.safeParse({ limit: 51 }).success).toBe(false)
  expect(DisputeMineQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
  expect(DisputeMineQuerySchema.safeParse({ cursor: '' }).success).toBe(false)
  // 未声明的筛选参数直接拒收，避免「传了但不生效」的静默行为。
  expect(DisputeMineQuerySchema.safeParse({ status: 'PENDING' }).success).toBe(false)
})

test('管理端队列：状态/类型/关键词/时间窗可选，limit 默认 20', () => {
  const parsed = AdminDisputeQueueQuerySchema.parse({})
  expect(parsed.limit).toBe(20)
  expect(parsed.status).toBeUndefined()
  expect(
    AdminDisputeQueueQuerySchema.safeParse({
      status: 'PENDING',
      type: 'PAYMENT_ISSUE',
      q: '显示器',
      createdFrom: '2026-09-01T00:00:00.000Z',
      createdTo: '2026-10-01T00:00:00.000Z',
    }).success,
  ).toBe(true)
  expect(AdminDisputeQueueQuerySchema.safeParse({ status: 'HANDLED' }).success).toBe(false)
  expect(AdminDisputeQueueQuerySchema.safeParse({ q: 'a'.repeat(51) }).success).toBe(false)
})

test('处理争议：结论 + 原因必填，原因为 1..500 的 trim 字符串', () => {
  expect(
    AdminDisputeResolveInputSchema.safeParse({ resolution: 'UPHELD', reason: '属实' }).success,
  ).toBe(true)
  expect(
    AdminDisputeResolveInputSchema.safeParse({ resolution: 'UPHELD', reason: '   ' }).success,
  ).toBe(false)
  expect(
    AdminDisputeResolveInputSchema.safeParse({ resolution: 'UPHELD', reason: 'a'.repeat(501) })
      .success,
  ).toBe(false)
  expect(
    AdminDisputeResolveInputSchema.safeParse({ resolution: 'REFUNDED', reason: 'x' }).success,
  ).toBe(false)
  // 处理输入里**没有**任何治理字段（封禁 / 下架必须走另外的端点）。
  expect(
    AdminDisputeResolveInputSchema.safeParse({ resolution: 'UPHELD', reason: 'x', ban: true })
      .success,
  ).toBe(false)
})

test('错误码冻结为 8 个，覆盖可见性 / 并发 / 窗口 / 附件四类', () => {
  expect(DisputeErrorCodeSchema.options).toEqual([
    'DISPUTE_TRANSACTION_NOT_FOUND',
    'DISPUTE_NOT_FOUND',
    'DISPUTE_MESSAGE_NOT_FOUND',
    'DISPUTE_CONFLICT',
    'DISPUTE_WINDOW_CLOSED',
    'DISPUTE_ATTACHMENT_LIMIT',
    'DISPUTE_ATTACHMENT_INVALID',
    'DISPUTE_NOT_PENDING',
  ])
})

test('发起窗口常量为 30 天（终态交易）', () => {
  expect(DISPUTE_WINDOW_DAYS).toBe(30)
})
