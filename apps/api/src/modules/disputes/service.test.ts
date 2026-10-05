import { expect, mock, test } from 'bun:test'
import { contentDigestOf } from '../uploads/dispute-media'
import type { MediaIntegrity, MediaStorage } from '../uploads/storage'
import { createDisputeService, DisputeServiceError } from './service'
import type { DisputeJoinedRow, DisputeStore, DisputeTransactionRow } from './store'

const NOW = Date.UTC(2026, 9, 6, 0, 0, 0)
const DAY = 24 * 60 * 60 * 1000

const DISPUTE_ID = '01930000-0000-7000-8000-00000000000a'
const TRANSACTION_ID = '01930000-0000-7000-8000-00000000000b'
const LISTING_ID = '01930000-0000-7000-8000-00000000000c'
const BUYER_ID = '01930000-0000-7000-8000-00000000000d'
const SELLER_ID = '01930000-0000-7000-8000-00000000000e'
const ATTACHMENT_ID = '01930000-0000-7000-8000-00000000000f'
const MESSAGE_ID = '01930000-0000-7000-8000-000000000010'
const STRANGER_ID = '01930000-0000-7000-8000-000000000011'

/** 最小可解析 PNG：签名 + IHDR(length=13) + 宽高，probeImage 只读这些字段。 */
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 20, 0, 0, 0, 16, 8, 6, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
])

/** 确认时刻读到的字节摘要：写侧与读侧必须算出同一个值（#465 P1-1）。 */
const DIGEST = contentDigestOf(PNG)

function transaction(overrides: Partial<DisputeTransactionRow> = {}): DisputeTransactionRow {
  return {
    id: TRANSACTION_ID,
    listingId: LISTING_ID,
    listingTitle: '二手显示器',
    buyer: { id: BUYER_ID, nickname: '买家' },
    seller: { id: SELLER_ID, nickname: '卖家' },
    amountCents: 12000,
    status: 'PENDING_MEETUP',
    completedAt: null,
    cancelledAt: null,
    createdAt: new Date(NOW - 2 * DAY),
    ...overrides,
  }
}

function joined(
  dispute: Partial<DisputeJoinedRow['dispute']> = {},
  overrides: Partial<DisputeJoinedRow> = {},
): DisputeJoinedRow {
  return {
    dispute: {
      id: DISPUTE_ID,
      transactionId: TRANSACTION_ID,
      initiatorId: BUYER_ID,
      respondentId: SELLER_ID,
      type: 'ITEM_MISMATCH',
      detailText: '货不对板',
      status: 'PENDING',
      resolution: null,
      resolutionNote: null,
      handledBy: null,
      handledAt: null,
      withdrawnAt: null,
      createdAt: new Date(NOW - DAY),
      updatedAt: new Date(NOW - DAY),
      createdAtCursor: '2026-10-05T00:00:00.000000Z',
      ...dispute,
    },
    initiator: { id: BUYER_ID, nickname: '买家' },
    respondent: { id: SELLER_ID, nickname: '卖家' },
    transaction: transaction(),
    handler: null,
    ...overrides,
  }
}

function makeStore(overrides: Partial<DisputeStore> = {}): DisputeStore {
  const base: DisputeStore = {
    findTransactionForViewer: mock(async () => transaction()),
    findPendingDisputeId: mock(async () => null),
    insertDispute: mock(async () => ({ kind: 'created' as const, disputeId: DISPUTE_ID })),
    findDispute: mock(async () => joined()),
    listMine: mock(async () => []),
    listAdminDisputes: mock(async () => []),
    listRelatedPending: mock(async () => []),
    countDisputesByTransaction: mock(async () => 1),
    countAttachments: mock(async () => 0),
    listAttachments: mock(async () => []),
    insertAttachment: mock(async () => ({
      kind: 'created' as const,
      attachmentId: ATTACHMENT_ID,
    })),
    findAttachmentByObjectKey: mock(async () => null),
    findAttachmentById: mock(async () => null),
    countEvidence: mock(async () => 0),
    listEvidence: mock(async () => []),
    findEvidenceCandidate: mock(async () => null),
    findEvidenceRow: mock(async () => null),
    insertEvidence: mock(async () => ({ kind: 'created' as const, evidenceId: 'evi' })),
    withdrawDispute: mock(async () => 'applied' as const),
    resolveDispute: mock(async () => 'applied' as const),
  }
  return { ...base, ...overrides }
}

