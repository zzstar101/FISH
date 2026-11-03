import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { DisputeDetail } from '@fish/contracts/disputes/schema'
import { ApiError } from '../../lib/api-client'
import {
  addDisputeEvidence,
  DISPUTE_PAGE_LIMIT,
  fetchDispute,
  fetchDisputeConversation,
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
    installSessionStorage()
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
    uninstallSessionStorage()
  })

  test('暂存键被服务端判定不可用时丢弃并重新走 presign', async () => {
    installSessionStorage()
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
    uninstallSessionStorage()
  })

  test('本地预校验失败时不发任何请求', async () => {
    const calls = mockFetchCalls(() => Response.json({}))
    const file = new File([new Uint8Array([1])], 'notes.txt', { type: 'text/plain' })
    const error = await uploadDisputeAttachment(DISPUTE_ID, file).catch((reason: unknown) => reason)
    expect(error instanceof Error ? error.message : null).toBe('仅支持 JPG / PNG / WebP 图片')
    expect(calls).toHaveLength(0)
  })
})

const CONVERSATION_ID = 'cnv_01jc000000e00800000000000d' as const
const MESSAGE_ID_PREFIX = '01jc000000e0080000000000'
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'

/** 生成合法 `msg_` 公开 id（26 位 crockford 后缀，按序号唯一）。 */
function messageId(index: number): string {
  return `msg_${MESSAGE_ID_PREFIX}${ID_ALPHABET[Math.floor(index / 32)]}${ID_ALPHABET[index % 32]}`
}

const TRANSACTION = {
  id: TRANSACTION_ID,
  conversationId: CONVERSATION_ID,
  listingId: LISTING_ID,
  buyerId: BUYER_ID,
  sellerId: SELLER_ID,
  role: 'buyer' as const,
  listing: {
    id: LISTING_ID,
    title: '宿舍护眼台灯',
    priceCents: 2800,
    status: 'ACTIVE' as const,
    coverUrl: null,
  },
  counterpart: { id: SELLER_ID, nickname: '小北', avatarUrl: null },
  amountCents: 2800,
  status: 'PENDING_MEETUP' as const,
  buyerConfirmedAt: null,
  sellerConfirmedAt: null,
  completedAt: null,
  cancelledAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

function chatMessage(id: string) {
  return {
    id,
    conversationId: CONVERSATION_ID,
    senderId: BUYER_ID,
    sender: { id: BUYER_ID, nickname: '阿岚', avatarUrl: null },
    type: 'TEXT' as const,
    content: `消息 ${id.slice(-2)}`,
    listing: null,
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-10-01T08:00:00.000Z',
  }
}

describe('fetchDisputeConversation（证据选择器分页）', () => {
  test('首屏最新一页带 nextCursor，before 透传可翻到更早一页', async () => {
    const latestPage = Array.from({ length: 100 }, (_, index) => chatMessage(messageId(index)))
    const oldestOnLatestPage = latestPage[0]?.id ?? ''
    const calls = mockFetchCalls((call) => {
      if (call.url.startsWith('/api/transactions/')) return Response.json(TRANSACTION)
      if (!call.url.includes('before=')) {
        return Response.json({ items: latestPage, nextCursor: oldestOnLatestPage })
      }
      return Response.json({ items: [chatMessage(messageId(100))], nextCursor: null })
    })

    const latest = await fetchDisputeConversation(TRANSACTION_ID)
    expect(latest?.conversationId).toBe(CONVERSATION_ID)
    expect(latest?.messages).toHaveLength(100)
    expect(latest?.nextCursor).toBe(oldestOnLatestPage)

    const older = await fetchDisputeConversation(TRANSACTION_ID, oldestOnLatestPage)
    expect(older?.messages).toHaveLength(1)
    // null = 已到最早一页：调用方（infinite query）据此停止继续请求。
    expect(older?.nextCursor).toBeNull()

    expect(calls.map((call) => call.url)).toEqual([
      `/api/transactions/${TRANSACTION_ID}`,
      `/api/conversations/${CONVERSATION_ID}/messages?limit=100`,
      `/api/transactions/${TRANSACTION_ID}`,
      `/api/conversations/${CONVERSATION_ID}/messages?limit=100&before=${oldestOnLatestPage}`,
    ])
  })

  test('交易不可见时返回 null 且不再请求会话消息', async () => {
    const calls = mockFetchCalls(() =>
      Response.json(
        { error: { code: 'TRANSACTION_NOT_FOUND', message: '交易不存在' } },
        { status: 404 },
      ),
    )
    const conversation = await fetchDisputeConversation(TRANSACTION_ID)
    expect(conversation).toBeNull()
    expect(calls.map((call) => call.url)).toEqual([`/api/transactions/${TRANSACTION_ID}`])
  })
})

describe('startDispute 错误映射', () => {
  test('窗口关闭 409 与校验失败 422 都原样保留契约错误码', async () => {
    mockFetchCalls(() =>
      Response.json(
        { error: { code: 'DISPUTE_WINDOW_CLOSED', message: '交易结束已超过 30 天' } },
        { status: 409 },
      ),
    )
    const windowClosed = await startDispute({
      transactionId: TRANSACTION_ID,
      type: 'ITEM_MISMATCH',
    }).catch((reason: unknown) => reason)
    expect(windowClosed instanceof ApiError ? windowClosed.code : null).toBe(
      'DISPUTE_WINDOW_CLOSED',
    )
    expect(windowClosed instanceof ApiError ? windowClosed.status : null).toBe(409)

    mockFetchCalls(() =>
      Response.json(
        { error: { code: 'VALIDATION_FAILED', message: '请求体不合法' } },
        { status: 422 },
      ),
    )
    const validation = await startDispute({
      transactionId: TRANSACTION_ID,
      type: 'OTHER',
      detailText: '说明',
    }).catch((reason: unknown) => reason)
    expect(validation instanceof ApiError ? validation.code : null).toBe('VALIDATION_FAILED')
    expect(validation instanceof ApiError ? validation.status : null).toBe(422)
  })
})

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
}

