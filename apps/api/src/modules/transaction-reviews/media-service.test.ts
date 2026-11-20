import { describe, expect, test } from 'bun:test'
import type {
  ReviewMediaConfirmResponse,
  ReviewMediaPresignResponse,
} from '@fish/contracts/transaction-reviews/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { ContentModerationProvider } from '../moderation/providers/types'
import type { MediaStorage } from '../uploads/storage'
import {
  createReviewMediaService,
  type ReviewImageModerationConfig,
  ReviewMediaServiceError,
} from './media-service'
import type {
  ReviewModerationInsert,
  ReviewModerationLookupRow,
  ReviewModerationRow,
  ReviewModerationStore,
} from './moderation-store'

const USER = '01930000-0000-7000-8000-00000000000b'
const OTHER = '01930000-0000-7000-8000-00000000000c'
const TXN = '01930000-0000-7000-8000-0000000000a1'
const MEDIA = '01930000-0000-7000-8000-0000000000d1'
const USER_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, USER)
const OTHER_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.user, OTHER)
const MEDIA_PUBLIC = encodePublicId(PUBLIC_ID_PREFIX.media, MEDIA)
const NOW = new Date('2026-11-21T00:00:00.000Z')

/** 1×1 PNG 魔数（只需通过魔数判据；内容合法性由存储层保证）。 */
function pngBytes(size = 64): Uint8Array {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  return bytes
}

const STAGING_KEY = `transaction-review-media/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`
const PUBLIC_KEY = `reviews/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`
const PRIVATE_KEY = `review-moderation-media/${USER_PUBLIC}/${MEDIA_PUBLIC}.png`

function fakeStorage(overrides: Partial<MediaStorage> = {}) {
  const written: { key: string; contentType: string }[] = []
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>([
    [STAGING_KEY, { bytes: pngBytes(), contentType: 'image/png' }],
  ])
  const stat = async (key: string) => {
    const object = objects.get(key)
    return object ? { size: object.bytes.byteLength, contentType: object.contentType } : null
  }
  const writeMediaBytes = async (key: string, bytes: Uint8Array, contentType: string) => {
    objects.set(key, { bytes, contentType })
    written.push({ key, contentType })
  }
  const storage: MediaStorage = {
    presignPut: (input) => ({
      url: `https://upload.example/${input.key}`,
      headers: {},
      expiresAt: '2026-10-06T12:10:00.000Z',
    }),
    stat,
    statStrict: stat,
    readMediaBytes: async (key) => objects.get(key)?.bytes ?? null,
    writeMediaBytes,
    writeMediaBytesIfAbsent: async (key, bytes, contentType) => {
      if (objects.has(key)) return false
      await writeMediaBytes(key, bytes, contentType)
      return true
    },
    delete: async (key) => {
      objects.delete(key)
    },
    publicUrl: (key) => `https://cdn.example/${key}`,
    ...overrides,
  }
  return { storage, objects, written }
}

