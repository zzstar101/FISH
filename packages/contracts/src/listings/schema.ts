import { z } from 'zod'
import { AuthStatusSchema, MeSchema } from '../auth/user'

/**
 * Listing Domain Contract（Issue #6，2026-09-12 Freeze）。
 *
 * 本目录是商品域协议的唯一来源：API 与 Web（含 Mock adapter）都从这里 import，
 * 禁止在别处重复定义枚举或值域。冻结内容见 Issue #6 的契约评论。
 */

// ---------------------------------------------------------------------------
// 枚举：逐字镜像 #2 冻结的 DB 枚举（packages/db/src/schema/listings.ts 的三个 pgEnum）。
// 大小写与值域必须一致——DB 侧是 pgEnum，漂移只会在 INSERT 时才炸，typecheck 拦不住。
// 本文件是唯一来源；#7 自造的小写分类枚举待迁移（见 Issue #6 协调点 A）。
// ---------------------------------------------------------------------------

export const ListingCategorySchema = z.enum([
  'DIGITAL',
  'BOOKS',
  'BEAUTY',
  'DAILY',
  'SPORTS',
  'APPAREL',
  'TRANSPORT',
  'OTHER',
])

export type ListingCategory = z.infer<typeof ListingCategorySchema>

export const ListingConditionSchema = z.enum(['NEW', 'LIKE_NEW', 'GOOD', 'FAIR'])

export type ListingCondition = z.infer<typeof ListingConditionSchema>

export const ListingStatusSchema = z.enum(['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'])

export type ListingStatus = z.infer<typeof ListingStatusSchema>

/**
 * 审核状态（读模型）。
 *
 * `REVIEW` 的商品在库里同时是 `status = OFFLINE`，所以客户端**只看 `status` 分不出**
 * 「等你改内容」和「你自己下架的」。本字段就是那条判据：卖家自己的列表/详情据此显示
 * 「审核中」，而不是把它当成已下架（#74）。
 *
 * 只在**卖家本人视角**返回真实值（`GET /listings?sellerId=自己`、自己的商品详情）；
 * 公开 Feed 与他人视角一律 `null` —— 平台内部审核态不是买家该看到的信息。
 */
export const ListingModerationStatusSchema = z.enum(['APPROVED', 'BLOCKED', 'REVIEW'])

export type ListingModerationStatus = z.infer<typeof ListingModerationStatusSchema>

// ---------------------------------------------------------------------------
// 值域
// ---------------------------------------------------------------------------

/**
 * 标题与描述的长度上限只在这里定义：DB 侧是裸 `text`，没有任何 CHECK 兜底。
 */
export const ListingTitleSchema = z
  .string()
  .trim()
  .min(2, '标题至少 2 个字')
  .max(40, '标题最多 40 个字')

export const ListingDescriptionSchema = z
  .string()
  .trim()
  .min(1, '请填写描述')
  .max(500, '描述最多 500 个字')

/** 金额一律整数分；上限定在 ¥100,000，防手滑输入天文数字（DB 只保证 `>= 0`）。 */
export const PriceCentsSchema = z
  .number()
  .int('价格必须是整数分')
  .min(0, '价格不能为负')
  .max(10_000_000, '价格不能超过 ¥100,000')

/**
 * 上传约束。导出常量而不是让 Web 侧写 magic number：前端要在本地预校验并给错误文案，
 * 两侧各写一份必然漂移。`image/heic` 刻意不在允许列表里（多端渲染不了），
 * iOS 相册的 HEIC 由前端 canvas 重编码后再上传。
 */
export const MAX_LISTING_IMAGES = 9
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const

/**
 * 对象键前缀。presign 生成对象键与 create 校验归属必须调用同一个函数：
 * 两侧各写一遍字符串模板，就会演化成"生成的键通不过自己的校验"。
 * 前缀里带 userId，是不新增表就能防住"引用他人图片"的关键。
 */
export const listingObjectKeyPrefix = (userId: string) => `listings/${userId}/`

// ---------------------------------------------------------------------------
// 读模型
// ---------------------------------------------------------------------------

