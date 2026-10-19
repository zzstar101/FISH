import { beforeEach, expect, mock, test } from 'bun:test'
import type { DisputeAttachment } from '@fish/contracts/disputes/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { UploadAbortedError } from '../src/features/upload/active'

/**
 * 争议附件上传链（#497）：PUT 成功后的 confirm 失败不能把 `objectKey` 丢掉。
 *
 * 这条链的典型坑都在 await 之间：confirm 网络抖动（重试要续同一个对象，别再花一次
 * presign 配额）、confirm 明确失效（同一个 key 再试也没用，必须清缓存重传）、
 * 以及 PUT 完成那一刻换号（不能拿新账号的会话去 confirm 上一个账号的争议）。
 * 这些都不会在 typecheck 里响，所以把 api / Taro / 文件读取换成记录器逐条钉住。
 */

class ApiError extends Error {
  override name = 'ApiError'
  code: string
  status: number

  constructor(code: string, status: number) {
    super(code)
    this.code = code
    this.status = status
  }
}

const attachment: DisputeAttachment = {
  id: encodePublicId(PUBLIC_ID_PREFIX.media, '0199a000-0000-7000-8000-000000000001'),
  url: 'https://media.example.com/uploads/dispute-media/token',
  mimeType: 'image/jpeg',
  sizeBytes: 120_000,
  width: 1200,
  height: 900,
  uploadedBy: {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, '0199a000-0000-7000-8000-000000000002'),
    nickname: '买家小周',
  },
  createdAt: '2026-10-20T03:00:00.000Z',
}

const photo = { path: '/tmp/x.jpg', mime: 'image/jpeg' as const, sizeBytes: 120_000 }
const OBJECT_KEY = 'dispute-media/2026/10/abc.jpg'
/** 每次 presign 换一个 key：好区分「续用了上一张图的 key」与「重新 presign 了」 */
const presignKey = (seq: number) => `${OBJECT_KEY}-${seq}`
let presignSeq = 0

type Call = { kind: 'presign' | 'put' | 'confirm'; key?: string }
const calls: Call[] = []
let putStatus = 200
let confirmImpl: (objectKey: string) => Promise<{ attachment: DisputeAttachment }>
/** 当前登录用户：`PUT` 完成后由 `afterPutUser` 模拟「这一刻换号」 */
let currentUser: string | null = 'usr_a'
let afterPutUser: string | null = 'usr_a'

mock.module('@tarojs/taro', () => ({
  default: {
    request: async () => {
      calls.push({ kind: 'put' })
      currentUser = afterPutUser
      return { statusCode: putStatus }
    },
  },
}))

mock.module('@/features/upload/api', () => ({
  readFileBuffer: async () => new ArrayBuffer(8),
  UPLOAD_TIMEOUT_MS: 1_000,
}))

mock.module('@/lib/request', () => ({
  isApiError: (error: unknown) => error instanceof ApiError,
}))

mock.module('../src/features/disputes/api', () => ({
  presignDisputeAttachment: async () => {
    presignSeq += 1
    calls.push({ kind: 'presign' })
    return {
      uploadUrl: 'https://media.example.com/put',
      objectKey: presignKey(presignSeq),
      headers: {},
      expiresAt: '2026-10-20T03:15:00.000Z',
    }
  },
  confirmDisputeAttachment: async (_disputeId: string, objectKey: string) => {
    calls.push({ kind: 'confirm', key: objectKey })
    return confirmImpl(objectKey)
  },
}))

const { uploadDisputeAttachment } = await import('@/features/disputes/upload')

const presignCount = () => calls.filter((call) => call.kind === 'presign').length
const confirmKeys = () => calls.filter((call) => call.kind === 'confirm').map((call) => call.key)

beforeEach(() => {
  calls.length = 0
  putStatus = 200
  confirmImpl = async () => ({ attachment })
  currentUser = 'usr_a'
  afterPutUser = 'usr_a'
  presignSeq = 0
})