let sequence = 0
function rowOf(input: ReviewModerationInsert): ReviewModerationRow {
  sequence += 1
  return {
    id: `01930000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    ...input,
    settledDecision: null,
    settledAt: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function lookupOf(row: ReviewModerationRow, finalKey: string): ReviewModerationLookupRow {
  return {
    finalKey,
    userId: row.userId,
    moderationDecision: row.moderationDecision,
    settledDecision: row.settledDecision,
    contentDigest: row.contentDigest,
  }
}

function memoryStore(): ReviewModerationStore & { rows: ReviewModerationRow[] } {
  const rows: ReviewModerationRow[] = []
  return {
    rows,
    async findByStagingKey({ userId, stagingKey }) {
      return rows.findLast((row) => row.userId === userId && row.stagingKey === stagingKey) ?? null
    },
    async findByDigest({ userId, stagingKey, contentDigest }) {
      return (
        rows.find(
          (row) =>
            row.userId === userId &&
            row.stagingKey === stagingKey &&
            row.contentDigest === contentDigest,
        ) ?? null
      )
    },
    async findByFinalKey(finalKey) {
      const row = rows.find((candidate) => candidate.finalKey === finalKey)
      return row && row.finalKey !== null ? lookupOf(row, row.finalKey) : null
    },
    async findByFinalKeys(keys) {
      return rows.flatMap((row) =>
        row.finalKey !== null && keys.includes(row.finalKey) ? [lookupOf(row, row.finalKey)] : [],
      )
    },
    async insert(input) {
      const duplicate = rows.some(
        (row) =>
          row.userId === input.userId &&
          row.stagingKey === input.stagingKey &&
          row.contentDigest === input.contentDigest,
      )
      if (duplicate) return null
      const row = rowOf(input)
      rows.push(row)
      return row
    },
    async listPending() {
      throw new Error('unused in media-service tests')
    },
    async findMediaSnapshot() {
      throw new Error('unused in media-service tests')
    },
    async decide() {
      throw new Error('unused in media-service tests')
    },
  }
}

function moderationOf(
  decision: 'ALLOW' | 'REVIEW' | 'BLOCK',
  options: { transport?: 'local' | 'tencent'; digest?: string | null } = {},
): ReviewImageModerationConfig {
  const transport = options.transport ?? 'local'
  const provider: ContentModerationProvider = {
    transport,
    moderateText: async () => {
      throw new Error('unused in media-service tests')
    },
    async moderateImage({ objectKey }) {
      return {
        provider: transport === 'tencent' ? 'TENCENT_IMS' : 'LOCAL',
        transport,
        dataId: 'test',
        objectKey,
        policyVersion: 'test-policy',
        decision,
        suggestion: decision === 'ALLOW' ? 'Pass' : decision === 'BLOCK' ? 'Block' : 'Review',
        label: null,
        subLabel: null,
        score: null,
        requestId: null,
        maskedTerms: [],
        contentDigest: options.digest ?? null,
        reasonCode: null,
      }
    },
  }
  return { bizType: 'test-biz', createProvider: () => provider }
}

function serviceOf(options: {
  storage: MediaStorage
  store?: ReviewModerationStore
  moderation?: ReviewImageModerationConfig
  limiter?: {
    take(subject: string): { allowed: true } | { allowed: false; retryAfterSeconds: number }
  }
}) {
  return createReviewMediaService({
    gate: {
      transactionGate: async () => ({ id: TXN, status: 'COMPLETED', hasReview: false }),
    },
    storage: options.storage,
    moderationStore: options.store ?? memoryStore(),
    moderation: options.moderation ?? moderationOf('ALLOW'),
    ...(options.limiter ? { limiter: options.limiter } : {}),
  })
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
    const service = createReviewMediaService({
      gate: { transactionGate: async () => null },
      storage: storage.storage,
    })
    const error = await errorOf(
      service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 }),
    )
    expect(error.status).toBe(404)
    expect(error.code).toBe('TRANSACTION_NOT_FOUND')
  })

  test('交易未完成 → 409 TRANSACTION_NOT_COMPLETED', async () => {
    const service = createReviewMediaService({
      gate: {
        transactionGate: async () => ({ id: TXN, status: 'PENDING_MEETUP', hasReview: false }),
      },
      storage: fakeStorage().storage,
    })
    const error = await errorOf(
      service.presign(USER, TXN, { contentType: 'image/png', sizeBytes: 64 }),
    )
    expect(error.status).toBe(409)
    expect(error.code).toBe('TRANSACTION_NOT_COMPLETED')
  })

  test('已评价 → 409 TRANSACTION_REVIEW_EXISTS（评价不可修改，没有补图语义）', async () => {
    const service = createReviewMediaService({
      gate: {
        transactionGate: async () => ({ id: TXN, status: 'COMPLETED', hasReview: true }),
      },
      storage: fakeStorage().storage,
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
    const service = serviceOf({ storage: fakeStorage().storage })
    const response: ReviewMediaPresignResponse = await service.presign(USER, TXN, {
      contentType: 'image/png',
      sizeBytes: 64,
    })
    expect(response.objectKey).toMatch(
      new RegExp(`^transaction-review-media/${USER_PUBLIC}/med_[0-9a-z]+\\.png$`),
    )
    expect(response.uploadUrl).toContain(response.objectKey)
  })
})

describe('review media service: confirm 的审核结论落点', () => {
  test('ALLOW → 公开 final 键，响应带 moderationDecision=ALLOW', async () => {
    const { storage, written } = fakeStorage()
    const service = serviceOf({ storage })
    const response: ReviewMediaConfirmResponse = await service.confirm(USER, TXN, {
      objectKey: STAGING_KEY,
    })
    expect(response.objectKey).toBe(PUBLIC_KEY)
    expect(response.url).toBe(`https://cdn.example/${PUBLIC_KEY}`)
    expect(response.moderationDecision).toBe('ALLOW')
    expect(written).toEqual([{ key: PUBLIC_KEY, contentType: 'image/png' }])
  })

  test('REVIEW → 私有待审键，不产生任何公开 final', async () => {
    const { storage, objects } = fakeStorage()
    const service = serviceOf({ storage, moderation: moderationOf('REVIEW') })
    const response = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    expect(response.objectKey).toBe(PRIVATE_KEY)
    expect(response.moderationDecision).toBe('REVIEW')
    expect(objects.has(PRIVATE_KEY)).toBe(true)
    expect(objects.has(PUBLIC_KEY)).toBe(false)
  })

  test('BLOCK → 422 REVIEW_IMAGE_BLOCKED，无 final 键，staging 被删除，台账记 BLOCK', async () => {
    const { storage, objects } = fakeStorage()
    const store = memoryStore()
    const service = serviceOf({ storage, store, moderation: moderationOf('BLOCK') })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(422)
    expect(error.code).toBe('REVIEW_IMAGE_BLOCKED')
    expect(objects.has(PUBLIC_KEY)).toBe(false)
    expect(objects.has(PRIVATE_KEY)).toBe(false)
    expect(objects.has(STAGING_KEY)).toBe(false)
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]?.moderationDecision).toBe('BLOCK')
    expect(store.rows[0]?.finalKey).toBeNull()
  })

  test('送审的是 confirm 读到的同一份字节（loadImage 回放，不回读 staging）', async () => {
    const { storage } = fakeStorage()
    let seen: Uint8Array | null = null
    const base = moderationOf('ALLOW')
    const service = serviceOf({
      storage,
      moderation: {
        bizType: base.bizType,
        createProvider: (loadImage) => {
          const provider = base.createProvider(loadImage)
          return {
            ...provider,
            async moderateImage(input) {
              const image = await loadImage(input.objectKey)
              seen = image?.bytes ?? null
              return provider.moderateImage(input)
            },
          }
        },
      },
    })
    await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    expect(seen).not.toBeNull()
    expect(Buffer.from(seen ?? []).equals(Buffer.from(pngBytes()))).toBe(true)
  })
})