function makeStorage(overrides: Partial<MediaStorage> = {}): MediaStorage {
  return {
    presignPut: mock(() => ({
      url: 'https://s3.example.com/fish/put?sig=1',
      headers: {},
      expiresAt: new Date(NOW + 600_000).toISOString(),
    })),
    stat: mock(async () => ({ size: PNG.length, contentType: 'image/png' })),
    // 与真实实现同款 fail-closed：争议附件的读地址必须带字节摘要，
    // 否则读侧无法判断下发前对象有没有被替换。
    publicUrl: mock((key: string, integrity?: MediaIntegrity) => {
      if (!integrity) throw new Error('争议附件读地址缺少字节摘要')
      return `https://web.example.com/api/uploads/dispute-media/${key.length}?d=${integrity.contentDigest.slice(0, 8)}`
    }),
    readMediaBytes: mock(async () => PNG),
    ...overrides,
  }
}

function service(store: DisputeStore, storage = makeStorage()) {
  // 通知不在 service 层：它由 store 在「状态变更的同一事务」里写（#465 P2-2），
  // 所以这里注入不了、也不该注入 notifier。
  return createDisputeService({ store, storage, now: () => NOW })
}

async function rejects(promise: Promise<unknown>): Promise<DisputeServiceError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof DisputeServiceError) return error
    throw error
  }
  throw new Error('期望抛出 DisputeServiceError，但没有抛错')
}

test('发起争议：非参与人与交易不存在同码 404，不给外人枚举交易的信道', async () => {
  const store = makeStore({ findTransactionForViewer: mock(async () => null) })
  const error = await rejects(
    service(store).createDispute(STRANGER_ID, {
      transactionId: TRANSACTION_ID,
      type: 'ITEM_MISMATCH',
      detailText: null,
    }),
  )
  expect(error.code).toBe('DISPUTE_TRANSACTION_NOT_FOUND')
  expect(error.status).toBe(404)
  expect(store.insertDispute).not.toHaveBeenCalled()
})

test('发起争议：终态交易超过 30 天关窗（409），30 天内仍可发起', async () => {
  const closed = makeStore({
    findTransactionForViewer: mock(async () =>
      transaction({
        status: 'COMPLETED',
        completedAt: new Date(NOW - 31 * DAY),
      }),
    ),
  })
  const error = await rejects(
    service(closed).createDispute(BUYER_ID, {
      transactionId: TRANSACTION_ID,
      type: 'ITEM_MISMATCH',
      detailText: null,
    }),
  )
  expect(error.code).toBe('DISPUTE_WINDOW_CLOSED')
  expect(error.status).toBe(409)

  // 取消交易同样走这个窗口。
  const cancelled = makeStore({
    findTransactionForViewer: mock(async () =>
      transaction({ status: 'CANCELLED', cancelledAt: new Date(NOW - 29 * DAY) }),
    ),
  })
  const ok = await service(cancelled).createDispute(BUYER_ID, {
    transactionId: TRANSACTION_ID,
    type: 'NOT_COMPLETED',
    detailText: null,
  })
  expect(ok.created).toBe(true)
})

test('发起争议：PENDING_MEETUP 期间没有时限', async () => {
  const store = makeStore({
    findTransactionForViewer: mock(async () =>
      transaction({ createdAt: new Date(NOW - 400 * DAY) }),
    ),
  })
  const result = await service(store).createDispute(SELLER_ID, {
    transactionId: TRANSACTION_ID,
    type: 'PAYMENT_ISSUE',
    detailText: null,
  })
  expect(result.created).toBe(true)
})