test('PUT 成功后 confirm 网络失败：保留 key，重试直接用同一 key 续 confirm（不重复 presign/PUT）', async () => {
  let attempts = 0
  confirmImpl = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('request:fail')
    return { attachment }
  }

  await expect(uploadDisputeAttachment('dsp_retry', photo)).rejects.toThrow('request:fail')
  expect(presignCount()).toBe(1)
  expect(calls.filter((call) => call.kind === 'put').length).toBe(1)
  // 第一次 confirm 失败后缓存还在（网络错≠明确失效）
  expect(confirmKeys()).toEqual([presignKey(1)])

  const second = await uploadDisputeAttachment('dsp_retry', photo)
  expect(second.id).toBe(attachment.id)
  // 第二次没有再 presign / PUT：同一个对象续 confirm 成功（服务端幂等）
  expect(presignCount()).toBe(1)
  expect(calls.filter((call) => call.kind === 'put').length).toBe(1)
  expect(confirmKeys()).toEqual([presignKey(1), presignKey(1)])
})

test('confirm 明确失效（422）：清缓存，下一次重新走完整链（同一个 key 再试也没用）', async () => {
  let attempts = 0
  confirmImpl = async () => {
    attempts += 1
    if (attempts === 1) throw new ApiError('DISPUTE_ATTACHMENT_INVALID', 422)
    return { attachment }
  }

  await expect(uploadDisputeAttachment('dsp_invalid', photo)).rejects.toThrow(
    'DISPUTE_ATTACHMENT_INVALID',
  )
  expect(presignCount()).toBe(1)

  const second = await uploadDisputeAttachment('dsp_invalid', photo)
  expect(second.id).toBe(attachment.id)
  // 缓存已清：重新 presign + PUT，而不是拿废 key 再撞一次
  expect(presignCount()).toBe(2)
  expect(calls.filter((call) => call.kind === 'put').length).toBe(2)
})

test('PUT 之后换号：不发 confirm（不产生台账行），抛 UploadAbortedError', async () => {
  // PUT 完成的瞬间登录用户换了（页面还没来得及卸载）：新会话不能去 confirm 上一个账号的争议
  currentUser = 'usr_a'
  afterPutUser = 'usr_b'
  const context = { currentUserId: () => currentUser }

  await expect(uploadDisputeAttachment('dsp_switch', photo, context)).rejects.toBeInstanceOf(
    UploadAbortedError,
  )
  expect(confirmKeys()).toEqual([])
  expect(presignCount()).toBe(1)

  // 缓存不留给下一个账号：换回自己后再传一次，重新走整条链
  currentUser = 'usr_b'
  afterPutUser = 'usr_b'
  const after = await uploadDisputeAttachment('dsp_switch', photo, context)
  expect(after.id).toBe(attachment.id)
  expect(presignCount()).toBe(2)
})

test('PUT 非 2xx：给出可读文案，且不把坏对象记进缓存', async () => {
  putStatus = 500
  await expect(uploadDisputeAttachment('dsp_putfail', photo)).rejects.toThrow(
    '图片上传失败，请重试',
  )
  expect(confirmKeys()).toEqual([])
  expect(presignCount()).toBe(1)
})

test('换另一张图：上一张的 key 直接作废，重新 presign + PUT，不得 confirm 旧 key', async () => {
  // 选图 A → PUT 成功 → confirm 网络失败（缓存留下 A 的 key）
  let attempts = 0
  confirmImpl = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('request:fail')
    return { attachment }
  }
  await expect(uploadDisputeAttachment('dsp_other_photo', photo)).rejects.toThrow('request:fail')
  expect(confirmKeys()).toEqual([presignKey(1)])

  // 用户改选了另一张图（临时路径/大小不同）：旧 key 属于 A，不能拿来 confirm
  const otherPhoto = { ...photo, path: '/tmp/other.jpg', sizeBytes: 240_000 }
  const second = await uploadDisputeAttachment('dsp_other_photo', otherPhoto)
  expect(second.id).toBe(attachment.id)
  expect(presignCount()).toBe(2)
  expect(calls.filter((call) => call.kind === 'put').length).toBe(2)
  // 只有最后一次 confirm，且用的是 B 自己 presign 出来的 key
  expect(confirmKeys()).toEqual([presignKey(1), presignKey(2)])
})
