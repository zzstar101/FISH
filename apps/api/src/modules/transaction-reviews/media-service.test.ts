import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { MediaStorage } from '../uploads/storage'
import { createReviewMediaService, ReviewMediaServiceError } from './media-service'

const USER = '01930000-0000-7000-8000-00000000000b'
const OTHER = '01930000-0000-7000-8000-00000000000c'
const TXN = '01930000-0000-7000-8000-0000000000a1'
const MEDIA = '01930000-0000-7000-8000-0000000000d1'
const USER_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, USER)
const OTHER_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, OTHER)
const MEDIA_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA)

/** 1×1 PNG 魔数（只需通过魔数判据；内容合法性由存储层保证）。 */
function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

const STAGING_KEY = `transaction-review-media/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`

function fakeStorage(overrides: Partial<MediaStorage> = {}): MediaStorage & {
  written: { key: string; contentType: string }[]
} {
  const written: { key: string; contentType: string }[] = []
  // 缺省 statStrict 与 stat 同实现（假适配器不模拟「运行错误」差异，需要时显式 override）。
  const stat =
    overrides.stat ??
    (async (key: string) => (key === STAGING_KEY ? { size: 64, contentType: 'image/png' } : null))
  const statStrict =
    overrides.statStrict ??
    (async (key: string) => {
      // 模拟真实对象存储：final 键只有被写过才存在——幂等判据靠它生效。
      if (written.some((entry) => entry.key === key)) return { size: 64, contentType: 'image/png' }
      return stat(key)
    })
  const writeMediaBytes =
    overrides.writeMediaBytes ??
    (async (key: string, _bytes: Uint8Array, contentType: string) => {
      written.push({ key, contentType })
    })
  return {
    written,
    presignPut: (input) => ({
      url: `https://upload.example/${input.key}`,
      headers: {},
      expiresAt: '2026-10-06T12:10:00.000Z',
    }),
    stat,
    statStrict,
    readMediaBytes: async (key) => (key === STAGING_KEY ? pngBytes() : null),
    writeMediaBytes,
    writeMediaBytesIfAbsent: async (key, bytes, contentType) => {
      if (written.some((entry) => entry.key === key)) return false
      await writeMediaBytes(key, bytes, contentType)
      return true
    },
    publicUrl: (key) => `https://cdn.example/${key}`,
    ...overrides,
  }
}

function gateOf(overrides: Partial<{ status: string; hasReview: boolean }> | null = {}) {
  return {
    transactionGate: async () =>
      overrides === null ? null : { status: 'COMPLETED', hasReview: false, ...overrides },
  }
}

function errorOf(promise: Promise<unknown>): Promise<ReviewMediaServiceError> {
  return promise.then(
    () => {
      throw new Error('预期抛 ReviewMediaServiceError，实际成功返回')
    },
    (error) => {
      if (!(error instanceof ReviewMediaServiceError)) throw error
      return error
    },
  )
}

describe('review media service: 授权门（与评价边 POST 一致）', () => {
  test('非参与者/交易不存在 → 404 TRANSACTION_NOT_FOUND，且不打 storage', async () => {
    const storage = fakeStorage({
      presignPut: () => {
        throw new Error('不应调用 presignPut')
      },
    })
    const service = createReviewMediaService({ gate: gateOf(null), storage })
    const error = await errorOf(
      service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 }),
    )
    expect(error.status).toBe(404)
    expect(error.code).toBe('TRANSACTION_NOT_FOUND')
  })

  test('交易未完成 → 409 TRANSACTION_NOT_COMPLETED', async () => {
    const service = createReviewMediaService({
      gate: gateOf({ status: 'PENDING_MEETUP' }),
      storage: fakeStorage(),
    })
    const error = await errorOf(
      service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('TRANSACTION_NOT_COMPLETED')
  })

  test('已评价 → 409 TRANSACTION_REVIEW_EXISTS（评价不可修改，没有补图语义）', async () => {
    const service = createReviewMediaService({
      gate: gateOf({ hasReview: true }),
      storage: fakeStorage(),
    })
    for (const action of [
      service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 }),
      service.confirm(USER, TXN, { objectKey: STAGING_KEY }),
    ]) {
      const error = await errorOf(action)
      expect(error.status).toBe(409)
      expect(error.code).toBe('TRANSACTION_REVIEW_EXISTS')
    }
  })
})