test('被诉方由交易推导：卖家发起则被诉方是买家（请求体指定不了被诉方）', async () => {
  const store = makeStore()
  await service(store).createDispute(SELLER_ID, {
    transactionId: TRANSACTION_ID,
    type: 'ITEM_MISMATCH',
    detailText: null,
  })

  expect(store.insertDispute).toHaveBeenCalledWith({
    transactionId: TRANSACTION_ID,
    initiatorId: SELLER_ID,
    respondentId: BUYER_ID,
    type: 'ITEM_MISMATCH',
    detailText: null,
  })
})

test('重复发起：命中既有未决争议时返回 created:false，且不再写第二次', async () => {
  const store = makeStore({
    insertDispute: mock(async () => ({ kind: 'duplicate' as const, disputeId: DISPUTE_ID })),
  })
  const result = await service(store).createDispute(BUYER_ID, {
    transactionId: TRANSACTION_ID,
    type: 'ITEM_MISMATCH',
    detailText: null,
  })

  expect(result.created).toBe(false)
  expect(result.dispute.id).toBe(`dsp_${'01jc000000e00800000000000a'}`)
  expect(store.insertDispute).toHaveBeenCalledTimes(1)
})

test('通知不在 service 层，也不被吞掉：store 出错必须原样抛出', async () => {
  // 通知与状态变更同事务（#465 P2-2）之后，service 层没有 notifier 可注入。
  // 这条用例守的是「别再加回 best-effort 的 catch」——一旦把事务里的通知失败
  // 吞成 warn，当事人就会永久收不到结论，而库里没有 outbox 可补。
  const store = makeStore({
    insertDispute: mock(async () => {
      throw new Error('通知写入失败（与争议同事务）')
    }),
  })
  let thrown: unknown = null
  try {
    await service(store).createDispute(BUYER_ID, {
      transactionId: TRANSACTION_ID,
      type: 'ITEM_MISMATCH',
      detailText: null,
    })
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).message).toBe('通知写入失败（与争议同事务）')
})

test('撤回：被诉方撤回 → 404；已处理的争议 → 409', async () => {
  const asRespondent = makeStore()
  const notInitiator = await rejects(service(asRespondent).withdrawDispute(SELLER_ID, DISPUTE_ID))
  expect(notInitiator.code).toBe('DISPUTE_NOT_FOUND')
  expect(asRespondent.withdrawDispute).not.toHaveBeenCalled()

  const resolved = makeStore({
    findDispute: mock(async () => joined({ status: 'RESOLVED', resolution: 'UPHELD' })),
  })
  const error = await rejects(service(resolved).withdrawDispute(BUYER_ID, DISPUTE_ID))
  expect(error.code).toBe('DISPUTE_NOT_PENDING')
  expect(error.status).toBe(409)
})

test('撤回：发起人成功撤回；并发竞争（条件更新 0 行）同样 409', async () => {
  const ok = makeStore()
  await service(ok).withdrawDispute(BUYER_ID, DISPUTE_ID)
  expect(ok.withdrawDispute).toHaveBeenCalledWith({ disputeId: DISPUTE_ID, initiatorId: BUYER_ID })

  const raced = makeStore({ withdrawDispute: mock(async () => 'conflict' as const) })
  const error = await rejects(service(raced).withdrawDispute(BUYER_ID, DISPUTE_ID))
  expect(error.code).toBe('DISPUTE_NOT_PENDING')
})