describe('review media service: 上游失败与摘要校验', () => {
  test('上游异常 → 503 CONTENT_MODERATION_UNAVAILABLE，不写 final', async () => {
    const { storage, objects, written } = fakeStorage()
    const base = moderationOf('ALLOW')
    const service = serviceOf({
      storage,
      moderation: {
        bizType: base.bizType,
        createProvider: () => ({
          transport: 'tencent',
          moderateText: async () => {
            throw new Error('unused')
          },
          async moderateImage() {
            const { ContentModerationError } = await import('../moderation/providers/types')
            throw new ContentModerationError({ reason: 'timeout', provider: 'TENCENT_IMS' })
          },
        }),
      },
    })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(written).toHaveLength(0)
    expect(objects.has(PUBLIC_KEY)).toBe(false)
  })

  test('腾讯 transport 缺少 FileMD5 → 503（不能把 null 当通过），不写 final', async () => {
    const { storage, written } = fakeStorage()
    const service = serviceOf({
      storage,
      moderation: moderationOf('ALLOW', { transport: 'tencent', digest: null }),
    })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(written).toHaveLength(0)
  })

  test('腾讯 FileMD5 与本地字节不一致 → 503，不写 final', async () => {
    const { storage, written } = fakeStorage()
    const service = serviceOf({
      storage,
      moderation: moderationOf('ALLOW', {
        transport: 'tencent',
        digest: '0'.repeat(32),
      }),
    })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(written).toHaveLength(0)
  })

  test('腾讯 FileMD5 与本地一致 → 正常固化', async () => {
    const { storage, written } = fakeStorage()
    const digest = new Bun.CryptoHasher('md5').update(pngBytes()).digest('hex')
    const service = serviceOf({
      storage,
      moderation: moderationOf('ALLOW', { transport: 'tencent', digest }),
    })
    const response = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    expect(response.moderationDecision).toBe('ALLOW')
    expect(written).toHaveLength(1)
  })
})

describe('review media service: 幂等与防替换', () => {
  test('重复 confirm 不重跑 IMS、不重写对象', async () => {
    const { storage, written } = fakeStorage()
    let calls = 0
    const base = moderationOf('ALLOW')
    const service = serviceOf({
      storage,
      moderation: {
        bizType: base.bizType,
        createProvider: (loadImage) => {
          const provider = base.createProvider(loadImage)
          return {
            ...provider,
            async moderateImage(input) {
              calls += 1
              return provider.moderateImage(input)
            },
          }
        },
      },
    })
    const first = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    const second = await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    expect(second).toEqual(first)
    expect(calls).toBe(1)
    expect(written).toHaveLength(1)
  })

  test('final 已存在但字节不同（staging 被替换）→ 422 REVIEW_IMAGE_INVALID，不覆盖', async () => {
    const { storage, objects, written } = fakeStorage()
    const service = serviceOf({ storage })
    await service.confirm(USER, TXN, { objectKey: STAGING_KEY })
    // 模拟同一 staging 键在 confirm 后被替换成另一份同大小 PNG。
    const replaced = pngBytes()
    replaced[20] = 0x42
    objects.set(STAGING_KEY, { bytes: replaced, contentType: 'image/png' })
    const error = await errorOf(service.confirm(USER, TXN, { objectKey: STAGING_KEY }))
    expect(error.status).toBe(422)
    expect(error.code).toBe('REVIEW_IMAGE_INVALID')
    expect(written).toHaveLength(1)
  })

  test('并发 confirm 同一 staging 键时 final 只固化一次', async () => {
    const { storage, written } = fakeStorage()
    const service = serviceOf({ storage })
    await Promise.all([
      service.confirm(USER, TXN, { objectKey: STAGING_KEY }),
      service.confirm(USER, TXN, { objectKey: STAGING_KEY }),
    ])
    expect(written).toHaveLength(1)
  })
})