/**
 * feed 游标里时间戳的形态：**带微秒**的 UTC ISO 时间。
 *
 * 放在契约包是因为 zod 只在契约包（API 没有直接依赖 zod），而**生成方**
 * （`store.listFeed` 的 `to_char(..., 'US')`）与**校验方**（API 的 `decodeCursor`）
 * 必须共用同一份定义，各写一份必然漂移。
 *
 * 用 zod 而不是手写正则：正则只能约束形状，`2026-13-45T99:99:99.999999Z`、`2026-02-31T…`
 * 照样通过，随后被 PG 的 `::timestamptz` 拒绝 → 500（实测），而契约 §2.1 要求 422。
 *
 * 游标对前端不透明（§2.1），前端不应 import 这个 schema。
 */
export const ListingCursorTimestampSchema = z.iso.datetime({ precision: 6 })

/**
 * 商品 id 的形状。具名导出是因为它有三个使用点：读模型的 `id`、路由参数 `:id` 的校验、
 * 游标里 `id` 的校验（前两者拼错会变成 uuid 列的 SQL 类型错误 → 500，而不是 404/422）。
 */
export const ListingIdSchema = z.uuid()

/**
 * 读响应只给拼好的 `url`，不给 `objectKey`：后者是存储实现细节，
 * 放进读契约等于把 S3 布局钉进协议，换 CDN 或换布局都成了破坏性变更。
 */
export const ListingImageSchema = z.object({
  url: z.url(),
  sortOrder: z.number().int().nonnegative(),
})

export type ListingImage = z.infer<typeof ListingImageSchema>

/**
 * 卖家公开信息用 `.pick()` 派生而不是重写字段，避免与认证域漂移。
 *
 * #68 后 `authStatus` 只能由真实校园邮箱验证产生（注册不再认证、Mock 已删），
 * 可信度成立，公开徽章是认证体系的价值所在；但它只作展示，前端不得当权限判据。
 * `verifiedAt` / `campusEmail` 仍不公开：验证时间与邮箱属于本人信息。
 *
 * #86（2026-09-22 产品冻结）：不采集、不公开校区——这里**没有** `campus` 字段，
 * 商品详情与公开主页共用同一口径（#86 F 节），不存在「详情页特批公开」的第二事实源。
 */
export const ListingSellerSchema = MeSchema.pick({
  id: true,
  nickname: true,
  avatarUrl: true,
}).extend({ authStatus: AuthStatusSchema })

export type ListingSeller = z.infer<typeof ListingSellerSchema>

export const ListingCardSchema = z.object({
  id: ListingIdSchema,
  title: ListingTitleSchema,
  priceCents: PriceCentsSchema,
  category: ListingCategorySchema,
  condition: ListingConditionSchema,
  status: ListingStatusSchema,
  urgent: z.boolean(),
  negotiable: z.boolean(),
  free: z.boolean(),
  /** 无图商品为 `null`（seed 6 条商品里有 3 条无图），前端必须有占位处理。 */
  coverUrl: z.url().nullable(),
  createdAt: z.iso.datetime(),
  /**
   * 仅**卖家本人**视角非 `null`（公开 Feed / 他人视角恒 `null`，见 `ListingModerationStatusSchema`）。
   * 客户端据此把审核中的商品显示成「审核中」，而不是 `OFFLINE`（已下架）。
   */
  moderationStatus: ListingModerationStatusSchema.nullable(),
})

export type ListingCard = z.infer<typeof ListingCardSchema>

/** 详情用 `.extend()` 从 card 派生：两个 schema 的公共字段不可能漂移。 */
export const ListingDetailSchema = ListingCardSchema.extend({
  description: ListingDescriptionSchema,
  images: z.array(ListingImageSchema).max(MAX_LISTING_IMAGES),
  seller: ListingSellerSchema,
  /** 服务端计算；匿名恒 `false`。前端据此决定是否显示"编辑 / 下架"。 */
  isOwner: z.boolean(),
  updatedAt: z.iso.datetime(),
})

export type ListingDetail = z.infer<typeof ListingDetailSchema>

// ---------------------------------------------------------------------------
// 写模型
// ---------------------------------------------------------------------------