test('管理端处理：不存在 404、并发竞争 409、成功时不触碰交易状态', async () => {
  const missing = makeStore({ findDispute: mock(async () => null) })
  expect(
    (
      await rejects(
        service(missing).resolveDispute({
          disputeId: DISPUTE_ID,
          actorUserId: STRANGER_ID,
          resolution: 'UPHELD',
          reason: '属实',
        }),
      )
    ).code,
  ).toBe('DISPUTE_NOT_FOUND')

  const conflict = makeStore({ resolveDispute: mock(async () => 'conflict' as const) })
  const conflictError = await rejects(
    service(conflict).resolveDispute({
      disputeId: DISPUTE_ID,
      actorUserId: STRANGER_ID,
      resolution: 'DISMISSED',
      reason: '不成立',
    }),
  )
  expect(conflictError.code).toBe('DISPUTE_CONFLICT')
  expect(conflictError.status).toBe(409)

  const ok = makeStore()
  await service(ok).resolveDispute({
    disputeId: DISPUTE_ID,
    actorUserId: STRANGER_ID,
    resolution: 'UPHELD',
    reason: '属实',
  })
  expect(ok.resolveDispute).toHaveBeenCalledWith({
    disputeId: DISPUTE_ID,
    actorUserId: STRANGER_ID,
    resolution: 'UPHELD',
    reason: '属实',
  })
  // 处理争议不产生任何交易/商品侧写入：store 上没有这类方法可调。
  expect(ok.findTransactionForViewer).not.toHaveBeenCalled()
})

test('管理端详情：related 只看未决（封顶 20），disputeCount 走全量计数而不是 related.length+1', async () => {
  const related: DisputeJoinedRow[] = [
    joined({ id: '01930000-0000-7000-8000-000000000012', status: 'PENDING' }),
  ]
  const store = makeStore({
    listRelatedPending: mock(async () => related),
    countDisputesByTransaction: mock(async () => 7),
  })

  const detail = await service(store).getAdminDispute(DISPUTE_ID)

  // 同一交易上的其它未决争议：上限由 service 固定，SQL 侧再过滤 PENDING。
  expect(store.listRelatedPending).toHaveBeenCalledWith(TRANSACTION_ID, DISPUTE_ID, 20)
  expect(detail.related.map((row) => row.id)).toHaveLength(1)
  // 计数必须是同交易全部争议数（含终态、含本条），不能是 related.length + 1。
  expect(detail.item.disputeCount).toBe(7)
})

test('附件：超过 6 张拒绝，且预签名键把争议与上传者都编码进去', async () => {
  const full = makeStore({ countAttachments: mock(async () => 6) })
  const error = await rejects(
    service(full).presignAttachment(BUYER_ID, DISPUTE_ID, {
      contentType: 'image/png',
      sizeBytes: 10,
    }),
  )
  expect(error.code).toBe('DISPUTE_ATTACHMENT_LIMIT')
  expect(error.status).toBe(422)

  const store = makeStore()
  const presigned = await service(store).presignAttachment(BUYER_ID, DISPUTE_ID, {
    contentType: 'image/png',
    sizeBytes: 10,
  })
  expect(presigned.objectKey).toStartWith(
    `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_`,
  )
  expect(presigned.objectKey).toEndWith('.png')
  expect(presigned.uploadUrl).toBe('https://s3.example.com/fish/put?sig=1')
})

test('附件：已处理的争议不能再补材料（409）', async () => {
  const resolved = makeStore({
    findDispute: mock(async () => joined({ status: 'RESOLVED', resolution: 'DISMISSED' })),
  })
  const error = await rejects(
    service(resolved).presignAttachment(BUYER_ID, DISPUTE_ID, {
      contentType: 'image/png',
      sizeBytes: 10,
    }),
  )
  expect(error.code).toBe('DISPUTE_NOT_PENDING')
})

test('附件确认：对象键不属于本次争议 / 不属于本人 → 422', async () => {
  const store = makeStore()
  const svc = service(store)
  const foreign = await rejects(
    svc.confirmAttachment(BUYER_ID, DISPUTE_ID, {
      objectKey: `dispute-media/dsp_01jc000000e00800000000000b/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`,
    }),
  )
  expect(foreign.code).toBe('DISPUTE_ATTACHMENT_INVALID')

  const notMine = await rejects(
    svc.confirmAttachment(BUYER_ID, DISPUTE_ID, {
      objectKey: `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000e/med_01jc000000e00800000000000f.png`,
    }),
  )
  expect(notMine.code).toBe('DISPUTE_ATTACHMENT_INVALID')

  // 裸 UUID 键（非公开 ID）同样拒。
  expect(
    (
      await rejects(
        svc.confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey: `${DISPUTE_ID}/x.png` }),
      )
    ).code,
  ).toBe('DISPUTE_ATTACHMENT_INVALID')
})