describe('review media service: 输入校验与存储故障', () => {
  test('statStrict 抛运行错误 → 503 REVIEW_MEDIA_UNAVAILABLE', async () => {
    const { storage } = fakeStorage({
      statStrict: async () => {
        throw new Error('minio down')
      },
    })
    const error = await errorOf(
      serviceOf({ storage }).confirm(USER, TXN, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('stat 成功但 readMediaBytes 返回 null → 503', async () => {
    const { storage } = fakeStorage({ readMediaBytes: async () => null })
    const error = await errorOf(
      serviceOf({ storage }).confirm(USER, TXN, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('writeMediaBytesIfAbsent 抛错 → 503', async () => {
    const { storage } = fakeStorage({
      writeMediaBytesIfAbsent: async () => {
        throw new Error('disk full')
      },
    })
    const error = await errorOf(
      serviceOf({ storage }).confirm(USER, TXN, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('存储缺 statStrict/readMediaBytes/writeMediaBytesIfAbsent → 503，不静默降级', async () => {
    const noCapabilities: MediaStorage = {
      presignPut: () => ({
        url: 'https://upload.example/put',
        headers: {},
        expiresAt: '2026-10-06T12:10:00.000Z',
      }),
      stat: async () => ({ size: 64, contentType: 'image/png' }),
      publicUrl: (key) => `https://cdn.example/${key}`,
    }
    const error = await errorOf(
      serviceOf({ storage: noCapabilities }).confirm(USER, TXN, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('REVIEW_MEDIA_UNAVAILABLE')
  })

  test('不可引用的键全部 422 REVIEW_IMAGE_INVALID（同码不区分）', async () => {
    const service = serviceOf({ storage: fakeStorage().storage })
    const bad = [
      `transaction-review-media/${OTHER_PUBLIC}/${MEDIA_PUBLIC}.png`,
      `listings/${OTHER_PUBLIC}/${MEDIA_PUBLIC}.jpg`,
      `chat-media/cnv_01jc000000e008000000000021/${USER_PUBLIC}/${MEDIA_PUBLIC}.webp`,
      PUBLIC_KEY,
      `transaction-review-media/${USER_PUBLIC}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000e1')}.png`,
      `transaction-review-media/${USER_PUBLIC}/../${OTHER_PUBLIC}/${MEDIA_PUBLIC}.png`,
    ]
    for (const objectKey of bad) {
      const error = await errorOf(service.confirm(USER, TXN, { objectKey }))
      expect(error.status).toBe(422)
      expect(error.code).toBe('REVIEW_IMAGE_INVALID')
    }
  })

  test('大小超限 / MIME 不在白名单 / 魔数与声明不符 / 长度不一致 → 422', async () => {
    const cases: MediaStorage[] = [
      fakeStorage({
        statStrict: async () => ({ size: 5 * 1024 * 1024 + 1, contentType: 'image/png' }),
        stat: async () => ({ size: 5 * 1024 * 1024 + 1, contentType: 'image/png' }),
      }).storage,
      fakeStorage({
        statStrict: async () => ({ size: 64, contentType: 'image/gif' }),
        stat: async () => ({ size: 64, contentType: 'image/gif' }),
      }).storage,
      fakeStorage({
        readMediaBytes: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      }).storage,
      fakeStorage({ readMediaBytes: async () => pngBytes(32) }).storage,
    ]
    for (const storage of cases) {
      const error = await errorOf(
        serviceOf({ storage }).confirm(USER, TXN, { objectKey: STAGING_KEY }),
      )
      expect(error.status).toBe(422)
      expect(error.code).toBe('REVIEW_IMAGE_INVALID')
    }
  })
})

describe('review media service: 频控', () => {
  test('按用户令牌桶限速：桶空后 presign/confirm 都 429 且带 retryAfterSeconds', async () => {
    let allowed = true
    const limiter = {
      take: () =>
        allowed
          ? ({ allowed: true } as const)
          : ({ allowed: false, retryAfterSeconds: 7 } as const),
    }
    const service = serviceOf({ storage: fakeStorage().storage, limiter })
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