describe('review media service: presign', () => {
  test('键是服务端生成的 staging 前缀（带本人 usr_ 段与 med_ 段，扩展名随 contentType）', async () => {
    const service = createReviewMediaService({ gate: gateOf(), storage: fakeStorage() })
    const response = await service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 })
    expect(response.objectKey).toMatch(
      new RegExp(`^transaction-review-media/${USER_PUBLIC}/med_[0-9a-z]+\\.png$`),
    )
    expect(response.uploadUrl).toContain(response.objectKey)
  })
})

describe('review media service: confirm', () => {
  test('合法 staging 键 → 写公开 final 键（同一 media id）并回可读 URL', async () => {
    const storage = fakeStorage()
    const service = createReviewMediaService({ gate: gateOf(), storage })
    const response = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    expect(response.objectKey).toBe(`reviews/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`)
    expect(response.url).toBe(`https://cdn.example/reviews/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`)
    expect(storage.written).toEqual([
      { key: `reviews/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`, contentType: 'image/png' },
    ])
  })

  test('confirm 幂等且不覆盖：final 已存在时直接成功返回，不再写对象（#483 审查响应）', async () => {
    const storage = fakeStorage()
    const service = createReviewMediaService({ gate: gateOf(), storage })
    const first = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    const second = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    expect(second.objectKey).toBe(first.objectKey)
    // 修复前：第二次 confirm 会把 staging 字节重写到同一个 final 键（written 长度 2）。
    expect(storage.written).toHaveLength(1)
  })

  test('并发 confirm 同一 staging 键时 final 只固化一次', async () => {
    let finalStatCalls = 0
    let releaseFinalStats: (() => void) | undefined
    const finalStatsGate = new Promise<void>((resolve) => {
      releaseFinalStats = resolve
    })
    const storage = fakeStorage({
      statStrict: async (key) => {
        if (key.startsWith('reviews/')) {
          finalStatCalls += 1
          if (finalStatCalls === 2) releaseFinalStats?.()
          await finalStatsGate
          return null
        }
        return { size: 64, contentType: 'image/png' }
      },
      writeMediaBytesIfAbsent: async (key, _bytes, contentType) => {
        if (storage.written.some((entry) => entry.key === key)) return false
        storage.written.push({ key, contentType })
        return true
      },
    })
    const service = createReviewMediaService({ gate: gateOf(), storage })
    await Promise.all([
      service.confirm(USER, TXN, { objectKey: STAGING_KEY }),
      service.confirm(USER, TXN, { objectKey: STAGING_KEY }),
    ])
    expect(storage.written).toHaveLength(1)
  })

  test('同一 staging 键换一笔交易再 confirm：已提交评价引用的 final 图不被改写（#483 审查响应）', async () => {
    const OTHER_TXN = '01930000-0000-7000-8000-0000000000a2'
    const storage = fakeStorage()
    const service = createReviewMediaService({ gate: gateOf(), storage })
    const first = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    const second = await service.confirm(USER, OTHER_TXN, { objectKey: STAGING_KEY })
    expect(second.objectKey).toBe(first.objectKey)
    expect(storage.written).toHaveLength(1)
  })

  test('statStrict 抛运行错误 → 503 REVIEW_MEDIA_UNAVAILABLE（不伪装成 422 图片无效）', async () => {
    const service = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({
        statStrict: async () => {
          throw new Error('minio down')
        },
      }),
    })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('stat 成功后 readMediaBytes 返回 null → 503（确认中途对象消失是故障，不是图片无效）', async () => {
    const service = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({ readMediaBytes: async () => null }),
    })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('writeMediaBytesIfAbsent 抛错 → 503（固化失败可重试，不回 500 裸错）', async () => {
    const service = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({
        writeMediaBytesIfAbsent: async () => {
          throw new Error('disk full')
        },
      }),
    })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('不可引用的键全部 422 REVIEW_IMAGE_INVALID（同码不区分）', async () => {
    const service = createReviewMediaService({ gate: gateOf(), storage: fakeStorage() })
    const bad = [
      // 跨用户 staging 键
      `transaction-review-media/${OTHER_PUBLIC}/${MEDIA_PUBLIC}.png`,
      // 他人 listing 公开键与 seed 键
      `listings/${OTHER_PUBLIC}/${MEDIA_PUBLIC}.jpg`,
      // chat-media 键
      `chat-media/cnv_01jc000000e008000000000021/${USER_PUBLIC}/${MEDIA_PUBLIC}.webp`,
      // 已经是 final 的 reviews 键（不是 staging，不能二次入链）
      `reviews/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`,
      // 形状合法但对象不存在（stat null）
      `transaction-review-media/${USER_PUBLIC}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000e1')}.png`,
      // 路径穿越
      `transaction-review-media/${USER_PUBLIC}/../${OTHER_PUBLIC}/${MEDIA_PUBLIC}.png`,
    ]
    for (const objectKey of bad) {
      const error = await errorOf(service.confirm(USER, TXN, { objectKey }))
      expect(error.status).toBe(422)
      expect(error.code).toBe('REVIEW_IMAGE_INVALID')
    }
  })

  test('大小超限 / MIME 不在白名单 / 魔数与声明不符 → 422', async () => {
    // override 一律按键判别：final 键必须返回 null，否则会命中「final 已存在→幂等成功」提前返回。
    const oversize = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({
        stat: async (key) =>
          key === STAGING_KEY ? { size: 5 * 1024 * 1024 + 1, contentType: 'image/png' } : null,
      }),
    })
    expect((await errorOf(oversize.confirm(USER, TXN, { objectKey: STAGING_KEY }))).code).toBe(
      'REVIEW_IMAGE_INVALID',
    )

    const badMime = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({
        stat: async (key) => (key === STAGING_KEY ? { size: 64, contentType: 'image/gif' } : null),
      }),
    })
    expect((await errorOf(badMime.confirm(USER, TXN, { objectKey: STAGING_KEY }))).code).toBe(
      'REVIEW_IMAGE_INVALID',
    )

    // 声明 png，字节是 JPEG 魔数：内容判据必须拦住。
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const mismatch = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({
        readMediaBytes: async () => jpegBytes,
        stat: async (key) =>
          key === STAGING_KEY ? { size: jpegBytes.byteLength, contentType: 'image/png' } : null,
      }),
    })
    expect((await errorOf(mismatch.confirm(USER, TXN, { objectKey: STAGING_KEY }))).code).toBe(
      'REVIEW_IMAGE_INVALID',
    )
  })

  test('字节长度与 stat 不一致 → 422（读取截断/被替换）', async () => {
    const service = createReviewMediaService({
      gate: gateOf(),
      storage: fakeStorage({ readMediaBytes: async () => pngBytes(32) }),
    })
    expect((await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))).code).toBe(
      'REVIEW_IMAGE_INVALID',
    )
  })
})