/** 下标即 `sortOrder`（0 = 封面），对应 DB 的 `(listing_id, sort_order)` 唯一索引。 */
const ObjectKeyListSchema = z
  .array(z.string().min(1))
  .min(1, '至少上传 1 张图片')
  .max(MAX_LISTING_IMAGES, `最多上传 ${MAX_LISTING_IMAGES} 张图片`)

/**
 * `.strictObject()`：多余字段直接 422 而不是静默丢弃，与认证域的
 * `RegisterRequestSchema` 同一取舍——写请求拼错字段名必须立刻报错。
 */
export const ListingCreateInputSchema = z
  .strictObject({
    title: ListingTitleSchema,
    description: ListingDescriptionSchema,
    priceCents: PriceCentsSchema,
    category: ListingCategorySchema,
    condition: ListingConditionSchema,
    urgent: z.boolean().default(false),
    negotiable: z.boolean().default(false),
    free: z.boolean().default(false),
    objectKeys: ObjectKeyListSchema,
  })
  // 单向约束：勾了"0 元送"价格必须是 0；反向不强制（"想免费但没勾"不构成 422）。
  .refine((value) => !value.free || value.priceCents === 0, {
    path: ['priceCents'],
    error: '0 元送时价格必须为 0',
  })
  .refine((value) => new Set(value.objectKeys).size === value.objectKeys.length, {
    path: ['objectKeys'],
    error: '同一张图片不能重复',
  })

export type ListingCreateInput = z.infer<typeof ListingCreateInputSchema>

/**
 * 部分更新。`status` 刻意不在字段里：`RESERVED` / `SOLD` 是 #11 交易流程写的状态，
 * 让写请求能带 `status` 意味着一个前端 bug 就能把商品标成已售。
 *
 * `objectKeys` 一旦出现就是**全量替换**（DB 只有 `(listing_id, sort_order)` 唯一索引，
 * 增量增删要处理排序位移与中间态）。
 */
