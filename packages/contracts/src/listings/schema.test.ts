import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import { ApiErrorSchema } from '../system/error'
import {
  ListingCardSchema,
  ListingCreateInputSchema,
  ListingDetailSchema,
  ListingFeedQuerySchema,
  ListingSellerSchema,
  ListingUpdateInputSchema,
  MAX_IMAGE_BYTES,
  UploadPresignRequestSchema,
} from './schema'

/** 取校验失败的字段路径：断言"错误落在哪个输入框"是契约的一部分（前端据此定位）。 */
function issuePaths(schema: z.ZodType, input: unknown): PropertyKey[][] {
  const result = schema.safeParse(input)
  return result.success ? [] : result.error.issues.map((issue) => issue.path)
}

const validCreate = {
  title: '罗技 K380 键盘',
  description: '宿舍用了一学期，功能正常。',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  objectKeys: ['listings/u1/a.jpg'],
} as const

describe('ListingCreateInputSchema', () => {
  test('accepts a valid input and defaults the three flags to false', () => {
    const parsed = ListingCreateInputSchema.parse(validCreate)
    expect(parsed.urgent).toBe(false)
    expect(parsed.negotiable).toBe(false)
    expect(parsed.free).toBe(false)
  })

  test('trims the title', () => {
    expect(ListingCreateInputSchema.parse({ ...validCreate, title: '  键盘  ' }).title).toBe('键盘')
  })

  test('rejects an unknown field instead of dropping it', () => {
    expect(ListingCreateInputSchema.safeParse({ ...validCreate, status: 'SOLD' }).success).toBe(
      false,
    )
  })

  test('rejects a title outside 2–40 characters', () => {
    expect(ListingCreateInputSchema.safeParse({ ...validCreate, title: '键' }).success).toBe(false)
    expect(
      ListingCreateInputSchema.safeParse({ ...validCreate, title: '键'.repeat(41) }).success,
    ).toBe(false)
  })

  test('rejects a non-integer or out-of-range price', () => {
    expect(ListingCreateInputSchema.safeParse({ ...validCreate, priceCents: 160.5 }).success).toBe(
      false,
    )
    expect(ListingCreateInputSchema.safeParse({ ...validCreate, priceCents: -1 }).success).toBe(
      false,
    )
    expect(
      ListingCreateInputSchema.safeParse({ ...validCreate, priceCents: 10_000_001 }).success,
    ).toBe(false)
  })

  test('requires free listings to cost 0, and reports the error on priceCents', () => {
    expect(
      issuePaths(ListingCreateInputSchema, { ...validCreate, free: true, priceCents: 100 }),
    ).toEqual([['priceCents']])
    expect(
      ListingCreateInputSchema.safeParse({ ...validCreate, free: true, priceCents: 0 }).success,
    ).toBe(true)
  })

  test('does not force a 0-price listing to be flagged as free', () => {
    expect(
      ListingCreateInputSchema.safeParse({ ...validCreate, free: false, priceCents: 0 }).success,
    ).toBe(true)
  })

  test('requires 1–9 unique object keys', () => {
    expect(ListingCreateInputSchema.safeParse({ ...validCreate, objectKeys: [] }).success).toBe(
      false,
    )
    expect(
      ListingCreateInputSchema.safeParse({
        ...validCreate,
        objectKeys: Array.from({ length: 10 }, (_, index) => `listings/u1/${index}.jpg`),
      }).success,
    ).toBe(false)
    expect(
      issuePaths(ListingCreateInputSchema, {
        ...validCreate,
        objectKeys: ['listings/u1/a.jpg', 'listings/u1/a.jpg'],
      }),
    ).toEqual([['objectKeys']])
  })
})

describe('ListingUpdateInputSchema', () => {
  test('accepts a single-field patch', () => {
    expect(ListingUpdateInputSchema.parse({ priceCents: 12000 }).priceCents).toBe(12000)
  })

  test('rejects an empty patch instead of treating it as a no-op', () => {
    expect(ListingUpdateInputSchema.safeParse({}).success).toBe(false)
  })

  test('rejects status: it is not writable through the API', () => {
    expect(ListingUpdateInputSchema.safeParse({ status: 'SOLD' }).success).toBe(false)
  })

  // 部分更新的核心语义：只给 free 时无法单凭请求体判定，交给 service 与库中既有行合并后校验。
  test('accepts free alone and defers the coupling check to the service layer', () => {
    expect(ListingUpdateInputSchema.safeParse({ free: true }).success).toBe(true)
  })

  test('rejects free together with a non-zero price', () => {
    expect(issuePaths(ListingUpdateInputSchema, { free: true, priceCents: 100 })).toEqual([
      ['priceCents'],
    ])
  })

  test('rejects duplicate object keys when images are replaced', () => {
    expect(ListingUpdateInputSchema.safeParse({ objectKeys: ['a.jpg', 'a.jpg'] }).success).toBe(
      false,
    )
  })
})