describe('review media service: 装配与频控（审查采纳）', () => {
  test('存储缺 statStrict/readMediaBytes/writeMediaBytesIfAbsent → 503 REVIEW_MEDIA_UNAVAILABLE（不静默降级成 422/假成功）', async () => {
    const noCapabilities: MediaStorage = {
      presignPut: () => ({
        url: 'https://upload.example/put',
        headers: {},
        expiresAt: '2026-10-06T12:10:00.000Z',
      }),
      stat: async () => ({ size: 64, contentType: 'image/png' }),
      publicUrl: (key) => `https://cdn.example/${key}`,
    }
    const service = createReviewMediaService({ gate: gateOf(), storage: noCapabilities })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('按用户令牌桶限速：桶空后 presign/confirm 都 429 且带 retryAfterSeconds', async () => {
    let allowed = true
    const limiter = {
      take: () =>
        allowed
          ? ({ allowed: true } as const)
          : ({ allowed: false, retryAfterSeconds: 7 } as const),
    }
    const service = createReviewMediaService({ gate: gateOf(), storage: fakeStorage(), limiter })
    expect(
      (await service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 })).objectKey,
    ).toBeDefined()

    allowed = false
    const presignError = await errorOf(
      service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 }),
    )
    expect(presignError.status).toBe(429)
    expect(presignError.code).toBe('REVIEW_MEDIA_RATE_LIMITED')
    expect(presignError.retryAfterSeconds).toBe(7)

    const confirmError = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(confirmError.status).toBe(429)
    expect(confirmError.retryAfterSeconds).toBe(7)
  })
})
