import { z } from 'zod'
import { AuthStatusSchema, MeSchema } from '../auth/user'
import { ListingIdSchema as PublicListingIdSchema, UserIdSchema } from '../system/public-id'

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
 * 被替换掉的公开商品图对象的保留期（#476）。
 *
 * 图片写路径是**全量替换**（`apps/api/src/modules/listings/store.ts` 的 `updateListingAtomic`）：
 * 每次换图，旧 `listings/…` 对象都会从 `listing_images` 摘除，但对象本体留在对象存储里。所以
 * 换图时把旧键登记进 `listing_image_deletions`，worker 在「距最后一次被引用（`removed_at`）
 * 超过本保留期、且确认无任何 `listing_images` 再引用它」之后才真正删除对象。
 *
 * 保留期是给并发/时钟偏移留的安全边际，不是硬承诺；真正的误删防线是删除前的引用复核
 * （见 `apps/worker/src/jobs/listing-image-cleanup.ts`）。
 */
export const LISTING_IMAGE_RETAIN_MS = 24 * 60 * 60 * 1000

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
export const ListingIdSchema = PublicListingIdSchema

/** Exact human reference; never coerce to number (12 digits exceed safe UI conventions). */
export const ListingNoSchema = z.string().regex(/^[1-9][0-9]{11}$/)

/** Exact-number lookup returns only the canonical public resource ID. */
export const ListingNumberLookupResponseSchema = z.strictObject({ id: PublicListingIdSchema })

/**
 * 读响应默认只给拼好的 `url`，不给 `objectKey`：后者是存储实现细节，放进读契约等于把 S3 布局
 * 钉进协议，换 CDN 或换布局都成了破坏性变更。
 *
 * **唯一的例外是卖家本人视角的 `objectKey`**（可选、只在本人视角出现）：被拒商品要能「带着原图
 * 回出物页改一改重新提交」，而写契约只接受 `objectKey`（`ListingCreateInputSchema.objectKeys`），
 * 从 `url` 反推键等于让客户端解析存储布局。这不算新增信息泄漏 —— 那把键本来就是卖家自己上传时
 * 从 `UploadConfirmResponse` 拿到的。
 *
 * 取值口径见 `ListingDetailSchema.images` 的说明：**只在卖家本人视角、且这把键能被重新引用时**才给。
 */