test('附件确认：字节数与 stat 不一致、魔术字节与声明 mime 不一致都拒（客户端声明不可信）', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`

  // 校验失败也要把刚 PUT 的对象删掉：私有前缀没有后台 GC，presign 只签 key，
  // 客户端 PUT 完不 confirm 就会永久留垃圾（审查 P2-3）。
  const deleted: string[] = []
  const withDelete = {
    delete: mock(async (key: string) => {
      deleted.push(key)
    }),
  }

  const sizeMismatch = makeStore()
  const error = await rejects(
    service(
      sizeMismatch,
      makeStorage({
        stat: mock(async () => ({ size: PNG.length + 5, contentType: 'image/png' })),
        ...withDelete,
      }),
    ).confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey }),
  )
  expect(error.code).toBe('DISPUTE_ATTACHMENT_INVALID')
  expect(sizeMismatch.insertAttachment).not.toHaveBeenCalled()
  expect(deleted).toEqual([objectKey])

  const notAnImage = makeStore()
  const notImageError = await rejects(
    service(
      notAnImage,
      makeStorage({ readMediaBytes: mock(async () => new Uint8Array(PNG.length)) }),
    ).confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey }),
  )
  expect(notImageError.code).toBe('DISPUTE_ATTACHMENT_INVALID')
  expect(notAnImage.insertAttachment).not.toHaveBeenCalled()
})

test('附件确认：校验通过后落库，返回带摘要的私有读地址与真实宽高', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`
  const attachmentRow = {
    id: ATTACHMENT_ID,
    disputeId: DISPUTE_ID,
    uploaderId: BUYER_ID,
    objectKey,
    mimeType: 'image/png',
    sizeBytes: PNG.length,
    width: 20,
    height: 16,
    contentDigest: DIGEST,
    createdAt: new Date(NOW - 1000),
    uploaderNickname: '买家',
  }
  // 幂等快速路径先查一次（此时还没有行），落库后再查一次必须能读回。
  let inserted = false
  const store = makeStore({
    insertAttachment: mock(async () => {
      inserted = true
      return { kind: 'created' as const, attachmentId: ATTACHMENT_ID }
    }),
    findAttachmentById: mock(async () => (inserted ? attachmentRow : null)),
  })
  const result = await service(store).confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey })
  expect(result.created).toBe(true)
  expect(store.insertAttachment).toHaveBeenCalledWith(
    {
      id: '01930000-0000-7000-8000-00000000000f',
      disputeId: DISPUTE_ID,
      uploaderId: BUYER_ID,
      objectKey,
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      width: 20,
      height: 16,
      // 摘要是「确认时刻实际读到的字节」的 sha256，不是客户端给的任何东西。
      contentDigest: DIGEST,
    },
    6,
  )
  expect(result.attachment.url).toStartWith('https://web.example.com/api/uploads/dispute-media/')
  expect(result.attachment.url).toContain(`d=${DIGEST.slice(0, 8)}`)
  expect(result.attachment.width).toBe(20)
  expect(result.attachment.height).toBe(16)
})

