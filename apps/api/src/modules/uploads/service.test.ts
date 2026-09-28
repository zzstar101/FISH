import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { LoadModerationImage, ModerationImageSource } from '../moderation/providers/tencent'
import {
  ContentModerationError,
  type ContentModerationProvider,
} from '../moderation/providers/types'
import type {
  ListingMediaObjectInsert,
  ListingMediaObjectRow,
  ListingMediaObjectStore,
} from './media-objects'
import { isListingReviewMediaKey, listingReviewMediaPrefix } from './review-media'
import { createUploadService, UploadServiceError } from './service'
import {
  isListingMediaStagingKey,
  isPublicListingKey,
  listingMediaStagingPrefix,
  type MediaStorage,
} from './storage'

const USER_ID = '01930000-0000-7000-8000-00000000000a'
const OTHER_ID = '01930000-0000-7000-8000-00000000000b'
const FINAL_PREFIX = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, USER_ID)}/`
const STAGING_PREFIX = listingMediaStagingPrefix(USER_ID)
const REVIEW_PREFIX = listingReviewMediaPrefix(USER_ID)
const STAGING_KEY = `${STAGING_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c1')}.jpg`
const FINAL_KEY = `${FINAL_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c2')}.jpg`
const ROW_ID = '01930000-0000-7000-8000-0000000000d1'

// 4 字节的假图片：足够算出本地 sha256，也让"字节数与 stat.size 一致"可断言。
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4])
const CONTENT_DIGEST = createHash('sha256').update(IMAGE_BYTES).digest('hex')
const PROVIDER_MD5 = 'a'.repeat(32)

type WrittenObject = { key: string; bytes: Uint8Array; contentType: string }
type FakeStorage = MediaStorage & { writes: WrittenObject[]; reads: number }

function fakeStorage(overrides: Partial<MediaStorage> = {}): FakeStorage {
  const fake: FakeStorage = {
    writes: [],
    reads: 0,
    presignPut: () => ({
      url: 'https://s3.test/put?sig=x',
      headers: {},
      expiresAt: '2026-09-12T03:50:10.000Z',
    }),
    stat: async () => ({ size: IMAGE_BYTES.length, contentType: 'image/jpeg' }),
    publicUrl: (key) => `https://cdn.test/${key}`,
    readMediaBytes: async () => {
      fake.reads += 1
      return IMAGE_BYTES
    },
    writeMediaBytes: async (key, bytes, contentType) => {
      fake.writes.push({ key, bytes, contentType })
    },
    ...overrides,
  }
  return fake
}

function mediaRow(input: ListingMediaObjectInsert): ListingMediaObjectRow {
  return {
    id: ROW_ID,
    createdAt: new Date('2026-09-12T03:40:10.000Z'),
    // #286 复审 blocker 1：人工结算列默认未结算（机器结论生效）。
    settledDecision: null,
    settledAt: null,
    ...input,
  }
}

type FakeMediaObjects = ListingMediaObjectStore & {
  inserted: ListingMediaObjectInsert[]
  asked: { stagingKey: string; contentDigest: string }[]
}

function fakeMediaObjects(overrides: Partial<ListingMediaObjectStore> = {}): FakeMediaObjects {
  const inserted: ListingMediaObjectInsert[] = []
  const asked: { stagingKey: string; contentDigest: string }[] = []
  return {
    inserted,
    asked,
    findByDigest: async (input) => {
      asked.push({ stagingKey: input.stagingKey, contentDigest: input.contentDigest })
      return null
    },
    findConfirmedFinalKey: async () => null,
    findByFinalKey: async () => null,
    insert: async (input) => {
      inserted.push(input)
      return mediaRow(input)
    },
    ...overrides,
  }
}

type ImageVerdict = Awaited<ReturnType<ContentModerationProvider['moderateImage']>>

function verdict(
  input: { dataId: string; objectKey: string },
  overrides: Partial<ImageVerdict> = {},
): ImageVerdict {
  return {
    decision: 'ALLOW',
    suggestion: 'Pass',
    label: 'Normal',
    subLabel: null,
    score: 100,
    requestId: 'req-1',
    provider: 'TENCENT_IMS',
    transport: 'tencent',
    dataId: input.dataId,
    objectKey: input.objectKey,
    policyVersion: 'ims-biz',
    contentDigest: PROVIDER_MD5,
    reasonCode: null,
    ...overrides,
  }
}

