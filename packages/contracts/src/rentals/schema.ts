import { z } from 'zod'
import { ListingConditionSchema, PriceCentsSchema } from '../listings/schema'
import { ListingIdSchema, UserIdSchema } from '../system/public-id'

/**
 * 租赁域 Contract（#706 RNT-02，租赁 V1 第 2 单）。
 *
 * 本文件只承担**出租商品**的发布 / 编辑 / 详情 / 广场协议。预约、档期占用、交接、争议
 * 分别由 #707 / #708 / #710 追加；它们在同一个目录下按文件拆开，不建 barrel `index.ts`。
 *
 * 冻结口径（Epic #704 的 M0，2026-11-20 Owner 拍板）见各常量注释。
 */

// ---------------------------------------------------------------------------
// 平台边界（M0 冻结值，端上与服务端共用；改动必须同步 #704 的 M0 记录）
// ---------------------------------------------------------------------------

/** 平台绝对最短租期（自然日，Asia/Shanghai）。 */
export const RENTAL_MIN_DAYS = 1
/** 平台绝对最长租期（自然日）。商家只能在 `[RENTAL_MIN_DAYS, RENTAL_MAX_DAYS]` 内自定。 */
export const RENTAL_MAX_DAYS = 90

/** 押金说明（发布页 / 详情页 / 订单页共用；措辞经 Owner 2026-11-20 冻结）。 */
export const RENTAL_DEPOSIT_NOTICE = {
  /**
   * 完整版，用于详情页与订单页。**详情页必须默认可见、不得折叠** —— 它是免责声明的核心，
   * 小程序审核会看这一段。
   */
  full: '本平台仅记录双方约定的押金金额，不代收、不托管、不垫付、不赔付。押金请当面结清，双方自行留存转账或现金凭证。发生争议时，平台只依据双方提交的证据记录处理，不承担资金责任。',
  /** 短版，用于发布页表单下方的说明位。 */
  short: '押金由双方线下面交时自行结清，平台不代收、不托管、不赔付。',
} as const

/** 押金输入框的标签（含「线下自行结算」这一句，避免用户以为平台代收）。 */
export const RENTAL_DEPOSIT_LABEL = '约定押金（元，线下自行结算）'

/** 出租规则文字长度上限（DB 层有同一数字的 CHECK 兜底）。 */
export const RENTAL_RULES_MAX = 2000

/**
 * 出租规则的可选预置条目（端上以可点选的 chip 呈现，也允许完全自定义文字）。
 *
 * 为什么给预置而不是纯自由文本：V1 不做结构化规则，但「押金退还条件」「损坏赔付」这类
 * 高频条款如果全靠手写，商家会漏写，争议时无据可依。预置只是**文本模板**，
 * 选中后拼进 `rules` 自由文本，不引入新的数据模型。
 */
export const RENTAL_RULE_PRESETS = [
  '取物时请当场验机，确认无损后离场即视为验收通过',
  '请勿擅自拆机、刷机或转借他人',
  '归还时电量不低于 30%',
  '人为损坏按实际维修费用赔付，从押金中扣除',
] as const

// ---------------------------------------------------------------------------
// 值域
// ---------------------------------------------------------------------------

/** 出租价格 = **日租单价**（整数分）。语义与 `PriceCentsSchema` 相同，只是单位是「每天」。 */
export const RentalDailyPriceCentsSchema = PriceCentsSchema

/** 押金（整数分）。允许 0（不收押金）。 */
export const DepositCentsSchema = z
  .number()
  .int('押金必须整数分')
  .nonnegative('押金不能为负')
  .max(100_000_00, '押金不得超过 100000 元')

/** 商家自定的最短租期（自然日）。 */
export const RentalMinDaysSchema = z
  .number()
  .int('最短租期必须是整数天')
  .min(RENTAL_MIN_DAYS, `最短租期不得少于 ${RENTAL_MIN_DAYS} 天`)
  .max(RENTAL_MAX_DAYS, `最短租期不得超过 ${RENTAL_MAX_DAYS} 天`)

/** 商家自定的最长租期（自然日）。与最短租期的相对关系在对象级 refine 里判。 */
export const RentalMaxDaysSchema = z
  .number()
  .int('最长租期必须是整数天')
  .min(RENTAL_MIN_DAYS, `最长租期不得少于 ${RENTAL_MIN_DAYS} 天`)
  .max(RENTAL_MAX_DAYS, `最长租期不得超过 ${RENTAL_MAX_DAYS} 天`)

/**
 * 出租规则（自由文本，可空）。
 *
 * 空白串归一为 `null`：契约里 `null` 的含义是「没写规则」，而 `"   "` trim 后是 `""` ——
 * 两者在端上长得一样但语义不同（`""` 会渲染成一个空的规则区块）。审查实测过这个洞。
 */