function installSessionStorage(): MemoryStorage {
  const storage = new MemoryStorage()
  ;(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = storage
  return storage
}

function uninstallSessionStorage(): void {
  delete (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage
}

describe('uploadDisputeAttachment 暂存 key 指纹', () => {
  const OLD_KEY = 'dispute-media/dsp-old/proof-a.png'
  const NEW_KEY = 'dispute-media/dsp-new/proof-b.png'

  test('改选不同文件后绝不确认旧 key，而是重新 presign → PUT → confirm', async () => {
    installSessionStorage()
    try {
      const fileA = new File([new Uint8Array([1, 2, 3])], 'proof.png', {
        lastModified: 1,
        type: 'image/png',
      })
      const fileB = new File([new Uint8Array([1, 2, 3, 4])], 'proof.png', {
        lastModified: 2,
        type: 'image/png',
      })
      let objectKeySequence = 0
      const calls = mockFetchCalls((call, index) => {
        if (call.url.endsWith('/attachments/presign')) {
          objectKeySequence += 1
          const objectKey = objectKeySequence === 1 ? OLD_KEY : NEW_KEY
          return Response.json({
            uploadUrl: `https://storage.example/put/${objectKeySequence}`,
            objectKey,
            headers: { 'content-type': 'image/png' },
            expiresAt: '2026-10-02T01:00:00.000Z',
          })
        }
        if (call.method === 'PUT') return new Response(null, { status: 200 })
        // 第一次 confirm 网络失败：旧 key 暂存，等待同一文件重试。
        if (index === 2) throw new TypeError('fetch failed')
        return Response.json(
          {
            attachment: {
              id: 'med_01jc000000e00800000000000d',
              url: 'https://media.example/dispute.png',
              mimeType: 'image/png',
              sizeBytes: 4,
              width: 1,
              height: 1,
              uploadedBy: buyer,
              createdAt: '2026-10-02T00:00:00.000Z',
            },
            created: true,
          },
          { status: 201 },
        )
      })

      await uploadDisputeAttachment(DISPUTE_ID, fileA).catch((reason: unknown) => reason)

      // 用户改选了另一张图（size/lastModified 不同）：旧 key 必须被丢弃。
      await uploadDisputeAttachment(DISPUTE_ID, fileB)

      const confirmKeys = calls
        .filter((call) => call.url.endsWith('/attachments'))
        .map((call) => (call.body as { objectKey?: string }).objectKey)
      expect(confirmKeys).toEqual([OLD_KEY, NEW_KEY])
      // 第二次上传的第一步是 presign，而不是对旧 key 的幂等 confirm。
      expect(calls[3]?.url).toBe(`/api/disputes/${DISPUTE_ID}/attachments/presign`)
      expect(calls.filter((call) => call.url.endsWith('/attachments/presign'))).toHaveLength(2)
    } finally {
      uninstallSessionStorage()
    }
  })
})