export const ListingImageSchema = z.object({
  url: z.url(),
  sortOrder: z.number().int().nonnegative(),
  /**
   * 仅卖家本人视角，且**这把键当前可被重新引用**时才出现。
   *
   * 为什么需要它：被拒的商品要「带着原图回出物页改一改重新提交」，而写契约只接受
   * `objectKey`（`ListingCreateInputSchema.objectKeys` 是全量替换）。从 `url` 反推键等于让
   * 客户端解析存储布局 —— 而这把键本来就是卖家自己上传时从 `UploadConfirmResponse` 拿到的，
   * 给回本人不算新增泄漏。
   *
   * **缺席即「这张图不能保留」**：被判 BLOCK 的图（人工结算成 BLOCK）不可再引用，
   * 服务端会拒掉带着它的写请求（`IMAGE_CONTENT_BLOCKED`）。客户端据此要求卖家换图，
   * 而不是提交一个注定 422 的表单。
   */
  objectKey: z.string().min(1).optional(),
  /**
   * 仅卖家本人视角：这张图当前的审核结论（`ALLOW → APPROVED` / `REVIEW` / `BLOCK`）。
   *
   * 有了它，「图片不过审」才可操作 —— 否则卖家只知道「整条商品被拒」，不知道 9 张图里该换哪张。
   * 存量键（#286 之前、没有确认台账）没有结论，字段缺席，客户端按「无标记」渲染。
   */
  moderationStatus: ListingModerationStatusSchema.optional(),
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
  /** Present on API cards; old client mock records may omit it. */
  listingNo: ListingNoSchema.optional(),
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
   * 「想要数」= **与该商品已建立会话的买家数**（#74 的来源冻结 + Owner 2026-10-04 拍板：
   * 商品卡上的「N 人想要」就取这个口径）。与 `GET /listings/:id/watchers` 的 `total`
   * **同源同义**——一个是计数、一个是名单，定义都在 `docs/design/issue-74-watchers-definition.md`。
   *
   * 为什么**必填且非空**：这个数在库里恒可算（`conversations` 按 `listing_id` 计数），
   * 不存在「暂时取不到」。写成可空会让 `null` 与真实的 0（确实还没人开过会话）在页面上
   * 长得一样——那正是 #192 之前两个计数整块画不出来、卖家侧只能显示一个恒 0 的原因。
   *
   * 与 `wishes` 域的 `wantCount` **不是一回事**：那个是愿望池里想要某类东西的人数。
   */
  wants: z.number().int().nonnegative(),
  /**
   * 「浏览量」= **最近 30 天内浏览过该商品的去重人数**（#192，Owner 2026-10-10 拍板口径，
   * 裁决记录见 <https://github.com/zzstar101/FISH/issues/192#issuecomment-6095408315>）。
   *
   * 来源是行为事件表 `recommendation_events` 的 `DETAIL_VIEW`（#323 R1 起「点进详情页」就上报
   * 一条）；`packages/db/src/listing-views.ts` 的 `listingViewsCount` 是唯一实现，各读路径的
   * 主查询共用它。去重按身份做 —— `user_id` 与 `anonymous_session_id` 分属两个命名空间，
   * 登录用户按账号、未登录按设备会话，同一个人反复点开只算一次（与「想要数」同为**人数**，
   * 两个数并排画时同量纲。注意裁决用词是「去重人数」，实现上是「去重身份数」：
   * 「先匿名逛、再登录看」会被算成 2，同账号换设备反而合并成 1，取舍见 DB 谓词注释）。
   *
   * **这个数是展示用的弱信号，不参与任何排序 / 推荐 / 风控**：匿名身份由客户端自选
   * （`anonymous_session_id` 是本地随机 uuid），`POST /recommendations/events` 匿名可写，
   * 限流（#323 R6：`RECOMMENDATION_EVENT_RATE_LIMIT` = 容量 120 / 2·s⁻¹）只挡得住突发刷量、
   * 挡不住慢速伪造，因此这个数可以被低成本操纵。要拿它做任何决策，先解决写入口的可伪造性。
   *
   * 五条必须一起读的边界：
   * - **滚动 30 天，不是累计**：事件本身只有 180 天保留期（`RECOMMENDATION_EVENT_RETENTION_DAYS`），
   *   累计浏览在这个系统里没有可依赖的来源。**数字下降是正常的**（旧浏览滚出窗口），不是数据丢了。
   * - **窗口两端都收口**：上界是 `now()` —— 客户端时钟快时会报出「未来」的事件（入站容忍 10 分钟
   *   偏差），它们在时间戳到来前不计入。
   * - **卖家自己看也算**：它是商品级的公开市场信号，与 `wants` 同一取向 —— 一个商品只有一个数，
   *   不按视角给不同的数。已知副作用：发布成功会自动跳详情页，新商品一上架底数天然是「1 浏览」。
   * - **上报失败的那次浏览不计**：事件由客户端上报（离线队列会补发），不是服务端在详情读路径
   *   埋点。所以这个数天然是「上报成功过的去重人数」，不是访问日志。
   * - **读到的是「截至本次请求」的历史人数，不含你自己这一次**：端上是先渲染详情、再上报
   *   `DETAIL_VIEW`（服务端不在读路径里替客户端写事件），所以你打开的那一刻看到的数字不含
   *   本次浏览，要到下一次请求才体现 —— 「进去是 0、返回再进是 1」就是这个语义，不是缓存没刷。
   *
   * 另三条口径边界（"人数"这个词自带的，端上文案不要过度承诺）：
   * - 未登录身份是**设备会话**（本地 180 天 TTL 的随机 id）：换设备 / 清缓存会算成新的一个人；
   * - **两列身份都空的事件归不到人、不计入**。这种行会真实出现（未登录 + 从分享卡片/扫码直接进
   *   详情页，推荐 Feed 从未挂载因而没有会话 id），所以"浏览 0"同时兼容"真没人看"与
   *   "有访客但都没身份" —— 见 `@fish/db/listing-views` 的边界说明。
   * - **「先匿名逛、再登录看」会被算成 2 个人**：身份是逐行取 `user_id`/会话 id（两个命名空间），
   *   匿名那次与登录那次是两个不同的值。同一账号换设备则相反（合并成 1）。取舍与实测见
   *   `@fish/db/listing-views`。
   *
   * 为什么**必填且非空**：与 `wants` 同理 —— 库里恒可算，`0` 是事实（30 天内没有去重访客），
   * 不是「取不到」。写成可空会让「暂时没有这个数」与真实的 0 长得一样，页面只能整块隐藏，
   * 那正是 #192 之前两个计数都画不出来的原因。
   *
   * **必填的代价与部署顺序**：字段必填意味着**所有**产出 `ListingCard` 的读路径都要带出这个计数，
   * 即使端上只有详情页与「我的发布」行展示它（feed / 搜索 / 收藏 / 识图四个画面看不到这个数，
   * 却同样付聚合成本）。这是刻意的取舍：先全量付费、展示面后续再扩，或把 `views` 拆成单独的
   * 卡片契约 —— 需要 Owner 显式点头才动。另外新客户端（小程序）对旧服务端会**硬失败**
   * （`features/listing/api.ts` 的消费点都是 `.parse`），所以部署顺序必须是
   * **先 `apps/api`、再发布小程序**，反过来会让线上旧客户端白屏。
   */
  views: z.number().int().nonnegative(),
  /**
   * 卡片内嵌的卖家公开子集（#191），与详情的 `seller`（`ListingSellerSchema`）**同一口径**：
   * 只有 `id / nickname / avatarUrl / authStatus` 四个公开字段——教育邮箱、学号、手机号、
   * role、密码与微信平台标识一律不进列表投影（#122 的「不泄漏靠没查」同一取向），
   * 且 #86 后没有 campus。
   *
   * **空值策略**：API 卡片**恒带**卖家——`users` 表没有注销 / 删除 / 禁用类列，
   * `listings.seller_id` 外键保证卖家行存在，服务端以 inner join 同源投影（不逐卡补查）。
   * 因此 `null` 不是「卖家已注销」——那个状态当前不存在；字段缺席只表示
   * 「本记录没有卖家信息」（老客户端 mock 记录，与 `listingNo` 的 optional 同一先例）。
   * 客户端不得为缺席编造占位身份。
   */
  seller: ListingSellerSchema.optional(),
  /**
   * 仅**卖家本人**视角非 `null`（公开 Feed / 他人视角恒 `null`，见 `ListingModerationStatusSchema`）。
   * 客户端据此把审核中的商品显示成「审核中」，而不是 `OFFLINE`（已下架）。
   */
  moderationStatus: ListingModerationStatusSchema.nullable(),
  /**
   * 平台（治理）下架标记，仅**卖家本人**视角非 `null`；`true` = 管理员下架（可申诉、可由管理员恢复）。
   *
   * 为什么必须单独给一个字段：治理下架在库里的形态与「内容被审核引擎拒绝」**完全相同**
   * （`status = OFFLINE` + `moderation_status = BLOCKED`，见 `governance/service.ts` 的 delist），
   * 只凭 `moderationStatus` 分不出「平台下架了你的商品」与「你的内容没过审」——
   * 两者的可做动作完全不同（前者等平台处理，后者改内容重新送审），
   * 混成一种会让卖家看到一条被平台下架的商品顶着「不过审」的标签、旁边摆着按下去必然 409 的按钮。
   *
   * 与 `listingNo` 同样取 `.optional()`：老客户端 mock 记录可以不带它，缺省即「不是治理下架」。
   */
  governanceDelisted: z.boolean().nullable().optional(),
  /**
   * 卖家本人可见的**未通过原因**（一句给卖家看的话），只有 `moderationStatus === 'BLOCKED'`
   * 且是本人视角时才有值；其余情形恒 `null`。
   *
   * 为什么现在就给：Owner 2026-09-28 拍板「不过审要在编辑区上方用红字标注原因」——
   * 没有这句话，卖家只知道「被拒了」却不知道改哪里，只能瞎试。
   *
   * 值的来源与口径：
   * - 机器判定 → `moderation_reason` 存的是**规则码**（如 `PROHIBITED_CONTENT`），
   *   客户端映射成一句人话（见 miniapp 的 `listing/moderation-reason.ts`）；
   * - 人工终审 → 管理员填的原因原文（`ModerationDecisionInputSchema.reason`，1–500 字）。
   *
   * 因此它是一个**可能很长**的自由文本：客户端必须截断展示，不能当短标签用。
   * 只给本人，公开 Feed / 他人视角恒 `null` —— 与 `moderationStatus` 同一取向：
   * 平台内部审核结论不是买家该看到的信息（`reports/schema.ts` 里对 `moderationReason`
   * 「只对管理员可见」的注记说的是 admin 端旧口径；本字段是**发给人看的那一句**，不是审计原文）。
   */
  moderationReason: z.string().nullable().optional(),
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
    /**
     * 「免费送」筛选（#451）。
     *
     * **必须是契约的 `free` 布尔位，不能用价格近似**：本文件只约束
     * `free ⟹ priceCents === 0`（见 `ListingCreateInputSchema` 的 refine），反向不成立 ——
     * `free = false && priceCents = 0` 是合法状态，且发布端输入 `0` 不勾「免费送」就能产生它。
     * 用 `priceMinCents=0&priceMaxCents=0` 近似会把这类商品误报成免费送。
     *
     * 缺省 = 不过滤；`false` = 只看**非**免费送（不是「等同缺省」）。
     *
     * 用 `z.enum(['true','false'])` 而不是 `z.coerce.boolean()`：后者把任何非空字符串
     * （含 `"false"`）都判成 `true`，于是 `?free=false` 会静默变成「只看免费送」。
     */
    free: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    sort: ListingSortSchema.default('newest'),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    /**
     * 不透明字符串：服务端对 `(排序键, id)` 编码，前端禁止解析或构造，只能原样回传上一页的值。
     * 用 cursor 而不是 offset：新商品会插到列表最前，offset 翻页必然重复/漏项。
     */
    cursor: z.string().min(1).optional(),
    /** 只允许等于当前用户，传他人坐标由路由层拒绝（403 NOT_LISTING_OWNER）。 */
    sellerId: UserIdSchema.optional(),
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
  /**
   * 服务端生成的 **staging** 键（`listing-media/{userId}/{uuid}.{ext}`），前端视为不透明字符串。
   *
   * #286：这个键只是「待审核的临时对象」，**不能**进 `objectKeys`——`listing-media/` 不在公开读
   * 白名单里，而且 Listing 的引用校验只接受审核固化后的 final 键。可引用的键只能从
   * `UploadConfirmResponseSchema.objectKey` 拿。
   */
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
  /**
   * #286：**审核固化后的 final 键**（`listings/{userId}/{uuid}.{ext}`）——这才是能进
   * `objectKeys` 的那个键。它与 presign 返回的 staging 键**不是同一个字符串**，
   * 前端必须用它回填，不能继续用自己手里那份 presign 响应。
   */
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
  /** 409：治理下架后只能由管理员恢复，卖家不能自行修改或上架。 */
  'LISTING_GOVERNANCE_BLOCKED',
  /**
   * 409：物理删除只对「不过审」（`OFFLINE` + `BLOCKED`）且没有交易记录的商品开放
   * （Owner 2026-09-28 拍板）。审核中要等审核结论，其余状态各有去处，
   * 带交易记录的商品连着成交凭证，都不能整行删除。
   */
  'LISTING_NOT_DELETABLE',
  /** 422：objectKey 前缀不属于本人。（同一 key 重复由 schema 的 refine 先掳下，报 VALIDATION_FAILED。） */
  'IMAGE_REFERENCE_INVALID',
  /** 422：confirm 时对象存储里找不到该对象。 */
  'UPLOAD_OBJECT_MISSING',
  /**
   * 422：confirm 时图片被内容安全审核判定为阻断（BLOCK）。
   * 对象**不会**被固化到可引用前缀，因此这张图无法进入任何 Listing 的 `objectKeys`。
   */
  'IMAGE_CONTENT_BLOCKED',
  /** 400：审核上游判定输入本身不合法（图片缺失 / 超限），confirm 无法完成。 */
  'CONTENT_MODERATION_INVALID_INPUT',
  /** 503：内容安全服务不可用（超时 / 网络 / 上游错误），图片未固化、不可引用；可稍后重试。 */
  'CONTENT_MODERATION_UNAVAILABLE',
  /** 422：标题或描述命中服务端阻断规则。 */
  'LISTING_CONTENT_BLOCKED',
  /** 202：内容需要人工复核，商品不会进入公开列表。 */
  'LISTING_CONTENT_REVIEW',
  /** 429：完整 12 位编号查询超过每主体 60 秒 50 次。 */
  'LISTING_LOOKUP_RATE_LIMITED',
  /** 503：匿名来源不可验证，拒绝计入共享或伪造的 IP 配额。 */
  'LISTING_LOOKUP_IP_UNAVAILABLE',
])

export type ListingErrorCode = z.infer<typeof ListingErrorCodeSchema>