test('附件确认：落库后读不回时清掉对象再抛错，不留下没有台账的孤儿字节', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`
  const deleted: string[] = []
  const storage = makeStorage({
    delete: mock(async (key: string) => {
      deleted.push(key)
    }),
  })
  const store = makeStore()
  await expect(
    service(store, storage).confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey }),
  ).rejects.toThrow('附件写入后无法读回')
  expect(deleted).toEqual([objectKey])
})

test('附件确认：同一对象键重复确认幂等，但仍要重读字节核对摘要', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`
  const storage = makeStorage()
  const store = makeStore({
    findAttachmentById: mock(async () => ({
      id: ATTACHMENT_ID,
      disputeId: DISPUTE_ID,
      uploaderId: BUYER_ID,
      objectKey,
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      width: 20,
      height: 16,
      contentDigest: DIGEST,
      createdAt: new Date(NOW - 1000),
      uploaderNickname: '买家',
    })),
  })
  const result = await service(store, storage).confirmAttachment(BUYER_ID, DISPUTE_ID, {
    objectKey,
  })
  expect(result.created).toBe(false)
  expect(store.insertAttachment).not.toHaveBeenCalled()
  expect(storage.stat).not.toHaveBeenCalled()
  // 幂等 ≠ 不校验：预签名 URL 在 600s 内还能对同一 key 二次 PUT，
  // 所以快速路径必须重读一次字节比对摘要（#465 P1-1）。
  expect(storage.readMediaBytes).toHaveBeenCalledTimes(1)
})

test('附件确认：幂等路径发现对象已被替换 → 422，绝不把换过的字节发出去', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`
  // 台账里记的是 DIGEST（PNG），桶里现在是另一张图（同长度，避免被长度检查挡住）。
  const replaced = new Uint8Array(PNG.length)
  replaced.set(PNG.subarray(0, 20))
  const store = makeStore({
    findAttachmentById: mock(async () => ({
      id: ATTACHMENT_ID,
      disputeId: DISPUTE_ID,
      uploaderId: BUYER_ID,
      objectKey,
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      width: 20,
      height: 16,
      contentDigest: DIGEST,
      createdAt: new Date(NOW - 1000),
      uploaderNickname: '买家',
    })),
  })
  const error = await rejects(
    service(store, makeStorage({ readMediaBytes: mock(async () => replaced) })).confirmAttachment(
      BUYER_ID,
      DISPUTE_ID,
      { objectKey },
    ),
  )
  expect(error.code).toBe('DISPUTE_ATTACHMENT_INVALID')
  expect(error.message).toBe('附件内容已被替换')
})

test('附件确认：键属本人但行归别人（撞键）→ 422（附件已被占用）', async () => {
  // 键的上传者段必须是**当前请求者**（否则更早的归属闸门就拦下了），
  // 但台账行属于买家 —— 这条路径守的是 findAttachmentById 命中时的行级核对。
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000e/med_01jc000000e00800000000000f.png`
  const store = makeStore({
    findAttachmentById: mock(async () => ({
      id: ATTACHMENT_ID,
      disputeId: DISPUTE_ID,
      uploaderId: BUYER_ID,
      objectKey,
      mimeType: 'image/png',
      sizeBytes: PNG.length,
      width: 20,
      height: 16,
      contentDigest: DIGEST,
      createdAt: new Date(NOW - 1000),
      uploaderNickname: '买家',
    })),
  })
  const error = await rejects(
    service(store).confirmAttachment(SELLER_ID, DISPUTE_ID, { objectKey }),
  )
  expect(error.code).toBe('DISPUTE_ATTACHMENT_INVALID')
  expect(error.message).toBe('附件已被占用')
})