export const ListingUpdateInputSchema = z
  .strictObject({
    title: ListingTitleSchema.optional(),
    description: ListingDescriptionSchema.optional(),
    priceCents: PriceCentsSchema.optional(),
    category: ListingCategorySchema.optional(),
    condition: ListingConditionSchema.optional(),
    urgent: z.boolean().optional(),
    negotiable: z.boolean().optional(),
    free: z.boolean().optional(),
    objectKeys: ObjectKeyListSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { error: '至少提供一个要修改的字段' })
  // 部分更新下无法只凭请求体判定 free ⟹ priceCents === 0：只在两者同时出现时校验。
  // 只给 `free` 的情形必须由 service 与库中既有行合并后校验（违者 422 VALIDATION_FAILED）——
  // 判定标准是"最终状态成立"，不是"请求体单独成立"，详见 Issue #6 契约评论 §7.1。
  .refine((value) => !value.free || value.priceCents === undefined || value.priceCents === 0, {
    path: ['priceCents'],
    error: '0 元送时价格必须为 0',
  })
  .refine(
    (value) =>
      value.objectKeys === undefined || new Set(value.objectKeys).size === value.objectKeys.length,
    { path: ['objectKeys'], error: '同一张图片不能重复' },
  )

export type ListingUpdateInput = z.infer<typeof ListingUpdateInputSchema>

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export const ListingSortSchema = z.enum(['newest', 'priceAsc', 'priceDesc'])

export type ListingSort = z.infer<typeof ListingSortSchema>

export const ListingFeedQuerySchema = z
  .strictObject({
    /** 匹配范围 = `title` + `description`；用 ILIKE 还是 FTS 是实现细节，契约不约定。 */
    q: z.string().trim().min(1).max(50).optional(),
    category: ListingCategorySchema.optional(),
    priceMinCents: z.coerce.number().int().min(0).optional(),
    priceMaxCents: z.coerce.number().int().min(0).optional(),
    sort: ListingSortSchema.default('newest'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /**
     * 不透明字符串：服务端对 `(排序键, id)` 编码，前端禁止解析或构造，只能原样回传上一页的值。
     * 用 cursor 而不是 offset：新商品会插到列表最前，offset 翻页必然重复/漏项。
     */
    cursor: z.string().min(1).optional(),
    /** 只允许等于当前用户，传他人坐标由路由层拒绝（403 NOT_LISTING_OWNER）。 */
    sellerId: z.uuid().optional(),
    /** 只在同时给 `sellerId` 时才接受，否则任何人都能 `?status=SOLD` 拉全站已售商品。 */
    status: ListingStatusSchema.optional(),
  })
  .refine((value) => value.status === undefined || value.sellerId !== undefined, {
    path: ['status'],
    error: 'status 必须与 sellerId 一起使用',
  })

export type ListingFeedQuery = z.infer<typeof ListingFeedQuerySchema>

/**
 * 不另给 `hasMore`：它与 `nextCursor !== null` 表达同一信息，两个字段必然漂移。
 * 也不给 `total`：#4 的无限滚动用不到，而它需要额外一次 COUNT。
 */
export const ListingFeedResponseSchema = z.object({
  items: z.array(ListingCardSchema),
  nextCursor: z.string().nullable(),
})

export type ListingFeedResponse = z.infer<typeof ListingFeedResponseSchema>

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

export const UploadPresignRequestSchema = z.strictObject({
  contentType: z.enum(ALLOWED_IMAGE_MIME),
  sizeBytes: z.number().int().min(1).max(MAX_IMAGE_BYTES),
})

export type UploadPresignRequest = z.infer<typeof UploadPresignRequestSchema>

export const UploadPresignResponseSchema = z.object({
  uploadUrl: z.url(),
  /** 服务端生成 `listings/{userId}/{uuid}.{ext}`，前端视为不透明字符串。 */
  objectKey: z.string().min(1),
  /**
   * 服务端要求客户端在直传 `PUT` 时原样附带的头。
   *
   * 当前实现（Bun 原生 `S3Client.presign`）的签名只覆盖 `host`，因此这里是**空对象**
   * （实测：PUT 带不带 `Content-Type` 都是 200）。字段保留是为了换实现时前端不用改——
   * 注意**没有**"少带一个头就 403"这种保证（早期草案的错误说法，已在契约 §7.7 更正）。
   */
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
})

export type UploadPresignResponse = z.infer<typeof UploadPresignResponseSchema>

export const UploadConfirmRequestSchema = z.strictObject({ objectKey: z.string().min(1) })

export type UploadConfirmRequest = z.infer<typeof UploadConfirmRequestSchema>

export const UploadConfirmResponseSchema = z.object({
  objectKey: z.string().min(1),
  url: z.url(),
})

export type UploadConfirmResponse = z.infer<typeof UploadConfirmResponseSchema>

// ---------------------------------------------------------------------------
// 错误码：本 domain 新增的部分。其余复用 `auth` 的 `UNAUTHENTICATED`（401）
// 与 `system` 的 `VALIDATION_FAILED` / `INTERNAL_ERROR`。
// ---------------------------------------------------------------------------

export const ListingErrorCodeSchema = z.enum([
  /** 403：非本人写操作，或 `sellerId` 传了他人。 */
  'NOT_LISTING_OWNER',
  /** 404：id 不存在，或 OFFLINE 商品对非卖家（404 而非 403，不泄漏存在性）。 */
  'LISTING_NOT_FOUND',
  /** 409：RESERVED / SOLD 上的编辑、下架、上架。 */
  'LISTING_NOT_EDITABLE',
  /** 422：objectKey 前缀不属于本人。（同一 key 重复由 schema 的 refine 先掳下，报 VALIDATION_FAILED。） */
  'IMAGE_REFERENCE_INVALID',
  /** 422：confirm 时对象存储里找不到该对象。 */
  'UPLOAD_OBJECT_MISSING',
  /** 422：标题或描述命中服务端阻断规则。 */
  'LISTING_CONTENT_BLOCKED',
  /** 202：内容需要人工复核，商品不会进入公开列表。 */
  'LISTING_CONTENT_REVIEW',
])

export type ListingErrorCode = z.infer<typeof ListingErrorCodeSchema>