describe('ListingFeedQuerySchema', () => {
  test('applies sort and limit defaults and coerces numeric strings', () => {
    const parsed = ListingFeedQuerySchema.parse({ limit: '3' })
    expect(parsed.limit).toBe(3)
    expect(parsed.sort).toBe('newest')
  })

  test('accepts an omitted price range', () => {
    expect(ListingFeedQuerySchema.safeParse({}).success).toBe(true)
  })

  test('rejects priceMaxCents below priceMinCents', () => {
    expect(
      ListingFeedQuerySchema.safeParse({ priceMinCents: '500', priceMaxCents: '100' }).success,
    ).toBe(false)
  })

  test('rejects status without sellerId', () => {
    expect(issuePaths(ListingFeedQuerySchema, { status: 'SOLD' })).toEqual([['status']])
  })

  test('accepts status together with sellerId', () => {
    expect(
      ListingFeedQuerySchema.safeParse({
        status: 'SOLD',
        sellerId: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      }).success,
    ).toBe(true)
  })

  test('rejects limit above 50 and unknown params', () => {
    expect(ListingFeedQuerySchema.safeParse({ limit: '51' }).success).toBe(false)
    // condition 筛选不在 #6 范围内，也没有对应索引；strictObject 让它明确失败而不是被忽略。
    expect(ListingFeedQuerySchema.safeParse({ condition: 'GOOD' }).success).toBe(false)
  })
})

describe('ListingSellerSchema', () => {
  test('exposes exactly id / nickname / avatarUrl / campus', () => {
    expect(Object.keys(ListingSellerSchema.shape).sort()).toEqual([
      'avatarUrl',
      'campus',
      'id',
      'nickname',
    ])
  })

  test('strips authStatus so the untrusted mock verification cannot leak into listings', () => {
    const parsed = ListingSellerSchema.parse({
      id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
      nickname: '阿岚',
      avatarUrl: null,
      campus: '肇庆',
      authStatus: 'VERIFIED',
      verifiedAt: '2026-09-12T03:40:10.000Z',
    })
    expect('authStatus' in parsed).toBe(false)
  })
})

describe('ListingDetailSchema', () => {
  const detail = {
    id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
    title: '罗技 K380 键盘',
    description: '宿舍用了一学期，功能正常。',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-12T03:40:10.000Z',
    updatedAt: '2026-09-12T03:40:10.000Z',
    images: [],
    seller: {
      // 注意：`z.uuid()` 会校验 RFC 版本位与变体位，随手编的 UUID 会被拒。
      id: '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d',
      nickname: '阿岚',
      avatarUrl: null,
      campus: '肇庆',
    },
    isOwner: false,
  }

  test('accepts a listing without images and a null cover', () => {
    expect(ListingDetailSchema.safeParse(detail).success).toBe(true)
  })

  test('caps images at 9', () => {
    const images = Array.from({ length: 10 }, (_, index) => ({
      url: `https://cdn.example.com/${index}.jpg`,
      sortOrder: index,
    }))
    expect(ListingDetailSchema.safeParse({ ...detail, images }).success).toBe(false)
  })

  test('carries every card field so the two shapes cannot drift', () => {
    for (const key of Object.keys(ListingCardSchema.shape)) {
      expect(key in ListingDetailSchema.shape).toBe(true)
    }
  })
})

describe('ListingCardSchema', () => {
  test('rejects an unknown status (DRAFT does not exist in the state machine)', () => {
    expect(
      ListingCardSchema.safeParse({
        id: '0d9c6f2a-1f3e-4a5b-8c7d-6e5f4a3b2c1d',
        title: '键盘',
        priceCents: 0,
        category: 'DIGITAL',
        condition: 'GOOD',
        status: 'DRAFT',
        urgent: false,
        negotiable: false,
        free: true,
        coverUrl: null,
        createdAt: '2026-09-12T03:40:10.000Z',
      }).success,
    ).toBe(false)
  })
})

describe('UploadPresignRequestSchema', () => {
  test('accepts an allowed mime type under the size cap', () => {
    expect(
      UploadPresignRequestSchema.safeParse({ contentType: 'image/jpeg', sizeBytes: 1024 }).success,
    ).toBe(true)
    expect(
      UploadPresignRequestSchema.safeParse({
        contentType: 'image/webp',
        sizeBytes: MAX_IMAGE_BYTES,
      }).success,
    ).toBe(true)
  })

  // iOS 相册的 HEIC 不在允许列表里：前端必须先转码，否则用户传原图会被服务端拒绝。
  test('rejects image/heic so the frontend must transcode', () => {
    expect(
      UploadPresignRequestSchema.safeParse({ contentType: 'image/heic', sizeBytes: 1024 }).success,
    ).toBe(false)
  })

  test('rejects a payload over the size cap', () => {
    expect(
      UploadPresignRequestSchema.safeParse({
        contentType: 'image/jpeg',
        sizeBytes: MAX_IMAGE_BYTES + 1,
      }).success,
    ).toBe(false)
  })
})

describe('ApiErrorSchema', () => {
  test('still accepts the envelope used by auth and wishes (no details)', () => {
    const parsed = ApiErrorSchema.parse({ error: { code: 'UNAUTHENTICATED', message: '未登录' } })
    expect(parsed.error.details).toBeUndefined()
  })

  test('accepts field-level details for form validation', () => {
    const parsed = ApiErrorSchema.parse({
      error: {
        code: 'VALIDATION_FAILED',
        message: '参数校验失败',
        details: [{ field: 'images.2', message: '同一张图片不能重复' }],
      },
    })
    expect(parsed.error.details?.[0]?.field).toBe('images.2')
  })
})