test('附件确认：键属于别的争议（同一上传者）→ 422（附件对象键不属于本次争议）', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000b/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`
  const error = await rejects(
    service(makeStore()).confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey }),
  )
  expect(error.code).toBe('DISPUTE_ATTACHMENT_INVALID')
  expect(error.message).toBe('附件对象键不属于本次争议')
})

test('附件确认：上限由 store 在锁内判定（kind=limit）→ 422，并清掉刚 PUT 的对象', async () => {
  const objectKey = `dispute-media/dsp_01jc000000e00800000000000a/usr_01jc000000e00800000000000d/med_01jc000000e00800000000000f.png`
  const deleted: string[] = []
  const store = makeStore({
    insertAttachment: mock(async () => ({ kind: 'limit' as const, attachmentId: null })),
  })
  const error = await rejects(
    service(
      store,
      makeStorage({
        delete: mock(async (key: string) => {
          deleted.push(key)
        }),
      }),
    ).confirmAttachment(BUYER_ID, DISPUTE_ID, { objectKey }),
  )
  expect(error.code).toBe('DISPUTE_ATTACHMENT_LIMIT')
  expect(error.status).toBe(422)
  expect(deleted).toEqual([objectKey])
})

test('证据：只接受本交易会话里的消息，否则 404（不泄漏别的会话是否存在）', async () => {
  const store = makeStore()
  const error = await rejects(
    service(store).addEvidence(BUYER_ID, DISPUTE_ID, { messageId: MESSAGE_ID }),
  )
  expect(error.code).toBe('DISPUTE_MESSAGE_NOT_FOUND')
  expect(error.status).toBe(404)
  expect(store.insertEvidence).not.toHaveBeenCalled()
})

test('证据：关联成功后返回单条消息投影（撤回的消息仍返回正文）', async () => {
  const store = makeStore({
    findEvidenceCandidate: mock(async () => ({
      messageId: MESSAGE_ID,
      messageType: 'TEXT',
      messageSenderId: SELLER_ID,
      messageSenderNickname: '卖家',
      messageContent: '货我已经寄出了',
      messageRecalledAt: new Date(NOW - 500),
      messageCreatedAt: new Date(NOW - 1000),
    })),
    findEvidenceRow: mock(async () => ({
      id: 'evi',
      disputeId: DISPUTE_ID,
      messageId: MESSAGE_ID,
      addedBy: BUYER_ID,
      createdAt: new Date(NOW - 100),
      adderNickname: '买家',
      messageType: 'TEXT',
      messageSenderId: SELLER_ID,
      messageSenderNickname: '卖家',
      messageContent: '货我已经寄出了',
      messageRecalledAt: new Date(NOW - 500),
      messageCreatedAt: new Date(NOW - 1000),
    })),
  })
  const result = await service(store).addEvidence(BUYER_ID, DISPUTE_ID, { messageId: MESSAGE_ID })
  expect(result.created).toBe(true)
  expect(result.evidence.message.content).toBe('货我已经寄出了')
  expect(result.evidence.message.recalledAt).not.toBeNull()
  expect(result.evidence.message.senderId).toBe(`usr_01jc000000e00800000000000e`)
})

test('可见性：非参与人读详情 → 404，不区分「不存在」与「不是我的」', async () => {
  const store = makeStore({ findDispute: mock(async () => null) })
  const error = await rejects(service(store).getDispute(STRANGER_ID, DISPUTE_ID))
  expect(error.code).toBe('DISPUTE_NOT_FOUND')
  expect(error.status).toBe(404)
  expect(store.findDispute).toHaveBeenCalledWith(DISPUTE_ID, STRANGER_ID)
})

test('游标非法 → 422 VALIDATION_FAILED（不静默从头开始翻页）', async () => {
  const store = makeStore()
  const error = await rejects(
    service(store).listMine(BUYER_ID, { cursor: 'not-a-cursor', limit: 20 }),
  )
  expect(error.code).toBe('VALIDATION_FAILED')
  expect(error.status).toBe(422)
  expect(store.listMine).not.toHaveBeenCalled()
})

test('我的争议列表：多取一条判断 hasMore 并给出 nextCursor', async () => {
  const rows = [joined({ id: DISPUTE_ID }, {}), joined({ id: DISPUTE_ID })]
  const store = makeStore({ listMine: mock(async () => rows) })
  const page = await service(store).listMine(BUYER_ID, { limit: 1 })
  expect(store.listMine).toHaveBeenCalledWith({
    viewerId: BUYER_ID,
    cursor: null,
    limit: 2,
  })
  expect(page.items).toHaveLength(1)
  expect(page.nextCursor).not.toBeNull()
})
