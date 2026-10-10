import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import type { z } from 'zod'
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

const USER_ID = encodePublicId(PUBLIC_ID_PREFIX.user, '01930000-0000-7000-8000-00000000000a')
const LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, '01930000-0000-7000-8000-000000000011')

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

  // #451：`free` 必须解析成布尔位，且只认 `"true"` / `"false"` 两个字面量。
  // 用 `z.coerce.boolean()` 的实现会把 `?free=false` 也判成 true（任何非空字符串都真），
  // 于是「只看非免费送」静默变成「只看免费送」—— 静默反转，所以把口径钉死。
  test('parses free as a strict boolean literal and rejects other strings', () => {
    expect(ListingFeedQuerySchema.parse({ free: 'true' }).free).toBe(true)
    expect(ListingFeedQuerySchema.parse({ free: 'false' }).free).toBe(false)
    expect(ListingFeedQuerySchema.parse({}).free).toBeUndefined()
    expect(issuePaths(ListingFeedQuerySchema, { free: '1' })).toEqual([['free']])
    expect(issuePaths(ListingFeedQuerySchema, { free: '' })).toEqual([['free']])
  })

  // 冻结契约没有规定区间倒置的行为（§2.1 只说空结果是 200），因此代码与冻结文本一致：不加 422 规则。
  // 若 Owner 要收紧，需按 CONTRIBUTING §5 补进契约后重新 Freeze。
  test('accepts an inverted price range (frozen contract defines no rule for it)', () => {
    expect(
      ListingFeedQuerySchema.safeParse({ priceMinCents: '500', priceMaxCents: '100' }).success,
    ).toBe(true)
  })

  test('rejects status without sellerId', () => {
    expect(issuePaths(ListingFeedQuerySchema, { status: 'SOLD' })).toEqual([['status']])
  })

  test('accepts status together with sellerId', () => {
    expect(
      ListingFeedQuerySchema.safeParse({
        status: 'SOLD',
        sellerId: USER_ID,
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
  test('exposes exactly id / nickname / avatarUrl / authStatus（#86 F：校区不再公开）', () => {
    expect(Object.keys(ListingSellerSchema.shape).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'nickname',
    ])
  })

  test('carries authStatus but strips verifiedAt / campusEmail / studentNo（#68：公开徽章成立，敏感字段仍不外泄）', () => {
    const parsed = ListingSellerSchema.parse({
      id: USER_ID,
      nickname: '阿岚',
      avatarUrl: null,
      authStatus: 'VERIFIED',
      verifiedAt: '2026-09-12T03:40:10.000Z',
      campusEmail: 'someone@gzasc.edu.cn',
      studentNo: '202101000001',
    })
    expect(parsed.authStatus).toBe('VERIFIED')
    expect('verifiedAt' in parsed).toBe(false)
    expect('campusEmail' in parsed).toBe(false)
    expect('studentNo' in parsed).toBe(false)
  })
})

describe('ListingDetailSchema', () => {
  const detail = {
    id: LISTING_ID,
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
    wants: 0,
    views: 0,
    images: [],
    seller: {
      id: USER_ID,
      nickname: '阿岚',
      avatarUrl: null,
      authStatus: 'VERIFIED',
    },
    isOwner: false,
    moderationStatus: null,
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

  // 详情是卡片 `.extend()` 出来的：卡片的必填约束必须跟着走，否则详情页可以少一个数
  test('缺 wants 同样被拒（必填由 ListingCardSchema.extend 继承）', () => {
    const { wants: _omitted, ...withoutWants } = detail
    expect(ListingDetailSchema.safeParse(withoutWants).success).toBe(false)
  })

  // 浏览量同理：详情页把「浏览 N · 想要 N」画在同一行，少一个数那一行就只剩半边
  test('缺 views 同样被拒（必填由 ListingCardSchema.extend 继承）', () => {
    const { views: _omitted, ...withoutViews } = detail
    expect(ListingDetailSchema.safeParse(withoutViews).success).toBe(false)
  })

  test('carries every card field so the two shapes cannot drift', () => {
    for (const key of Object.keys(ListingCardSchema.shape)) {
      expect(key in ListingDetailSchema.shape).toBe(true)
    }
  })
})

describe('ListingCardSchema', () => {
  const card = {
    id: LISTING_ID,
    title: '键盘',
    priceCents: 0,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: true,
    coverUrl: null,
    createdAt: '2026-09-12T03:40:10.000Z',
    moderationStatus: null,
    wants: 0,
    views: 0,
  }

  test('rejects an unknown status (DRAFT does not exist in the state machine)', () => {
    expect(ListingCardSchema.safeParse({ ...card, status: 'DRAFT' }).success).toBe(false)
  })

  /*
   * `wants` 必填（= 该商品已建会话的买家数，唯一实现在 `@fish/db/listing-wants`）。
   * 为什么不能写成 optional：`0`（确实还没人开过会话）是**事实**，键缺席是**没有这个事实**；
   * 契约放行缺席就等于允许服务端漏带这个数字，而客户端只能把它画成「没人想要」——
   * 那是编造出来的市场信号，也是这个字段被加进契约之前两个计数整块画不出来的原因。
   */
  test('缺 wants 必须被拒（0 是事实，缺席不是）', () => {
    const { wants: _omitted, ...withoutWants } = card
    expect(ListingCardSchema.safeParse(withoutWants).success).toBe(false)
    // 拒收的理由必须是「少了这个数」：错误要落在 wants 上，而不是别的字段被带崩
    expect(issuePaths(ListingCardSchema, withoutWants)).toContainEqual(['wants'])
  })

  /*
   * `views` 同样必填（= 近 30 天去重浏览人数，唯一实现在 `@fish/db/listing-views`）。
   * 与 `wants` 的理由一字不差：`0`（窗口内没有去重访客）是事实，键缺席是「没查/漏带」。
   * 放行缺席就等于允许服务端漏带这个数字，客户端只能画成「0 浏览」——编造出来的市场信号。
   */
  test('缺 views 必须被拒（0 是事实，缺席不是）', () => {
    const { views: _omitted, ...withoutViews } = card
    expect(ListingCardSchema.safeParse(withoutViews).success).toBe(false)
    expect(issuePaths(ListingCardSchema, withoutViews)).toContainEqual(['views'])
  })

  test('携带审核态：null（非本人视角）与三档枚举合法，其余值拒收', () => {
    for (const moderationStatus of [null, 'APPROVED', 'REVIEW', 'BLOCKED']) {
      expect(ListingCardSchema.safeParse({ ...card, moderationStatus }).success).toBe(true)
    }
    expect(ListingCardSchema.safeParse({ ...card, moderationStatus: 'PENDING' }).success).toBe(
      false,
    )
  })

  // #191：seller 只收公开四字段。老客户端 mock 记录可以省略（API 卡片恒带，见契约注释）；
  // 多余字段（如 role / campus）被剥离，不能借卡片把非公开列带出服务端。
  test('seller 是可选的公开子集：缺席合法、四字段合法、多余字段剥离', () => {
    expect(ListingCardSchema.safeParse(card).success).toBe(true)
    expect(
      ListingCardSchema.safeParse({
        ...card,
        seller: { id: USER_ID, nickname: '阿岚', avatarUrl: null, authStatus: 'VERIFIED' },
      }).success,
    ).toBe(true)

    const parsed = ListingCardSchema.parse({
      ...card,
      seller: {
        id: USER_ID,
        nickname: '阿岚',
        avatarUrl: null,
        authStatus: 'VERIFIED',
        role: 'ADMIN',
      },
    })
    expect(parsed.seller).toEqual({
      id: USER_ID,
      nickname: '阿岚',
      avatarUrl: null,
      authStatus: 'VERIFIED',
    })
    expect(Object.keys(parsed.seller ?? {}).sort()).toEqual([
      'authStatus',
      'avatarUrl',
      'id',
      'nickname',
    ])
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