export const RentalRulesSchema = z
  .string()
  .trim()
  .max(RENTAL_RULES_MAX)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()

// ---------------------------------------------------------------------------
// 读模型：条款
// ---------------------------------------------------------------------------

export const RentalTermsSchema = z.object({
  /** 日租单价（整数分）。端上展示为 `¥xx/天`。 */
  dailyPriceCents: RentalDailyPriceCentsSchema,
  /** 约定押金（整数分）；0 = 不收押金。 */
  depositCents: DepositCentsSchema,
  /** 商家填写的规则文字；`null` = 没写。 */
  rules: RentalRulesSchema,
  minDays: RentalMinDaysSchema,
  maxDays: RentalMaxDaysSchema,
  /**
   * 条款版本（从 1 起）。日租价 / 押金 / 规则任一变化都 +1。
   *
   * #707 的预约单会持久化**当时的**条款快照；接单时比对版本，不一致返回
   * `409 RENTAL_TERMS_CHANGED` 并让买家看差异重确认。
   */
  termsVersion: z.number().int().min(1),
  /** 条款最近一次变更时刻（ISO）。列表可据此显示「刚刚更新」。 */
  updatedAt: z.iso.datetime(),
})

export type RentalTerms = z.infer<typeof RentalTermsSchema>

// ---------------------------------------------------------------------------
// 读模型：卡片 / 详情
// ---------------------------------------------------------------------------

/**
 * 广场卡片。**不复用 `ListingCardSchema`**：那张卡片的 `priceCents` / `free` / `negotiable`
 * 都是出售语义，出租的价格是日租单价、没有「免费送」和「可议价」的概念。
 * 强行复用会让端上每个字段都要判一次类型，且日租价会被当作售价渲染。
 */
export const RentalCardSchema = z.object({
  id: ListingIdSchema,
  listingNo: z.string().regex(/^[1-9][0-9]{11}$/),
  title: z.string(),
  /** 日租单价（整数分）。 */
  dailyPriceCents: RentalDailyPriceCentsSchema,
  depositCents: DepositCentsSchema,
  category: z.literal('DIGITAL'),
  condition: ListingConditionSchema,
  status: z.enum(['ACTIVE', 'OFFLINE']),
  minDays: RentalMinDaysSchema,
  maxDays: RentalMaxDaysSchema,
  coverUrl: z.url().nullable(),
  createdAt: z.iso.datetime(),
  /** 出租人公开子集。与 `ListingCardSellerSchema` 同形状，但独立定义以免跨域耦合。 */
  owner: z.object({
    id: UserIdSchema,
    nickname: z.string(),
    avatarUrl: z.url().nullable(),
    authStatus: z.enum(['UNVERIFIED', 'VERIFIED']),
  }),
  /**
   * 「最近可租日」= 今天（Asia/Shanghai）之后最早的可用日期；`null` = 未来 90 天内全部被占。
   *
   * #706 不实现档期查询（#707 负责），本字段在 #706 恒为 `null`。端上据此显示
   * 「档期以预约时为准」而不是编造一个日期。
   */
  nextAvailableDate: z.iso.date().nullable(),
})

export type RentalCard = z.infer<typeof RentalCardSchema>

/** 详情在卡片上追加：描述、图片、规则全文、是否本人。 */
export const RentalDetailSchema = RentalCardSchema.extend({
  description: z.string(),
  /**
   * 图片。与 `ListingImageSchema` 字段对齐，但**不暴露** `objectKey` 之外的审核细节：
   * 出租详情对非本人只给 URL（与出售详情同一取舍）。
   */
  images: z.array(
    z.object({
      id: z.string(),
      url: z.url(),
      sortOrder: z.number().int().nonnegative(),
    }),
  ),
  /** 完整规则文字；`null` = 商家没写。端上在押金说明**上方**展示。 */
  rules: RentalRulesSchema,
  /** 服务端计算；匿名恒 `false`。前端据此显示「编辑 / 下架」。 */
  isOwner: z.boolean(),
  updatedAt: z.iso.datetime(),
})

export type RentalDetail = z.infer<typeof RentalDetailSchema>

// ---------------------------------------------------------------------------
// 写模型
// ---------------------------------------------------------------------------

/** 至少 1 张图，与出售发布的图片下限一致（复用同一套 `objectKeys` 约定）。 */
const RENTAL_OBJECT_KEYS = z
  .array(z.string().min(1))
  .min(1, '至少上传 1 张图片')
  .max(9, '最多上传 9 张图片')
  .refine((keys) => new Set(keys).size === keys.length, {
    error: '同一张图片不能重复',
  })