/** 本地 transport 的真实形状（`providers/local.ts`）：结论恒为 REVIEW、拿不到摘要。 */
function localVerdict(input: { dataId: string; objectKey: string }): ImageVerdict {
  return verdict(input, {
    decision: 'REVIEW',
    suggestion: 'Review',
    label: null,
    subLabel: null,
    score: null,
    requestId: null,
    provider: 'LOCAL',
    transport: 'local',
    contentDigest: null,
    reasonCode: 'LOCAL_IMAGE_NOT_AUDITED',
  })
}

function buildService(
  options: {
    storage?: FakeStorage
    mediaObjects?: FakeMediaObjects
    moderateImage?: ContentModerationProvider['moderateImage']
  } = {},
) {
  const storage = options.storage ?? fakeStorage()
  const mediaObjects = options.mediaObjects ?? fakeMediaObjects()
  const moderateImage = options.moderateImage ?? (async (input) => verdict(input))
  return {
    storage,
    mediaObjects,
    service: createUploadService({
      storage,
      mediaObjects,
      createModeration: (loadImage: LoadModerationImage): ContentModerationProvider => ({
        transport: 'tencent',
        moderateText: async () => {
          throw new Error('图片链路不应调用 moderateText')
        },
        moderateImage: async (input) => {
          // 真实适配器先经注入的 loader 取字节，再打 IMS；假适配器保留同样的调用顺序。
          await loadImage(input.objectKey)
          return moderateImage(input)
        },
      }),
    }),
  }
}

async function expectUploadError(run: () => Promise<unknown>): Promise<UploadServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof UploadServiceError) return error
    throw error
  }
  throw new Error('期望抛出 UploadServiceError，但没有')
}

describe('presign', () => {
  // #286 步骤 4：presign 永不签 `listings/`。客户端因此结构上无法用 PUT 覆盖一个已经审核过的
  // final 对象，"审核后换内容"这条绕过不再需要靠摘要比对来兜。
  test('signs a staging key and never the final listing prefix', async () => {
    const { service } = buildService()

    const jpeg = await service.presign(USER_ID, { contentType: 'image/jpeg', sizeBytes: 1024 })
    const webp = await service.presign(USER_ID, { contentType: 'image/webp', sizeBytes: 1024 })

    expect(jpeg.objectKey.startsWith(STAGING_PREFIX)).toBe(true)
    expect(isListingMediaStagingKey(jpeg.objectKey)).toBe(true)
    expect(jpeg.objectKey).toMatch(/\/med_[a-z0-9]+\.jpg$/)
    expect(jpeg.objectKey.startsWith('listings/')).toBe(false)
    expect(webp.objectKey.endsWith('.webp')).toBe(true)
    // 每次 presign 都是新对象：重试时前端替换槽位，旧键成为孤儿（契约 §4 取舍 1）
    expect(jpeg.objectKey).not.toBe(webp.objectKey)
    expect(jpeg.uploadUrl).toBe('https://s3.test/put?sig=x')
    expect(jpeg.expiresAt).toBe('2026-09-12T03:50:10.000Z')
  })

  test('passes the requested content type to the storage layer', async () => {
    const asked: string[] = []
    const { service } = buildService({
      storage: fakeStorage({
        presignPut: (input) => {
          asked.push(input.contentType)
          return { url: 'https://s3.test/put', headers: {}, expiresAt: '2026-09-12T03:50:10.000Z' }
        },
      }),
    })

    await service.presign(USER_ID, { contentType: 'image/png', sizeBytes: 1024 })
    expect(asked).toEqual(['image/png'])
  })
})

