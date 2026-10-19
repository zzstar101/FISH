import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { DisputeDetail } from '@fish/contracts/disputes/schema'
import { ApiError } from '../../lib/api-client'
import {
  addDisputeEvidence,
  DISPUTE_PAGE_LIMIT,
  fetchDispute,
  fetchMyDisputes,
  myDisputesPath,
  startDispute,
  uploadDisputeAttachment,
  withdrawDispute,
} from './api'

const DISPUTE_ID = 'dsp_01jc000000e00800000000000a' as const
const TRANSACTION_ID = 'txn_01jc000000e00800000000000a' as const
const LISTING_ID = 'lst_01jc000000e00800000000000a' as const
const BUYER_ID = 'usr_01jc000000e00800000000000a' as const
const SELLER_ID = 'usr_01jc000000e00800000000000b' as const
const MESSAGE_ID = 'msg_01jc000000e00800000000000c' as const

const buyer = { id: BUYER_ID, nickname: '阿岚' }
const seller = { id: SELLER_ID, nickname: '小北' }

const DISPUTE_DETAIL: DisputeDetail = {
  id: DISPUTE_ID,
  type: 'ITEM_MISMATCH',
  status: 'PENDING',
  detailText: '商品有明显划痕',
  initiator: buyer,
  respondent: seller,
  transaction: {
    id: TRANSACTION_ID,
    listingId: LISTING_ID,
    listingTitle: '二手自行车',
    buyer,
    seller,
    amountCents: 12000,
    status: 'PENDING_MEETUP',
    completedAt: null,
    cancelledAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  resolution: null,
  resolutionNote: null,
  handledBy: null,
  handledAt: null,
  withdrawnAt: null,
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  attachments: [],
  evidence: [],
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

type FetchCall = { url: string; method: string; body: unknown }

function mockFetchCalls(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body:
        init?.body === undefined
          ? null
          : typeof init.body === 'string'
            ? JSON.parse(init.body)
            : init.body,
    }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as unknown as typeof fetch
  return calls
}

describe('myDisputesPath', () => {
  test('拼出 limit 与可选 cursor', () => {
    expect(myDisputesPath()).toBe(`/disputes/mine?limit=${DISPUTE_PAGE_LIMIT}`)
    expect(myDisputesPath('cur-1')).toBe(`/disputes/mine?limit=${DISPUTE_PAGE_LIMIT}&cursor=cur-1`)
  })
})

describe('startDispute', () => {
  test('POST /disputes，201 与 200（已有未决争议）都解析成功', async () => {
    const calls = mockFetchCalls(() =>
      Response.json({ dispute: DISPUTE_DETAIL, created: true }, { status: 201 }),
    )
    const created = await startDispute({ transactionId: TRANSACTION_ID, type: 'ITEM_MISMATCH' })
    expect(created.created).toBe(true)
    expect(created.dispute.id).toBe(DISPUTE_ID)
    expect(calls).toEqual([
      {
        url: '/api/disputes',
        method: 'POST',
        body: { transactionId: TRANSACTION_ID, type: 'ITEM_MISMATCH' },
      },
    ])

    mockFetchCalls(() =>
      Response.json({ dispute: DISPUTE_DETAIL, created: false }, { status: 200 }),
    )
    const reused = await startDispute({ transactionId: TRANSACTION_ID, type: 'ITEM_MISMATCH' })
    expect(reused.created).toBe(false)
  })
})

describe('fetchMyDisputes / fetchDispute', () => {
  test('列表走 /disputes/mine 且透传 cursor，解析分页信封', async () => {
    const calls = mockFetchCalls(() =>
      Response.json({ items: [DISPUTE_DETAIL], nextCursor: 'next-1' }),
    )
    const page = await fetchMyDisputes('cur-1')
    expect(page.nextCursor).toBe('next-1')
    expect(page.items[0]?.id).toBe(DISPUTE_ID)
    expect(calls[0]?.url).toBe(`/api/disputes/mine?limit=${DISPUTE_PAGE_LIMIT}&cursor=cur-1`)
  })

  test('详情走 /disputes/:id，服务端 404 错误码原样抛出', async () => {
    const calls = mockFetchCalls(() => Response.json(DISPUTE_DETAIL))
    const detail = await fetchDispute(DISPUTE_ID)
    expect(detail.id).toBe(DISPUTE_ID)
    expect(calls[0]?.url).toBe(`/api/disputes/${DISPUTE_ID}`)

    mockFetchCalls(() =>
      Response.json(
        { error: { code: 'DISPUTE_NOT_FOUND', message: '争议不存在或你无权查看' } },
        { status: 404 },
      ),
    )
    const error = await fetchDispute(DISPUTE_ID).catch((reason: unknown) => reason)
    expect(error instanceof ApiError).toBe(true)
    expect(error instanceof ApiError ? error.code : null).toBe('DISPUTE_NOT_FOUND')
    expect(error instanceof ApiError ? error.status : null).toBe(404)
  })
})

describe('withdrawDispute', () => {
  test('POST /disputes/:id/withdraw 并解析撤回后的详情', async () => {
    const withdrawn = {
      ...DISPUTE_DETAIL,
      status: 'WITHDRAWN' as const,
      withdrawnAt: '2026-10-03T00:00:00.000Z',
    }
    const calls = mockFetchCalls(() => Response.json(withdrawn))
    const detail = await withdrawDispute(DISPUTE_ID)
    expect(detail.status).toBe('WITHDRAWN')
    expect(detail.withdrawnAt).toBe('2026-10-03T00:00:00.000Z')
    expect(calls).toEqual([
      { url: `/api/disputes/${DISPUTE_ID}/withdraw`, method: 'POST', body: null },
    ])
  })
})

describe('addDisputeEvidence', () => {
  test('POST evidence-messages，body 只带 messageId', async () => {
    const evidence = {
      evidence: {
        message: {
          id: MESSAGE_ID,
          type: 'TEXT' as const,
          senderId: BUYER_ID,
          senderNickname: '阿岚',
          content: '这个位置有划痕',
          recalledAt: null,
          createdAt: '2026-10-01T08:00:00.000Z',
        },
        addedBy: buyer,
        createdAt: '2026-10-02T00:00:00.000Z',
      },
      created: true,
    }
    const calls = mockFetchCalls(() => Response.json(evidence))
    const result = await addDisputeEvidence(DISPUTE_ID, MESSAGE_ID)
    expect(result.created).toBe(true)
    expect(calls[0]?.url).toBe(`/api/disputes/${DISPUTE_ID}/evidence-messages`)
    expect(calls[0]?.body).toEqual({ messageId: MESSAGE_ID })
  })
})

describe('uploadDisputeAttachment', () => {
  const attachment = {
    id: 'med_01jc000000e00800000000000d',
    url: 'https://media.example/dispute.png',
    mimeType: 'image/png' as const,
    sizeBytes: 3,
    width: 1,
    height: 1,
    uploadedBy: buyer,
    createdAt: '2026-10-02T00:00:00.000Z',
  }

  test('presign → PUT 对象存储 → confirm，三步用同一 objectKey', async () => {
    const calls = mockFetchCalls((call, index) => {
      if (index === 0) {
        return Response.json({
          uploadUrl: 'https://storage.example/dispute-media/key.png',
          objectKey: 'dispute-media/dsp/key.png',
          headers: { 'x-storage-token': 'token-1' },
          expiresAt: '2026-10-02T00:10:00.000Z',
        })
      }
      if (index === 1) return new Response(null, { status: 200 })
      expect(call.body).toEqual({ objectKey: 'dispute-media/dsp/key.png' })
      return Response.json({ attachment, created: true }, { status: 201 })
    })

    const file = new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })
    await uploadDisputeAttachment(DISPUTE_ID, file)

    expect(calls.map((call) => [call.url, call.method])).toEqual([
      [`/api/disputes/${DISPUTE_ID}/attachments/presign`, 'POST'],
      ['https://storage.example/dispute-media/key.png', 'PUT'],
      [`/api/disputes/${DISPUTE_ID}/attachments`, 'POST'],
    ])
    expect(calls[0]?.body).toEqual({ contentType: 'image/png', sizeBytes: 3 })
    // PUT 必须带**所选文件本身**的字节与类型，而不是空 body / JSON。
    const putBody = calls[1]?.body
    expect(putBody).toBeInstanceOf(File)
    const putFile = putBody as File
    expect(putFile.type).toBe('image/png')
    expect(new Uint8Array(await putFile.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('PUT 失败给出可读错误且不再 confirm（服务端无台账行）', async () => {
    const calls = mockFetchCalls((_call, index) => {
      if (index === 0) {
        return Response.json({
          uploadUrl: 'https://storage.example/dispute-media/key.png',
          objectKey: 'dispute-media/dsp/key.png',
          headers: {},
          expiresAt: '2026-10-02T00:10:00.000Z',
        })
      }
      return new Response('upload failed', { status: 500 })
    })

    const file = new File([new Uint8Array([1])], 'proof.png', { type: 'image/png' })
    const error = await uploadDisputeAttachment(DISPUTE_ID, file).catch((reason: unknown) => reason)
    expect(error instanceof Error ? error.message : null).toBe('图片上传失败，请重试')
    expect(calls).toHaveLength(2)
  })

  test('HEIC 转换失败给可区分文案，且不发任何请求', async () => {
    const calls = mockFetchCalls(() => Response.json({}))
    const file = new File([new Uint8Array([1])], 'IMG_0001.HEIC', { type: 'image/heic' })
    const error = await uploadDisputeAttachment(DISPUTE_ID, file).catch((reason: unknown) => reason)
    expect(error instanceof Error ? error.message : null).toBe(
      'HEIC 图片转换失败，请改用 JPG / PNG / WebP',
    )
    expect(calls).toHaveLength(0)
  })

  test('空 MIME 的合法图片按扩展名归一化后仍能上传', async () => {
    const calls = mockFetchCalls((_call, index) => {
      if (index === 0) {
        return Response.json({
          uploadUrl: 'https://storage.example/dispute-media/key.png',
          objectKey: 'dispute-media/dsp/key.png',
          headers: {},
          expiresAt: '2026-10-02T00:10:00.000Z',
        })
      }
      if (index === 1) return new Response(null, { status: 200 })
      return Response.json({ attachment, created: true }, { status: 201 })
    })

    const file = new File([new Uint8Array([1, 2, 3])], 'proof.jpg', { type: '' })
    await uploadDisputeAttachment(DISPUTE_ID, file)

    expect(calls[0]?.body).toEqual({ contentType: 'image/jpeg', sizeBytes: 3 })
    const normalized = calls[1]?.body
    expect(normalized).toBeInstanceOf(File)
    expect((normalized as File).type).toBe('image/jpeg')
  })

  test('PUT 成功但 confirm 响应丢失：下次上传先幂等确认同一个 objectKey', async () => {
    const RETRY_DISPUTE_ID = 'dsp_01jc000000e00800000000000b'
    const first = mockFetchCalls((_call, index) => {
      if (index === 0) {
        return Response.json({
          uploadUrl: 'https://storage.example/dispute-media/key.png',
          objectKey: 'dispute-media/dsp/key.png',
          headers: {},
          expiresAt: '2026-10-02T00:10:00.000Z',
        })
      }
      if (index === 1) return new Response(null, { status: 200 })
      throw new TypeError('fetch failed')
    })

    const file = new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })
    const lost = await uploadDisputeAttachment(RETRY_DISPUTE_ID, file).catch(
      (reason: unknown) => reason,
    )
    expect(lost instanceof Error).toBe(true)
    expect(first).toHaveLength(3)

    const second = mockFetchCalls((call) => {
      expect(call.body).toEqual({ objectKey: 'dispute-media/dsp/key.png' })
      return Response.json({ attachment, created: false })
    })
    await uploadDisputeAttachment(RETRY_DISPUTE_ID, file)

    expect(second.map((call) => [call.url, call.method])).toEqual([
      [`/api/disputes/${RETRY_DISPUTE_ID}/attachments`, 'POST'],
    ])
  })

  test('暂存键被服务端判定不可用时丢弃并重新走 presign', async () => {
    const STALE_DISPUTE_ID = 'dsp_01jc000000e00800000000000c'
    mockFetchCalls((_call, index) => {
      if (index === 0) {
        return Response.json({
          uploadUrl: 'https://storage.example/dispute-media/key.png',
          objectKey: 'dispute-media/dsp/key.png',
          headers: {},
          expiresAt: '2026-10-02T00:10:00.000Z',
        })
      }
      if (index === 1) return new Response(null, { status: 200 })
      throw new TypeError('fetch failed')
    })
    const file = new File([new Uint8Array([1, 2, 3])], 'proof.png', { type: 'image/png' })
    await uploadDisputeAttachment(STALE_DISPUTE_ID, file).catch(() => undefined)

    const calls = mockFetchCalls((_call, index) => {
      if (index === 0) {
        // 上次暂存对象已被服务端删除：confirm 回「对象不可用」，应丢弃后继续上传。
        return Response.json(
          { error: { code: 'DISPUTE_ATTACHMENT_INVALID', message: '附件对象不可用' } },
          { status: 422 },
        )
      }
      if (index === 1) {
        return Response.json({
          uploadUrl: 'https://storage.example/dispute-media/key-2.png',
          objectKey: 'dispute-media/dsp/key-2.png',
          headers: {},
          expiresAt: '2026-10-02T00:10:00.000Z',
        })
      }
      if (index === 2) return new Response(null, { status: 200 })
      return Response.json({ attachment, created: true }, { status: 201 })
    })
    await uploadDisputeAttachment(STALE_DISPUTE_ID, file)

    expect(calls.map((call) => [call.url, call.method])).toEqual([
      [`/api/disputes/${STALE_DISPUTE_ID}/attachments`, 'POST'],
      [`/api/disputes/${STALE_DISPUTE_ID}/attachments/presign`, 'POST'],
      ['https://storage.example/dispute-media/key-2.png', 'PUT'],
      [`/api/disputes/${STALE_DISPUTE_ID}/attachments`, 'POST'],
    ])
  })

  test('本地预校验失败时不发任何请求', async () => {
    const calls = mockFetchCalls(() => Response.json({}))
    const file = new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' })
    const error = await uploadDisputeAttachment(DISPUTE_ID, file).catch((reason: unknown) => reason)
    expect(error instanceof Error ? error.message : null).toBe('仅支持 JPG / PNG / WebP 图片')
    expect(calls).toHaveLength(0)
  })
})