/**
 * 出租发布输入。
 *
 * `.strictObject()`：多余字段 422 而不是静默丢弃（与 `ListingCreateInputSchema` 同一取舍）。
 * **刻意不含 `category` / `listingType`**：
 * - 品类由 M0 冻结为 `DIGITAL`，客户端不能指定（否则「仅数码」这条规则可被绕过）；
 * - `listingType` 由服务端按端点决定，创建后不可互转。
 *
 * 同样**不含** `urgent` / `negotiable` / `free`：那是出售语义，出租没有这三个概念。
 */
export const RentalCreateInputSchema = z
  .strictObject({
    title: z.string().trim().min(2).max(60),
    description: z.string().trim().min(1).max(2000),
    /** 日租单价（整数分）。 */
    dailyPriceCents: RentalDailyPriceCentsSchema,
    depositCents: DepositCentsSchema,
    rules: RentalRulesSchema.optional(),
    minDays: RentalMinDaysSchema,
    maxDays: RentalMaxDaysSchema,
    condition: ListingConditionSchema,
    objectKeys: RENTAL_OBJECT_KEYS,
  })
  .refine((value) => value.maxDays >= value.minDays, {
    path: ['maxDays'],
    error: '最长租期不能短于最短租期',
  })

export type RentalCreateInput = z.infer<typeof RentalCreateInputSchema>

/**
 * 出租编辑（部分更新）。
 *
 * 与出售编辑的关键差异：**不含 `category`**（创建后不可改）、不含 `listingType`。
 * `dailyPriceCents` / `depositCents` / `rules` 任一出现都会让 `termsVersion + 1`。
 */
export const RentalUpdateInputSchema = z
  .strictObject({
    title: z.string().trim().min(2).max(60).optional(),
    description: z.string().trim().min(1).max(2000).optional(),
    dailyPriceCents: RentalDailyPriceCentsSchema.optional(),
    depositCents: DepositCentsSchema.optional(),
    rules: RentalRulesSchema.optional(),
    minDays: RentalMinDaysSchema.optional(),
    maxDays: RentalMaxDaysSchema.optional(),
    condition: ListingConditionSchema.optional(),
    objectKeys: RENTAL_OBJECT_KEYS.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { error: '至少提供一个要修改的字段' })

export type RentalUpdateInput = z.infer<typeof RentalUpdateInputSchema>

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export const RentalSortSchema = z.enum(['newest', 'priceAsc', 'priceDesc'])
export type RentalSort = z.infer<typeof RentalSortSchema>

/**
 * 广场查询。品类**不在查询参数里** —— M0 冻结为仅 `DIGITAL`，给一个恒为 `DIGITAL` 的
 * 筛选项只会误导客户端。
 */
export const RentalFeedQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().optional(),
    sort: RentalSortSchema.default('newest'),
    /** 关键词，匹配标题与描述（与出售 Feed 同一范围）。 */
    q: z.string().trim().min(1).max(50).optional(),
    /** 只列出「能租满 N 天」的商品（`minDays <= N <= maxDays`）。 */
    days: z.coerce.number().int().min(RENTAL_MIN_DAYS).max(RENTAL_MAX_DAYS).optional(),
  })
  .strict()

export type RentalFeedQuery = z.infer<typeof RentalFeedQuerySchema>

export const RentalFeedResponseSchema = z.object({
  items: z.array(RentalCardSchema),
  nextCursor: z.string().nullable(),
})

export type RentalFeedResponse = z.infer<typeof RentalFeedResponseSchema>

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

export const RentalErrorCodeSchema = z.enum([
  /** 403：未通过教育邮箱认证（M0 冻结的出租资格）。 */
  'RENTAL_NOT_ELIGIBLE',
  /** 422：品类不是 DIGITAL（M0 冻结的品类限制）；正常客户端不会触发，是防绕过的兜底。 */
  'RENTAL_CATEGORY_UNSUPPORTED',
  /** 404：出租商品不存在，或对当前查看者不可见（不泄漏存在性）。 */
  'RENTAL_NOT_FOUND',
  /** 403：不是该出租商品的所有者。 */
  'NOT_RENTAL_OWNER',
  /** 409：存在履约中的订单，该字段不可修改（日租价 / 押金）。 */
  'RENTAL_TERMS_LOCKED',
  /** 409：条款已被卖家修改，请重新确认（#707 引入，本单先占位）。 */
  'RENTAL_TERMS_CHANGED',
  /** 422：请求内容未通过审核。 */
  'RENTAL_CONTENT_BLOCKED',
])

export type RentalErrorCode = z.infer<typeof RentalErrorCodeSchema>