describe('confirm', () => {
  // 改头像走的是同一条路：客户端先 presign→PUT→confirm 拿到 final 键，再把它交给
  // `PATCH /profile`，服务端仍然调同一个 confirm 校验它（modules/profile/service.ts）。
  // 这里锁住「已确认的 final 键原样接受」，且不重读字节、不重复审核、不重新固化。
  test('accepts an already confirmed final key without reading or re-moderating', async () => {
    let statCalled = false
    let moderated = 0
    const storage = fakeStorage({
      stat: async () => {
        statCalled = true
        return { size: IMAGE_BYTES.length, contentType: 'image/jpeg' }
      },
    })
    const { service } = buildService({
      storage,
      mediaObjects: fakeMediaObjects({
        findConfirmedFinalKey: async (finalKey) =>
          finalKey === FINAL_KEY
            ? { userId: USER_ID, finalKey: FINAL_KEY, moderationDecision: 'ALLOW' }
            : null,
      }),
      moderateImage: async (input) => {
        moderated += 1
        return verdict(input)
      },
    })

    await expect(service.confirm(USER_ID, { objectKey: FINAL_KEY })).resolves.toEqual({
      objectKey: FINAL_KEY,
      url: `https://cdn.test/${FINAL_KEY}`,
      moderationDecision: 'ALLOW',
    })
    expect(statCalled).toBe(false)
    expect(storage.reads).toBe(0)
    expect(storage.writes).toEqual([])
    expect(moderated).toBe(0)
  })

  test('rejects a final key that has no confirmation record', async () => {
    let statCalled = false
    const { service } = buildService({
      storage: fakeStorage({
        stat: async () => {
          statCalled = true
          return { size: IMAGE_BYTES.length, contentType: 'image/jpeg' }
        },
      }),
    })

    const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey: FINAL_KEY }))
    expect(error.status).toBe(422)
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(statCalled).toBe(false)
  })

  test('rejects a final key confirmed for another account', async () => {
    const { service } = buildService({
      mediaObjects: fakeMediaObjects({
        findConfirmedFinalKey: async () => ({
          userId: OTHER_ID,
          finalKey: FINAL_KEY,
          moderationDecision: 'ALLOW',
        }),
      }),
    })

    const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey: FINAL_KEY }))
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
  })

  test('rejects another account final key before it reaches the store', async () => {
    let lookedUp = false
    const { service } = buildService({
      mediaObjects: fakeMediaObjects({
        findConfirmedFinalKey: async () => {
          lookedUp = true
          return null
        },
      }),
    })
    const otherKey = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, OTHER_ID)}/${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c4')}.jpg`

    const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey: otherKey }))
    expect(error.status).toBe(422)
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(lookedUp).toBe(false)
  })

  test('rejects a staging key belonging to another user before touching storage', async () => {
    let statCalled = false
    const { service } = buildService({
      storage: fakeStorage({
        stat: async () => {
          statCalled = true
          return { size: 1, contentType: 'image/jpeg' }
        },
      }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, {
        objectKey: `${listingMediaStagingPrefix(OTHER_ID)}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c3')}.jpg`,
      }),
    )
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(statCalled).toBe(false)
  })

  test('rejects a `..` key that only looks like it belongs to the caller（路径穿越）', async () => {
    let statCalled = false
    const { service } = buildService({
      storage: fakeStorage({
        stat: async () => {
          statCalled = true
          return { size: 1, contentType: 'image/jpeg' }
        },
      }),
    })

    const key = `${STAGING_PREFIX}../${encodePublicId(PUBLIC_ID_PREFIX.user, OTHER_ID)}/x.jpg`
    // 前缀校验单独拦不住：这个键确实以调用方前缀开头，但 Bun.S3Client 拼 URL 时
    // 会把 `..` 归一化掉，实际请求别人的对象（#86 B 线评审 P1）。
    expect(key.startsWith(STAGING_PREFIX)).toBe(true)

    const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey: key }))
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(statCalled).toBe(false)
  })

  test('rejects object keys that carry path syntax（空段 / 反斜杠 / 百分号编码）', async () => {
    // stat 返回一个"看起来存在"的对象：能拿到 IMAGE_REFERENCE_INVALID 而不是
    // UPLOAD_OBJECT_MISSING，说明形状检查先于任何存储访问生效。
    const { service } = buildService()
    const keys = [
      `${STAGING_PREFIX}/x.jpg`,
      `${STAGING_PREFIX}..\\${OTHER_ID}/x.jpg`,
      `${STAGING_PREFIX}..%2f${OTHER_ID}/x.jpg`,
      `${STAGING_PREFIX}./x.jpg`,
      `/${STAGING_PREFIX}x.jpg`,
    ]

    for (const objectKey of keys) {
      const error = await expectUploadError(() => service.confirm(USER_ID, { objectKey }))
      expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    }
  })

  test('rejects a key that was never uploaded', async () => {
    const { service } = buildService({ storage: fakeStorage({ stat: async () => null }) })
    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('UPLOAD_OBJECT_MISSING')
  })

  // presign 的签名只覆盖 host，mime 与大小只能查真实对象（契约 §7.7）。
  test('rejects objects whose real size or mime type is not allowed', async () => {
    const oversize = buildService({
      storage: fakeStorage({
        stat: async () => ({ size: 5 * 1024 * 1024 + 1, contentType: 'image/jpeg' }),
      }),
    })
    expect(
      (await expectUploadError(() => oversize.service.confirm(USER_ID, { objectKey: STAGING_KEY })))
        .code,
    ).toBe('IMAGE_REFERENCE_INVALID')

    const wrongMime = buildService({
      storage: fakeStorage({ stat: async () => ({ size: 10, contentType: 'image/heic' }) }),
    })
    expect(
      (
        await expectUploadError(() =>
          wrongMime.service.confirm(USER_ID, { objectKey: STAGING_KEY }),
        )
      ).code,
    ).toBe('IMAGE_REFERENCE_INVALID')
  })

  test('maps a storage without content read/write to 503', async () => {
    const { service } = buildService({
      storage: fakeStorage({ readMediaBytes: undefined, writeMediaBytes: undefined }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
  })

  test('rejects an object that disappeared between stat and read', async () => {
    const { service, mediaObjects } = buildService({
      storage: fakeStorage({ readMediaBytes: async () => null }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.code).toBe('UPLOAD_OBJECT_MISSING')
    expect(mediaObjects.inserted).toEqual([])
  })

  // 对象在 stat 与读之间被 PUT 覆盖：既不能拿这次的属性去固化另一次的字节，也不能把审核结论
  // 算在没读到的内容上。
  test('rejects an object whose bytes no longer match the metadata', async () => {
    const { service, storage, mediaObjects } = buildService({
      storage: fakeStorage({ readMediaBytes: async () => new Uint8Array([1, 2]) }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(422)
    expect(error.code).toBe('IMAGE_REFERENCE_INVALID')
    expect(error.details).toEqual([
      { field: 'objectKey', message: '图片内容与元数据不一致，请重新上传' },
    ])
    expect(storage.writes).toEqual([])
    expect(mediaObjects.inserted).toEqual([])
  })

  test('reads the object once and moderates exactly those bytes', async () => {
    const storage = fakeStorage()
    const loaded: (ModerationImageSource | null)[] = []
    const dataIds: string[] = []
    const service = createUploadService({
      storage,
      mediaObjects: fakeMediaObjects(),
      createModeration: (loadImage): ContentModerationProvider => ({
        transport: 'tencent',
        moderateText: async () => {
          throw new Error('图片链路不应调用 moderateText')
        },
        moderateImage: async (input) => {
          dataIds.push(input.dataId)
          loaded.push(await loadImage(input.objectKey))
          // provider 不该自己去读别的对象：loader 只认本次那次读到的键。
          loaded.push(await loadImage(`${STAGING_PREFIX}other.jpg`))
          return verdict(input)
        },
      }),
    })

    const confirmed = await service.confirm(USER_ID, { objectKey: STAGING_KEY })

    expect(storage.reads).toBe(1)
    expect(loaded[0]?.bytes).toBe(IMAGE_BYTES)
    expect(loaded[0]?.contentType).toBe('image/jpeg')
    expect(loaded[1]).toBeNull()
    expect(dataIds).toEqual([CONTENT_DIGEST])
    expect(storage.writes[0]?.bytes).toBe(IMAGE_BYTES)
    expect(confirmed.objectKey.startsWith(FINAL_PREFIX)).toBe(true)
  })

  test('fixates an ALLOW image under a server-generated final key', async () => {
    const { service, storage, mediaObjects } = buildService()

    const confirmed = await service.confirm(USER_ID, { objectKey: STAGING_KEY })

    expect(confirmed.objectKey.startsWith(FINAL_PREFIX)).toBe(true)
    expect(confirmed.objectKey).not.toBe(STAGING_KEY)
    expect(isPublicListingKey(confirmed.objectKey)).toBe(true)
    expect(confirmed.url).toBe(`https://cdn.test/${confirmed.objectKey}`)
    expect(storage.writes).toEqual([
      { key: confirmed.objectKey, bytes: IMAGE_BYTES, contentType: 'image/jpeg' },
    ])
    expect(mediaObjects.inserted[0]).toMatchObject({
      userId: USER_ID,
      stagingKey: STAGING_KEY,
      finalKey: confirmed.objectKey,
      contentDigest: CONTENT_DIGEST,
      providerMd5: PROVIDER_MD5,
      moderationDecision: 'ALLOW',
      provider: 'TENCENT_IMS',
      providerRequestId: 'req-1',
    })
  })

  // 本地 transport 下 IMS 不可用：图片照样能确认，但结论是 REVIEW。**#286 复审 blocker 2** 之后
  // 它固化在私有的 `listing-review-media/`（不在匿名白名单里），商品带着 `REVIEW` 进人工队列。
  // 「没过人工审核的图不能被公开读到」由此是存储策略给的，而不是靠"商品不进公开 Feed"——
  // 上传者拿着直链仍可主动分享，商品可见性管不住对象本身。
  test('fixates a REVIEW image under a private key, never the public prefix', async () => {
    const { service, storage, mediaObjects } = buildService({
      moderateImage: async (i) => localVerdict(i),
    })

    const confirmed = await service.confirm(USER_ID, { objectKey: STAGING_KEY })

    expect(isListingReviewMediaKey(confirmed.objectKey)).toBe(true)
    expect(confirmed.objectKey.startsWith(REVIEW_PREFIX)).toBe(true)
    expect(confirmed.objectKey.startsWith('listings/')).toBe(false)
    expect(confirmed.moderationDecision).toBe('REVIEW')
    expect(storage.writes).toHaveLength(1)
    expect(storage.writes[0]?.key).toBe(confirmed.objectKey)
    expect(mediaObjects.inserted[0]).toMatchObject({
      moderationDecision: 'REVIEW',
      provider: 'LOCAL',
      providerMd5: null,
      finalKey: confirmed.objectKey,
    })
  })

  // 同一张图重复 confirm（客户端重试 / 改头像回传上一次的键）必须复用既有结论，且**不**重新
  // 固化到公开前缀 —— 否则「审核中」会随着一次重试消失。
  test('accepts an already confirmed review key without re-moderating or promoting it', async () => {
    let moderated = 0
    const reviewKey = `${REVIEW_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c5')}.jpg`
    const { service, storage } = buildService({
      mediaObjects: fakeMediaObjects({
        findConfirmedFinalKey: async (finalKey) =>
          finalKey === reviewKey
            ? { userId: USER_ID, finalKey: reviewKey, moderationDecision: 'REVIEW' }
            : null,
      }),
      moderateImage: async (input) => {
        moderated += 1
        return localVerdict(input)
      },
    })

    await expect(service.confirm(USER_ID, { objectKey: reviewKey })).resolves.toEqual({
      objectKey: reviewKey,
      url: `https://cdn.test/${reviewKey}`,
      moderationDecision: 'REVIEW',
    })
    expect(moderated).toBe(0)
    expect(storage.reads).toBe(0)
    expect(storage.writes).toEqual([])
  })

  // 人工结算（#286 复审 blocker 1）：管理员放行之后，有效结论变成 ALLOW，于是卖家再编辑
  // （编辑请求回传同一个键）不会把它重新压回人工队列。
  test('reports the settled ALLOW verdict once an admin has released the image', async () => {
    const reviewKey = `${REVIEW_PREFIX}${encodePublicId(PUBLIC_ID_PREFIX.media, '01930000-0000-7000-8000-0000000000c6')}.jpg`
    const { service } = buildService({
      mediaObjects: fakeMediaObjects({
        findConfirmedFinalKey: async (finalKey) =>
          finalKey === reviewKey
            ? { userId: USER_ID, finalKey: reviewKey, moderationDecision: 'ALLOW' }
            : null,
      }),
    })

    await expect(service.confirm(USER_ID, { objectKey: reviewKey })).resolves.toEqual({
      objectKey: reviewKey,
      url: `https://cdn.test/${reviewKey}`,
      moderationDecision: 'ALLOW',
    })
  })

  test('does not fixate a BLOCK image and reports the failed field', async () => {
    const { service, storage, mediaObjects } = buildService({
      moderateImage: async (input) =>
        verdict(input, { decision: 'BLOCK', suggestion: 'Block', label: 'Porn' }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )

    expect(error.status).toBe(422)
    expect(error.code).toBe('IMAGE_CONTENT_BLOCKED')
    expect(error.details).toEqual([{ field: 'objectKey', message: '图片内容未通过审核' }])
    expect(storage.writes).toEqual([])
    expect(mediaObjects.inserted[0]).toMatchObject({
      finalKey: null,
      moderationDecision: 'BLOCK',
      contentDigest: CONTENT_DIGEST,
    })
  })

  // #286 步骤 2：ALLOW 必须同时带内容摘要才可信；拿不到摘要就等于没审，不放行也不固化。
  test('refuses an ALLOW verdict without a content digest', async () => {
    const { service, storage, mediaObjects } = buildService({
      moderateImage: async (input) => verdict(input, { contentDigest: null }),
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )

    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(storage.writes).toEqual([])
    expect(mediaObjects.inserted).toEqual([])
  })

  // 接口重试不重复计费：同一个 staging 键 + 同一份字节的既有结论直接复用。
  test('reuses a verdict stored for the same content', async () => {
    let moderated = 0
    const mediaObjects = fakeMediaObjects({
      findByDigest: async (input) => {
        mediaObjects.asked.push({
          stagingKey: input.stagingKey,
          contentDigest: input.contentDigest,
        })
        return mediaRow({
          userId: USER_ID,
          stagingKey: STAGING_KEY,
          finalKey: FINAL_KEY,
          contentDigest: CONTENT_DIGEST,
          providerMd5: PROVIDER_MD5,
          moderationDecision: 'ALLOW',
          provider: 'TENCENT_IMS',
          providerRequestId: 'req-1',
        })
      },
    })
    const { service, storage } = buildService({
      mediaObjects,
      moderateImage: async (input) => {
        moderated += 1
        return verdict(input)
      },
    })

    expect(await service.confirm(USER_ID, { objectKey: STAGING_KEY })).toEqual({
      objectKey: FINAL_KEY,
      url: `https://cdn.test/${FINAL_KEY}`,
      moderationDecision: 'ALLOW',
    })
    expect(moderated).toBe(0)
    expect(storage.writes).toEqual([])
    expect(mediaObjects.asked).toEqual([{ stagingKey: STAGING_KEY, contentDigest: CONTENT_DIGEST }])
  })

  test('replays a stored BLOCK verdict instead of moderating again', async () => {
    let moderated = 0
    const mediaObjects = fakeMediaObjects({
      findByDigest: async () =>
        mediaRow({
          userId: USER_ID,
          stagingKey: STAGING_KEY,
          finalKey: null,
          contentDigest: CONTENT_DIGEST,
          providerMd5: PROVIDER_MD5,
          moderationDecision: 'BLOCK',
          provider: 'TENCENT_IMS',
          providerRequestId: 'req-1',
        }),
    })
    const { service, storage } = buildService({
      mediaObjects,
      moderateImage: async (input) => {
        moderated += 1
        return verdict(input)
      },
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.code).toBe('IMAGE_CONTENT_BLOCKED')
    expect(moderated).toBe(0)
    expect(storage.writes).toEqual([])
  })

  test('maps a provider failure to 503 without fixating anything', async () => {
    const { service, storage, mediaObjects } = buildService({
      moderateImage: async () => {
        throw new ContentModerationError({ reason: 'timeout', provider: 'TENCENT_IMS' })
      },
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(storage.writes).toEqual([])
    expect(mediaObjects.inserted).toEqual([])
  })

  test('maps an invalid provider input to 400', async () => {
    const { service } = buildService({
      moderateImage: async () => {
        throw new ContentModerationError({ reason: 'invalid_input', detail: 'image_too_large' })
      },
    })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )
    expect(error.status).toBe(400)
    expect(error.code).toBe('CONTENT_MODERATION_INVALID_INPUT')
  })

  test('falls back to the row that won a concurrent insert', async () => {
    let lookups = 0
    const mediaObjects = fakeMediaObjects({
      findByDigest: async () => {
        lookups += 1
        if (lookups === 1) return null
        return mediaRow({
          userId: USER_ID,
          stagingKey: STAGING_KEY,
          finalKey: FINAL_KEY,
          contentDigest: CONTENT_DIGEST,
          providerMd5: PROVIDER_MD5,
          moderationDecision: 'ALLOW',
          provider: 'TENCENT_IMS',
          providerRequestId: 'req-1',
        })
      },
      insert: async () => null,
    })
    const { service, storage } = buildService({ mediaObjects })

    const confirmed = await service.confirm(USER_ID, { objectKey: STAGING_KEY })

    expect(confirmed.objectKey).toBe(FINAL_KEY)
    expect(lookups).toBe(2)
    // 本次写的对象成了孤儿（内容相同、已过审），但只暴露先落库那一个可引用键。
    expect(storage.writes).toHaveLength(1)
  })

  test('fails closed when the verdict cannot be persisted', async () => {
    const mediaObjects = fakeMediaObjects({
      findByDigest: async () => null,
      insert: async () => null,
    })
    const { service, storage } = buildService({ mediaObjects })

    const error = await expectUploadError(() =>
      service.confirm(USER_ID, { objectKey: STAGING_KEY }),
    )

    expect(error.status).toBe(503)
    expect(error.code).toBe('CONTENT_MODERATION_UNAVAILABLE')
    expect(storage.writes).toHaveLength(1)
  })
})
