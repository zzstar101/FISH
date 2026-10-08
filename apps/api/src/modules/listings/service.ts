import {
  ALLOWED_IMAGE_MIME,
  type ListingCard,
  type ListingCreateInput,
  type ListingDetail,
  ListingDetailSchema,
  type ListingErrorCode,
  type ListingFeedQuery,
  type ListingFeedResponse,
  ListingFeedResponseSchema,
  type ListingModerationStatus,
  type ListingSeller,
  type ListingUpdateInput,
  listingObjectKeyPrefix,
  MAX_IMAGE_BYTES,
} from '@fish/contracts/listings/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { newId } from '@fish/db/ids'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createLocalContentModerationProvider } from '../moderation/providers/local'
import {
  aggregateModerationDecision,
  ContentModerationError,
  type ContentModerationProvider,
  type FieldModerationResult,
  moderationErrorResponse,
  type TextModerationResult,
} from '../moderation/providers/types'
import type { ModerationDecision, ModerationField } from '../moderation/types'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { isLegacyListingKey } from '../uploads/legacy-url'
import { type ConfirmedImageLookup, effectiveModerationDecision } from '../uploads/media-objects'
import { isListingReviewMediaKey, listingReviewMediaPrefix } from '../uploads/review-media'
import { isListingMediaStagingKey, isPublicListingKey, type MediaStorage } from '../uploads/storage'
import type { ListingCardSeller } from './card'
import { toListingCard } from './card'
import { decodeCursor, encodeCursor, isCursorTimestamp } from './cursor'
import type {
  FeedCursorKey,
  FeedEntry,
  ListingImageRow,
  ListingRow,
  ListingState,
  ListingStore,
  ListingUpdateResult,
  ModerationTrace,
} from './store'
import { LOCKED_LISTING_STATUSES } from './store'

/**
 * 业务规则失败 → 契约 §3 的错误码表。带上 `details` 是为了让路由层直接落成
 * `VALIDATION_FAILED` 的字段级错误，而不是让调用方自己猜是哪个字段。
 */
export class ListingServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422 | 503,
    readonly code: ListingErrorCode | 'VALIDATION_FAILED',
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'ListingServiceError'
  }
}

/** 与 #7 已合并的实现同一个窗口（apps/api/src/modules/wishes/service.ts）。 */
const DUPLICATE_WINDOW_MS = 5_000

/**
 * #228：UPDATE 的 CAS 冲突重试上限。每次重试都要**重新调 provider**（内容可能已经变了），
 * 因此必须有界；到顶就返回 409 让客户端重试，绝不把旧审核结论写回去。
 */
const UPDATE_REVIEW_ATTEMPTS = 3

const OFFLINE: ListingStatusValue = 'OFFLINE'
const ACTIVE: ListingStatusValue = 'ACTIVE'

type ListingStatusValue = ListingRow['status']

type ListingFeedCriteria = Omit<ListingFeedQuery, 'sellerId'> & { sellerId?: string }

export interface ListingService {
  listFeed(viewerId: string | null, query: ListingFeedCriteria): Promise<ListingFeedResponse>
  /**
   * 按 id 批量取**公开可见**的卡片（#323 R4 推荐 Feed 的读路径）。
   *
   * 返回 `Map<listingId, card>`，**插入顺序与 `ids` 一致**（推荐顺序由排序层给出，不是 SQL 的
   * `ORDER BY`）。用 `Map` 而不是数组，是因为调用方同时需要"顺序"（快照 position 必须与返回值
   * 下标一致）和"哪些 id 没回来"（此刻已不可见的商品要从快照里剔除、后续位置顺延）；不可见或不
   * 存在的 id 被静默跳过，所以调用方不该假设"返回条数 = 请求条数"。视角固定为公开 Feed：不带
   * 审核态 / 治理标记 / 未通过原因（那些只有卖家查自己才给，见 `listFeed`）。
   */
  listCardsByIds(viewerId: string | null, ids: string[]): Promise<Map<string, ListingCard>>
  getDetail(viewerId: string | null, id: string): Promise<ListingDetail>
  createListing(
    userId: string,
    input: ListingCreateInput,
  ): Promise<{ created: boolean; detail: ListingDetail }>
  updateListing(userId: string, id: string, input: ListingUpdateInput): Promise<ListingDetail>
  /** 下架（ACTIVE → OFFLINE）与重新上架（OFFLINE → ACTIVE），幂等。 */
  transition(userId: string, id: string, to: 'OFFLINE' | 'ACTIVE'): Promise<ListingDetail>
  /**
   * 物理删除（Owner 2026-09-28 拍板：「不过审」的商品直接清除、不保留痕迹）。
   * 删除口径与连带清理都在 `store.deleteListingAtomic` 的一个事务里，成功无返回体。
   */
  deleteListing(userId: string, id: string): Promise<void>
}

/** 契约 §1 的 `free ⟹ priceCents = 0` 在库里的约束名（见 `packages/db/src/schema/listings.ts`）。 */
const FREE_PRICE_CONSTRAINT = 'listings_free_price_cents_zero'

/**
 * 判断错误是否为**那一条** CHECK 约束冲突。
 *
 * 探测方式与 `apps/api/src/modules/auth/service.ts` 的 `isUniqueViolation` 同构：Bun 的
 * `PostgresError` 把 SQLSTATE 放在 `errno` 上（`code` 恒为 `'ERR_POSTGRES_SERVER_ERROR'`），
 * Drizzle 又会把它包一层（`{ query, params, cause }`），所以要顺着 `cause` 链找。
 *
 * 但**不能只看 23514**：`listings` 上还有 `listings_price_cents_non_negative`、
 * `listing_images_sort_order_non_negative` 等 CHECK，将来还会有新的。逐个比对约束名，
 * 别的约束冲突照旧上抛（500），不会被错报成"0 元送价格必须为 0"。
 * 驱动不再暴露 `constraint` 时同样返回 false —— 宁可是 500，也不要给前端一个错误的字段级错误。
 */
function isFreePriceConstraintViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if ('errno' in current && current.errno === '23514') {
      return 'constraint' in current && current.constraint === FREE_PRICE_CONSTRAINT
    }
    current = current.cause
  }
  return false
}

/**
 * `deps.mediaObjects` 缺省时的实现：没有任何一张图能被证明"已确认"，新形态键因此一律被拒
 * （fail closed），而不是静默放过。生产接线在 `apps/api/src/app.ts` 显式注入真实实现。
 */
const NO_CONFIRMED_IMAGES: ConfirmedImageLookup = {
  findConfirmedFinalKey: async () => null,
  findByFinalKey: async () => null,
}

/** create 时商品还不存在，图片组必然是空的：没有任何"没变的老图片"可以豁免确认校验。 */
const NO_STORED_KEYS: ReadonlySet<string> = new Set()

/**
 * `deps.pendingImageDeletions` 缺省时的实现：没有任何键被证明"在待删台账里"，因此这道守卫
 * 不生效（退化为 #476 之前的行为）。生产接线在 `apps/api/src/app.ts` 注入真实实现。
 */
const NO_PENDING_DELETIONS: PendingImageDeletions = { isPending: async () => false }

/** #476：判断一个图片键是否已被摘除、正在等待回收（拒绝重新引用它，见 `assertUsableObjectKeys`）。 */
export interface PendingImageDeletions {
  isPending(objectKey: string): Promise<boolean>
}

export function createListingService(deps: {
  store: ListingStore
  storage: MediaStorage
  /**
   * #286：图片审核确认表（`listing_media_objects`）。给了它，`listings/` 前缀的图片引用就必须
   * 命中一行"已确认"记录；**不给就等于没有任何一行记录能被证明已确认**，新形态的图片键因此一律
   * 被拒（fail closed，见 `assertUsableObjectKeys`）。历史遗留键（裸 UUID 前缀）不受影响。
   */
  mediaObjects?: ConfirmedImageLookup
  /**
   * #476：待删图片键查询。给了它，写路径会拒绝**重新引用一个已被摘除、等待回收的公开键**
   * （见 `assertUsableObjectKeys`）；缺省视为"永不待删"（生产接线在 `apps/api/src/app.ts` 注入）。
   */
  pendingImageDeletions?: PendingImageDeletions
  /**
   * #228：文本审核 provider。app.ts 按 `CONTENT_MODERATION_TRANSPORT` 注入（local / tencent）；
   * 缺省用**本地 provider**（复用同一份词表，与旧同步实现行为一致），生产由 env 保证不会落到 local。
   */
  moderationProvider?: ContentModerationProvider
  /** 可注入时钟：去重窗口的边界断言不需要 sleep。 */
  now?: () => Date
}): ListingService {
  const { store, storage } = deps
  const mediaObjects = deps.mediaObjects ?? NO_CONFIRMED_IMAGES
  const pendingDeletions = deps.pendingImageDeletions ?? NO_PENDING_DELETIONS
  const moderationProvider = deps.moderationProvider ?? createLocalContentModerationProvider()
  const now = deps.now ?? (() => new Date())

  /**
   * #228：文本审核。provider 异常一律 fail-closed：转成 400/503，**绝不返回 ALLOW**。
   * 本地 provider 走同一接口，因此开发/测试行为与旧同步词表一致。
   */
  async function moderateListingText(input: {
    dataId: string
    title: string
    description: string
  }): Promise<TextModerationResult> {
    try {
      return await moderationProvider.moderateText({
        dataId: input.dataId,
        fields: [
          { field: 'title', value: input.title },
          { field: 'description', value: input.description },
        ],
      })
    } catch (error) {
      if (error instanceof ContentModerationError) {
        const mapped = moderationErrorResponse(error)
        throw new ListingServiceError(
          mapped.status,
          mapped.code,
          mapped.status === 400 ? '内容不符合审核要求' : '内容安全审核服务暂不可用，请稍后重试',
        )
      }
      throw error
    }
  }

  function notFound(): ListingServiceError {
    return new ListingServiceError(404, 'LISTING_NOT_FOUND', '商品不存在或不可见')
  }

  /**
   * 卖家资料的对外投影。`avatarUrl` 在库里是无约束 `text`，契约声明它是 `z.url()`：
   * 值域外的历史值降级为 `null`，否则整条详情会因为一个脏字段解析失败
   * 而 500（与 `apps/api/src/modules/auth/service.ts` 的 `toMe` 同一取舍）。
   * #86 F：校区已从产品与数据模型整体移除，卖家投影不再有任何校区字段。
   */
  function toSeller(row: {
    id: string
    nickname: string
    avatarUrl: string | null
    authStatus: 'UNVERIFIED' | 'VERIFIED'
  }): ListingSeller {
    return {
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.id),
      nickname: row.nickname,
      avatarUrl: publicAvatarUrl(row.avatarUrl),
      authStatus: row.authStatus,
    }
  }

  /**
   * 卡片映射抽到 `card.ts`：#8 的 `/matches` 也要给同一张卡片，两处各写一份必然漂移。
   *
   * 后三个参数是**卖家本人视角的内部状态**（审核态 / 治理下架 / 未通过原因）：只有查自己时才传真值，
   * 公开 Feed 与查他人一律省掉（→ `null`）。见 `card.ts` 的说明。
   */
  function toCard(
    listing: ListingRow,
    coverObjectKey: string | null,
    seller: ListingCardSeller,
    wants: number,
    moderationStatus: ListingModerationStatus | null = null,
    governanceDelisted: boolean | null = null,
    moderationReason: string | null = null,
  ): ListingCard | null {
    // `ListingRow` 不带卖家列；feed 的 join 结果里单独取（见 `store.listFeed`），
    // 与 matching / profile / users 三处经 `ListingCardSource.seller` 同一形状。
    // `wants` 同理：`listings` 表不存计数，由主查询带出来（见 store 里的 `listingWantsCount`）。
    return toListingCard(
      { ...listing, seller, wants },
      coverObjectKey,
      storage,
      moderationStatus,
      governanceDelisted,
      moderationReason,
    )
  }

  /**
   * 详情里的图片组。**只有卖家本人**才带 `objectKey` 与 `moderationStatus`（见契约 `ListingImageSchema`）：
   * - `objectKey` 让「被拒商品带着原图回出物页改一改重提交」成为可能（写契约只接受键，编辑态因此
   *   也能像新建态一样增删图）；
   * - `moderationStatus` 让卖家知道 9 张图里该换哪一张。
   *
   * 唯一的例外是**被判 BLOCK 的图**（含人工结算成 BLOCK 的）：它不可再引用，服务端会拒掉带着它的
   * 写请求，所以两个字段都不给 —— 客户端据此要求换图，而不是提交一个注定 422 的表单。
   * 存量键（#286 之前的裸 UUID / seed 键）没有台账行，**结论未知但可以保留**：键照给，只是没有标记。
   *
   * 逐张查台账（≤9 次点查）：这些键本来就是本商品图片组里的，`findByFinalKey` 是唯一索引点查。
   */
  async function toDetailImages(
    images: readonly ListingImageRow[],
    /** 非 null = 本人视角（调用方已判定）；值是卖家自己的 userId，用于核对台账行归属 */
    ownerId: string | null,
  ): Promise<ListingDetail['images']> {
    if (ownerId === null) {
      return images.map((image) => ({
        url: storage.publicUrl(image.objectKey),
        sortOrder: image.sortOrder,
      }))
    }
    return Promise.all(
      images.map(async (image) => {
        const base = { url: storage.publicUrl(image.objectKey), sortOrder: image.sortOrder }
        /*
         * 服务端固化过的两类键（公开 `listings/…` 与私有 `listing-review-media/…`）才有台账行；
         * #286 之前的存量键没有记录 —— 但它们**仍然可以原样回传**：写路径的引用校验对
         * `storedKeys` 里的老键豁免"审没审过"这一层（见 `assertUsableObjectKeys`）。
         * 所以结论未知不等于不可保留，这里照样给 `objectKey`，只是不给结论。
         */
        const canonical =
          isPublicListingKey(image.objectKey) || isListingReviewMediaKey(image.objectKey)
        const row = canonical ? await mediaObjects.findByFinalKey(image.objectKey) : null
        if (row && row.userId !== ownerId) {
          // 台账行不属于本人：这条商品引用了别人的图（脏数据）。不给键，让卖家重选。
          return base
        }
        // 被判 BLOCK 的图不可再引用：不给 objectKey —— 客户端据此要求换图，
        // 而不是提交一个必然被 `IMAGE_CONTENT_BLOCKED` 拒掉的表单。
        if (row && effectiveModerationDecision(row) === 'BLOCK') return base
        return {
          ...base,
          objectKey: image.objectKey,
          ...(row
            ? {
                moderationStatus:
                  effectiveModerationDecision(row) === 'ALLOW'
                    ? ('APPROVED' as const)
                    : ('REVIEW' as const),
              }
            : {}),
        }
      }),
    )
  }

  async function toDetail(input: {
    listing: ListingRow
    seller: {
      id: string
      nickname: string
      avatarUrl: string | null
      authStatus: 'UNVERIFIED' | 'VERIFIED'
    }
    images: ListingImageRow[]
    wants: number
    viewerId: string | null
  }): Promise<ListingDetail> {
    // 封面只认 0 号图（#6 契约 §1「下标即 sortOrder（0 = 封面）」），与 feed / profile /
    // matching / conversations / transactions 五处读模型同口径：缺 0 号图 → null。
    // 不能退化成「最小 sort_order」——store 按 `ORDER BY sort_order ASC` 返回，
    // `images[0]` 恰好就是最小那张；那条口径分叉会让同一份数据在详情与 feed 上
    // 给出两个不同结论（#47）。注意 `images[]` 仍返回全部图：详情页画廊读的是它
    // （detail-page.tsx 按 sortOrder 排序渲染），不受封面口径影响。
    const cover = input.images.find((image) => image.sortOrder === 0)
    const isOwner = input.viewerId === input.listing.sellerId
    const detail = {
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, input.listing.id),
      listingNo: input.listing.listingNo.toString(),
      title: input.listing.title,
      priceCents: input.listing.priceCents,
      category: input.listing.category,
      condition: input.listing.condition,
      status: input.listing.status,
      urgent: input.listing.urgent,
      negotiable: input.listing.negotiable,
      free: input.listing.free,
      coverUrl: cover ? storage.publicUrl(cover.objectKey) : null,
      createdAt: input.listing.createdAt.toISOString(),
      // 想要数对**所有**视角都出（不像审核态那样只给本人）：它是公开的市场信号，
      // 买家的详情页也要画「N 人想要」（见契约 `ListingCardSchema.wants`）。
      wants: input.wants,
      description: input.listing.description,
      images: await toDetailImages(input.images, isOwner ? input.listing.sellerId : null),
      seller: toSeller(input.seller),
      isOwner,
      // 审核态只给卖家本人：买家看到的商品本来就只可能是 APPROVED，
      // 返回真实值等于白送一个内部状态字段（见契约 `ListingModerationStatusSchema`）。
      moderationStatus: isOwner ? input.listing.moderationStatus : null,
      // 治理下架标记同理只给本人（见契约 `governanceDelisted`）。
      governanceDelisted: isOwner ? input.listing.governanceDelistedAt !== null : null,
      /*
       * 未通过原因只给本人，且只在**真的被拒**时给（见契约 `moderationReason`）：
       * `REVIEW` 是"还没结论"，把机器规则码当原因摆出来会让卖家以为已经判了。
       * 值是原始文本 —— 机器判定是规则码（`PROHIBITED_CONTENT`），人工终审是管理员填的原话，
       * 客户端负责把前者映射成人话并截断（见 miniapp 的 `listing/moderation-reason.ts`）。
       */
      moderationReason:
        isOwner && input.listing.moderationStatus === 'BLOCKED'
          ? input.listing.moderationReason
          : null,
      updatedAt: input.listing.updatedAt.toISOString(),
    }

    // 详情没有"跳过"这个选项：解析不过说明这一行与契约不符，宁可 500 也不要静默返回
    // 一个缺字段的详情（前端会按契约直接取字段）。
    const parsed = ListingDetailSchema.safeParse(detail)
    if (!parsed.success) {
      console.error('[listings] 详情无法映射为契约', input.listing.id, parsed.error.message)
      throw new Error('商品数据与契约不符')
    }
    return parsed.data
  }

  async function loadDetail(viewerId: string | null, id: string): Promise<ListingDetail> {
    const found = await store.findDetail(id)
    if (!found) throw notFound()
    // OFFLINE 对非卖家 404（不是 403）：403 等于确认"这个 id 存在且是别人的商品"。
    if (
      (found.listing.status === OFFLINE || found.listing.moderationStatus !== 'APPROVED') &&
      found.listing.sellerId !== viewerId
    )
      throw notFound()

    // `toDetail` 现在是异步的（本人视角要逐张查图片台账给 `objectKey` / 图片结论）
    return toDetail({
      listing: found.listing,
      seller: found.seller,
      images: found.images,
      wants: found.wants,
      viewerId,
    })
  }

  /**
   * 写入前的图片校验。分两类错误码：
   * - 对象不存在 → `UPLOAD_OBJECT_MISSING`（多半是前端没传完就提交）；
   * - 键还在 staging 前缀 / 前缀不属于本人 / 图片没有确认记录 / 超出大小或 mime →
   *   `IMAGE_REFERENCE_INVALID`（引用了不该引用的对象）。
   *
   * 归属只靠前缀，不需要新表（契约 §2.3）；但"这张图审没审过"只能查 `listing_media_objects`
   * （#286）：BLOCK 的图不固化，确认表里因此不存在它的 final 键，"被阻断的图不能被 Listing
   * 引用"由此成立。大小与 mime 仍要在这里查真实对象，因为 presign 的签名只覆盖 `host`、
   * mime 不受约束（契约 §7.7）。
   *
   * `storedKeys` 是这条商品**当前**已存的图片键（create 传空集）：编辑时"没变的老图片"会带着既有
   * 键回传（#286 要求），而它们只在当初写入时校验过一次 —— 确认记录那一层因此对它们豁免（#286 之前
   * 的存量图根本没有记录，否则存量商品的编辑保存会被一律拒掉）。归属与格式仍然照旧校验：豁免的只是
   * "这张图审没审过"，不是"这能不能引用别人的对象"。新增的键仍然必须走完 confirm。
   *
   * 返回值是每张已确认图片的审核结论：调用方把它与文本结论聚合，`REVIEW` 图会把整条商品
   * 压进人工队列（`aggregateModerationDecision`，ALLOW < REVIEW < BLOCK）。
   */
  async function assertUsableObjectKeys(
    userId: string,
    objectKeys: string[],
    storedKeys: ReadonlySet<string>,
  ): Promise<ModerationDecision[]> {
    const publicPrefix = `listings/${encodePublicId(PUBLIC_ID_PREFIX.user, userId)}/`
    // #286 复审 blocker 2：`REVIEW` 图片固化在私有的 `listing-review-media/`（不在匿名白名单里），
    // 由签名代理读取。它对卖家来说是**正常的**可引用键：商品要带着审核中的图进人工队列，管理员才能
    // 看到这张图并做出结论（`admin/service.ts` 用 `storage.publicUrl` 取签名 URL）。
    const reviewPrefix = listingReviewMediaPrefix(userId)
    const currentLegacyPrefix = listingObjectKeyPrefix(userId)
    const prefixes = objectKeys.every(
      (key) => key.startsWith(publicPrefix) || key.startsWith(reviewPrefix),
    )
      ? [currentLegacyPrefix]
      : [currentLegacyPrefix, ...(await store.legacyUserIds(userId)).map(listingObjectKeyPrefix)]

    for (const objectKey of objectKeys) {
      // staging 键既能过"是自己前缀"，也能过对象存在性 —— 但它的内容**没有**经过审核固化。
      // 先单独拦一道，给出比"不属于当前用户"更准确的原因：客户端必须回填 confirm 返回的 final 键。
      if (isListingMediaStagingKey(objectKey)) {
        throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片尚未通过审核，请使用上传确认后返回的图片标识' },
        ])
      }
      if (
        !(isPublicListingKey(objectKey) && objectKey.startsWith(publicPrefix)) &&
        !(isListingReviewMediaKey(objectKey) && objectKey.startsWith(reviewPrefix)) &&
        !(isLegacyListingKey(objectKey) && prefixes.some((prefix) => objectKey.startsWith(prefix)))
      ) {
        throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片不属于当前用户' },
        ])
      }
    }

    const decisions: ModerationDecision[] = []
    // 逐张校验：≤9 次 HEAD，换掉"客户端可以拿 presign 传任意类型"的洞（契约 §7.7）。
    for (const objectKey of objectKeys) {
      // #476：已被摘除、等待回收的公开键**不能被重新引用**。写路径的登记与回收任务的复核/删除之间
      // 有一个窗口，若允许重新引用，回收会删掉一个刚被引用回来的对象、留下坏图。正常前端拿不到
      // 已摘除的键（编辑态只下发当前图片组里的键），所以这条只挡构造请求。
      // `storedKeys` 里的键是本商品图片组里没变的老图，**豁免**：多条商品共享同一个键时，一条摘除它、
      // 另一条仍持有它，后者编辑（`objectKeys` 带上它）不能被误拒——那时该键仍被引用，回收本来也不会删。
      if (
        isPublicListingKey(objectKey) &&
        !storedKeys.has(objectKey) &&
        (await pendingDeletions.isPending(objectKey))
      ) {
        throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
          { field: 'objectKeys', message: '图片已不可用，请重新上传' },
        ])
      }
      // 两类服务端固化键都必须命中一行确认记录（#286）：机器 `ALLOW` 的公开键，以及审核中的私有键。
      // 没有记录 = 没走完 confirm，或当初被判 BLOCK（BLOCK 不固化、不落可引用键）。历史遗留键是
      // #286 之前的存量数据，本来就没有对应记录；`storedKeys` 里的键是本商品图片组里没变的老图，
      // 写入时已经校验过（它们的归属与格式仍由上面的前缀校验 + stat 守住）。
      if (isPublicListingKey(objectKey) || isListingReviewMediaKey(objectKey)) {
        // 用原始行而不是 `findConfirmedFinalKey`：后者对"有效结论 = BLOCK"与"没有记录"都返回 null，
        // 而这里必须区分 —— 人工结算成 BLOCK 的图仍躺在商品图片组里（商品已下架），一旦被当成
        // "没有记录"就会走 `storedKeys` 豁免，等于让一次纯文本编辑洗掉人工 BLOCK。
        const row = await mediaObjects.findByFinalKey(objectKey)
        const decision = row && row.userId === userId ? effectiveModerationDecision(row) : null
        if (decision === 'BLOCK') {
          throw new ListingServiceError(422, 'IMAGE_CONTENT_BLOCKED', '图片内容未通过审核', [
            { field: 'objectKeys', message: '图片内容未通过审核' },
          ])
        }
        if (decision !== null) {
          decisions.push(decision)
        } else if (!storedKeys.has(objectKey)) {
          throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片引用无效', [
            { field: 'objectKeys', message: '图片尚未通过审核' },
          ])
        }
      }

      const stat = await storage.stat(objectKey)
      if (!stat) {
        throw new ListingServiceError(422, 'UPLOAD_OBJECT_MISSING', '图片尚未上传完成', [
          { field: 'objectKeys', message: '图片尚未上传完成' },
        ])
      }
      if (stat.size > MAX_IMAGE_BYTES || !isAllowedMime(stat.contentType)) {
        throw new ListingServiceError(422, 'IMAGE_REFERENCE_INVALID', '图片格式或大小不符合要求', [
          { field: 'objectKeys', message: '图片格式或大小不符合要求' },
        ])
      }
    }

    return decisions
  }

  /**
   * 编辑不带 `objectKeys` = 图片整组不变（契约：`objectKeys` 是**全量替换**，缺省即保持原图）。
   * 图片内容没变，图片结论就不该变：按库里现有的图片键回读确认记录，把它们重新并入聚合结论。
   *
   * 不做这一步的后果是"一次纯文本编辑就能把图片 REVIEW 洗掉"：`moderation_status` 从 REVIEW 回到
   * APPROVED，商品从管理员的人工队列里消失（`admin/store.ts` 按 `moderation_status = 'REVIEW'` 取
   * 队列），卖家再调一次上架接口就能让未审核的图片公开。这与文本侧的口径一致 —— 编辑总是对**当前
   * 内容**重算结论，而不是只看请求里带了什么。
   *
   * 存量图（#286 之前的键、或没有确认记录的键）按"未知"处理、不参与聚合，保持原有行为。
   */
  async function imageDecisionsOfStoredKeys(
    userId: string,
    storedKeys: readonly string[],
  ): Promise<ModerationDecision[]> {
    const decisions: ModerationDecision[] = []
    for (const objectKey of storedKeys) {
      if (!isPublicListingKey(objectKey) && !isListingReviewMediaKey(objectKey)) continue
      // 同样用原始行：有效结论为 BLOCK 的老图必须继续把整条商品压住（推入 BLOCK 让聚合结果为
      // BLOCK），而不是因为查不到"可引用记录"被跳过。
      const row = await mediaObjects.findByFinalKey(objectKey)
      if (row && row.userId === userId) decisions.push(effectiveModerationDecision(row))
    }
    return decisions
  }

  return {
    async listFeed(viewerId, query) {
      // `status` 只在同时给 `sellerId` 时被 schema 接受；到这里还要确认查的是**自己**，
      // 否则任何人都能 `?status=SOLD` 拉全站已售商品（契约 §2.1）。
      if (query.sellerId !== undefined && query.sellerId !== viewerId) {
        throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能查看自己指定状态的商品')
      }
      // 防御纵深（评审 D3）：`status` 必须与 `sellerId` 同时出现。
      // 契约里这条只由 schema 的 refine 守着，而 router 之外（内部调用 / 将来重构）绕进本函数
      // 就能拿到全站 OFFLINE / RESERVED / SOLD 列表。这里与 schema 保持**同一个错误码**
      // （422 VALIDATION_FAILED），免得同一非法输入在两个层给出不同结论。
      if (query.status !== undefined && query.sellerId === undefined) {
        throw new ListingServiceError(422, 'VALIDATION_FAILED', 'status 必须与 sellerId 一起使用', [
          { field: 'status', message: 'status 必须与 sellerId 一起使用' },
        ])
      }

      const cursor = decodeFeedCursor(query.cursor, query.sort)
      // 卖家查自己且未指定 status ⇒ 不按状态过滤（「我发布的」要包含 OFFLINE / RESERVED / SOLD）。
      // 公开 Feed 仍固定 ACTIVE（不传 status 时缺省）——不这样做就不能既满足
      // 「我发布的含 REVIEW」又不把全站 OFFLINE 商品泄露出去。
      const ownSellerQuery = query.sellerId !== undefined && query.sellerId === viewerId
      const status = query.status ?? (ownSellerQuery ? undefined : ACTIVE)

      const rows = await store.listFeed({
        limit: query.limit,
        cursor,
        sort: query.sort,
        // `exactOptionalPropertyTypes`：字段声明为可选，不能显式传 undefined。
        ...(status ? { status } : {}),
        search: query.q,
        category: query.category,
        priceMinCents: query.priceMinCents,
        priceMaxCents: query.priceMaxCents,
        free: query.free,
        sellerId: query.sellerId,
        // 本人查询自己的商品时包含未通过审核的（REVIEW / BLOCKED），在前端展示"审核中"等状态；
        // 公开 Feed、匹配、他人详情继续严格过滤。此处 authorize 已达：query.sellerId !== viewerId 抛 403。
        includeUnapproved: ownSellerQuery,
      })

      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      const items: ListingCard[] = []
      for (const entry of page) {
        // 只有「查自己」的列表带审核态 / 治理标记 / 未通过原因；公开 Feed 与查他人都是 null
        // （见 `toListingCard`）。未通过原因同样只在真的被拒时给（`REVIEW` 是"还没结论"）。
        const card = toCard(
          entry.listing,
          entry.coverObjectKey,
          entry.seller,
          entry.wants,
          ownSellerQuery ? entry.listing.moderationStatus : null,
          ownSellerQuery ? entry.listing.governanceDelistedAt !== null : null,
          ownSellerQuery && entry.listing.moderationStatus === 'BLOCKED'
            ? entry.listing.moderationReason
            : null,
        )
        if (card) items.push(card)
      }

      // 游标基于**最后一条已返回**的行，而不是 limit+1 那一条：否则会漏掉一个商品。
      const last = page.at(-1)
      const nextCursor =
        hasMore && last
          ? encodeCursor({ sortKey: cursorKeyOf(last, query.sort), id: last.listing.id })
          : null

      return ListingFeedResponseSchema.parse({ items, nextCursor })
    },

    async listCardsByIds(viewerId, ids) {
      if (ids.length === 0) return new Map<string, ListingCard>()

      const entries = await store.findCardsByIds(ids, { viewerUserId: viewerId })
      const byId = new Map(entries.map((entry) => [entry.listing.id, entry]))

      const cards = new Map<string, ListingCard>()
      // 按**调用方给的顺序**（推荐排序结果）输出，不是 DB 返回顺序：快照里的 position 必须与这里
      // 的插入顺序一致，否则服务端归因真值就错了。查不到的 id 跳过（此刻已不可见）。
      for (const id of ids) {
        const entry = byId.get(id)
        if (entry === undefined) continue
        const card = toCard(entry.listing, entry.coverObjectKey, entry.seller, entry.wants)
        if (card) cards.set(id, card)
      }
      return cards
    },

    getDetail(viewerId, id) {
      return loadDetail(viewerId, id)
    },

    async createListing(userId, input) {
      // #228：文本审核走异步 provider（腾讯 TMS / 本地词表），**在事务外**完成。
      // `dataId` 用本次要落库的商品公开 id，便于按业务对象追溯上游 RequestId。
      const listingId = newId()
      const moderationResult = await moderateListingText({
        dataId: encodePublicId(PUBLIC_ID_PREFIX.listing, listingId),
        title: input.title,
        description: input.description,
      })
      if (moderationResult.decision === 'BLOCK') {
        await recordModeration(store, {
          sellerId: userId,
          action: 'CREATE',
          title: input.title,
          description: input.description,
          result: moderationResult,
        })
        throw new ListingServiceError(
          422,
          'LISTING_CONTENT_BLOCKED',
          '商品内容未通过审核',
          moderationBlockDetailsOf(moderationResult),
        )
      }

      const imageDecisions = await assertUsableObjectKeys(userId, input.objectKeys, NO_STORED_KEYS)
      // 图片结论与文本结论取最严的一档（ALLOW < REVIEW < BLOCK，见 aggregateModerationDecision）：
      // 只要有一张图是 REVIEW，整条商品就进人工队列。图片侧给不出 BLOCK —— 被判 BLOCK 的图不固化、
      // 确认表里根本没有它的键，所以上面的引用校验早就拒了；BLOCK 只可能来自文本，且已经拦下。
      // 这里仍然显式挡一次：聚合结果绝不能掉进下面的 `APPROVED` 分支。
      const decision = aggregateModerationDecision([moderationResult.decision, ...imageDecisions])
      if (decision === 'BLOCK') {
        throw new ListingServiceError(422, 'IMAGE_CONTENT_BLOCKED', '图片内容未通过审核', [
          { field: 'objectKeys', message: '图片内容未通过审核' },
        ])
      }

      const result = await store.createListingAtomic({
        id: listingId,
        sellerId: userId,
        title: input.title,
        description: input.description,
        priceCents: input.priceCents,
        condition: input.condition,
        category: input.category,
        urgent: input.urgent,
        negotiable: input.negotiable,
        free: input.free,
        objectKeys: input.objectKeys,
        duplicateWindowStart: new Date(now().getTime() - DUPLICATE_WINDOW_MS),
        moderationStatus: decision === 'REVIEW' ? 'REVIEW' : 'APPROVED',
        // 对外只给既有安全码，绝不透出腾讯 Label/Score/命中策略（#228 §6）。
        moderationReason: moderationReasonCodeFor(decision),
        moderationRuleVersion: moderationResult.policyVersion,
        moderation: {
          // 落库的结论是**整条商品**的结论（可能由某张 REVIEW 图抬上来），不只是文本那一档。
          decision,
          // 本地词表时代的命中规则/脱敏词条对腾讯 provider 没有对应物：审计改看下面这组
          // provider 字段（#228 §6），这里保持空数组（列本身 NOT NULL）。
          matchedRules: [],
          matchedTermsMasked: [],
          ruleVersion: moderationResult.policyVersion,
          ...moderationTraceOf(moderationResult),
          priorListingStatus: decision === 'REVIEW' ? 'ACTIVE' : null,
        },
      })

      // 命中 5 秒内容窗口：返回已有商品（200 而不是 201），并**重新投递**匹配 job ——
      // 前一次投递失败不能让该商品永久失配，消费侧按 listingId 幂等（契约 §2.3）。
      if (result.kind === 'duplicate') await store.enqueueMatchJob(result.listingId)

      return {
        created: result.kind === 'created',
        detail: await loadDetail(userId, result.listingId),
      }
    },

    async updateListing(userId, id, input) {
      // #286：图片结论必须在**事务外**算好 —— 它要查确认表 + 逐张 HEAD 对象存储，不能在持有
      // `SELECT ... FOR UPDATE` 的事务里做网络 I/O。结论本身是只读的（确认表里不会再变），闭包捕获后
      // 交给锁内的 `apply` 与文本结论聚合。
      //
      // 但"哪些图算数"是另一回事：不带 `objectKeys` 时以**库里现有的图片**为准（`listImageKeys`），
      // 否则一次纯文本编辑就能把图片 REVIEW 洗掉（见 `imageDecisionsOfStoredKeys`）；带 `objectKeys`
      // 时以请求为准，其中本来就在库里的键视为"没变的老图片"，不再要求确认记录（存量数据兼容）。
      const storedKeys = await store.listImageKeys(id)
      const storedKeySet = new Set(storedKeys)
      const imageDecisions = input.objectKeys
        ? await assertUsableObjectKeys(userId, input.objectKeys, storedKeySet)
        : await imageDecisionsOfStoredKeys(userId, storedKeys)

      // #228：`SELECT ... FOR UPDATE` 里**不能发网络请求**（provider 是外部调用）。所以把
      // 「读快照 → 合并 → 审核」放在事务外，锁内只做 CAS 复核 + 写库：写回时 `expected` 与锁内
      // 那一行不一致（标题/描述/审核态/图片组被并发改过）就返回 `conflict`，这里重读重算重审。
      let result: ListingUpdateResult | undefined
      // `apply` 在锁内算出的字段级原因要等事务返回后才能抛；`rejected` 只带一个 kind，
      // 所以在这里接一下（不落库：命中词本身不进任何持久化或响应）。
      let blockedDetails: ApiErrorDetail[] | undefined
      for (let attempt = 0; attempt < UPDATE_REVIEW_ATTEMPTS; attempt += 1) {
        const snapshot = await store.getUpdateSnapshot({ id, sellerId: userId })
        if (snapshot.kind !== 'ok') {
          result = snapshot
          break
        }
        const reviewed = snapshot.row

        // 部分更新下 `free ⟹ priceCents === 0` 要按**合并后的最终状态**判定（契约 §7.1）：
        // 只给 priceCents 时也要看库里当前的 free。
        const finalFree = input.free ?? reviewed.free
        const finalPrice = input.priceCents ?? reviewed.priceCents
        if (finalFree && finalPrice !== 0) {
          throw new ListingServiceError(422, 'VALIDATION_FAILED', '0 元送时价格必须为 0', [
            { field: 'priceCents', message: '0 元送时价格必须为 0' },
          ])
        }

        const finalTitle = input.title ?? reviewed.title
        const finalDescription = input.description ?? reviewed.description
        // 事务外审核：provider 失败一律 fail-closed（`moderateListingText` 抛 400/503）。
        const moderationResult = await moderateListingText({
          dataId: encodePublicId(PUBLIC_ID_PREFIX.listing, id),
          title: finalTitle,
          description: finalDescription,
        })
        // 图片组在事务外读、在锁内写：中间可能被另一个 PATCH 整组替换（`storedKeys` 已经不是这一
        // 行的图片）。这时旧结论不再成立，按最保守的 REVIEW 处理 —— 宁可让管理员再看一眼，也不
        // 能把"未审核图片 + APPROVED"写回库里。
        const imagesReplacedConcurrently =
          input.objectKeys === undefined && !sameObjectKeys(reviewed.objectKeys, storedKeys)
        // 与 create 同一口径：图片结论与文本结论取最严一档（ALLOW < REVIEW < BLOCK）。
        const decision = aggregateModerationDecision([
          moderationResult.decision,
          ...imageDecisions,
          ...(imagesReplacedConcurrently ? (['REVIEW'] as const) : []),
        ])
        const trace = moderationTraceOf(moderationResult)

        try {
          result = await store.updateListingAtomic({
            id,
            sellerId: userId,
            ...(input.objectKeys ? { objectKeys: input.objectKeys } : {}),
            // CAS 依据：锁内这一行必须还是刚才被审的那一份内容。
            expected: {
              title: reviewed.title,
              description: reviewed.description,
              moderationStatus: reviewed.moderationStatus,
              objectKeys: reviewed.objectKeys,
            },
            apply: (_input, current) => {
              // 阻断：只写审计（由 store 在**同一锁内事务**完成），不写商品。
              const moderationPlan = {
                title: finalTitle,
                description: finalDescription,
                decision,
                // 本地词表时代的命中规则/脱敏词条对腾讯 provider 没有对应物：审计改看下面这组
                // provider 字段（#228 §6），这里保持空数组（列本身 NOT NULL）。
                matchedRules: [],
                matchedTermsMasked: [],
                ruleVersion: moderationResult.policyVersion,
                ...trace,
                priorListingStatus:
                  decision === 'REVIEW'
                    ? current.pendingReviewAction === 'CREATE'
                      ? 'ACTIVE'
                      : (current.pendingReviewPriorStatus ?? current.status)
                    : null,
              }
              if (decision === 'BLOCK') {
                blockedDetails = moderationBlockDetailsOf(moderationResult)
                return { kind: 'blocked' as const, moderation: moderationPlan }
              }

              // `objectKeys` 必须从 `fields` 里剔除：它不是 `listings` 的列，混进 `set()` 会让
              // drizzle 生成不存在的列名（而且图片替换要走自己的删+插路径）。
              const { objectKeys: _objectKeys, ...fields } = input
              return {
                kind: 'write' as const,
                fields: {
                  ...fields,
                  moderationStatus: decision === 'REVIEW' ? 'REVIEW' : 'APPROVED',
                  // 对外只给既有安全码，绝不透出腾讯 Label/Score/命中策略（#228 §6）。
                  moderationReason: moderationReasonCodeFor(decision),
                  moderationRuleVersion: moderationResult.policyVersion,
                  moderatedAt: new Date(),
                  ...(decision === 'REVIEW' ? { status: 'OFFLINE' as const } : {}),
                },
                moderation: moderationPlan,
              }
            },
          })
        } catch (error) {
          // 最终状态仍由 DB 的 `listings_free_price_cents_zero` 兜底（契约 §7.1）：锁内校验已经
          // 排除了并发 PATCH 竞态，但如果将来出现绕过 service 的写入方，仍然要报 422 而不是 500。
          if (isFreePriceConstraintViolation(error)) {
            throw new ListingServiceError(422, 'VALIDATION_FAILED', '0 元送时价格必须为 0', [
              { field: 'priceCents', message: '0 元送时价格必须为 0' },
            ])
          }
          throw error
        }

        // CAS 冲突：审核依据的那份内容已经不是锁内这一份，重读、重算、**重审**。
        if (result.kind !== 'conflict') break
      }
      if (result === undefined || result.kind === 'conflict') {
        // 连续 N 次都撞车：并发写太频繁，明确让客户端重试，而不是把旧审核结论写回去。
        throw new ListingServiceError(409, 'LISTING_NOT_EDITABLE', '商品正在被并发修改，请重试')
      }

      if (result.kind === 'rejected') {
        // 审计记录已由 store 在**同一锁内事务**里写好（见 `ListingUpdatePlan`）：
        // 不要在这里再写一遍，也不要无锁重读去猜当时的内容。
        throw new ListingServiceError(
          422,
          'LISTING_CONTENT_BLOCKED',
          '商品内容未通过审核',
          blockedDetails,
        )
      }

      // `'locked'` / `'not-owner'` / `'not-found'` 都来自锁内读到的行，不再是 check-then-act 的第二次读。
      if (result.kind === 'locked') {
        throw new ListingServiceError(
          409,
          'LISTING_NOT_EDITABLE',
          '商品处于交易中或已售出，无法修改',
        )
      }
      if (result.kind === 'governance-blocked') {
        throw new ListingServiceError(
          409,
          'LISTING_GOVERNANCE_BLOCKED',
          '商品已被平台下架，暂不能修改；如需恢复请联系平台处理',
        )
      }
      if (result.kind === 'not-owner') {
        throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能操作自己的商品')
      }
      if (result.kind === 'not-found') throw notFound()

      return loadDetail(userId, id)
    },

    async transition(userId, id, to) {
      const state = await requireOwnEditable(userId, id, store)

      // 目标态已经是当前态 → 幂等成功（契约 §2.5 / §2.6 的状态表）。
      if (state.status === to) return loadDetail(userId, id)

      const changed = await store.setStatus({ id, from: state.status, to })
      if (!changed) {
        // 并发下别人先改了：只有改成目标态才算幂等成功，否则是状态机拒绝。
        const latest = await store.findState(id)
        if (latest?.status === to) return loadDetail(userId, id)
        throw new ListingServiceError(409, 'LISTING_NOT_EDITABLE', '当前状态不允许该操作')
      }

      return loadDetail(userId, id)
    },

    async deleteListing(userId, id) {
      const result = await store.deleteListingAtomic({ id, sellerId: userId })
      // 分支顺序与 updateListing 的收口一致：404 / 403 / 409 各回各的，不互相吞。
      if (result.kind === 'not-found') throw notFound()
      if (result.kind === 'not-owner') {
        throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能操作自己的商品')
      }
      if (result.kind === 'not-deletable') {
        throw new ListingServiceError(
          409,
          'LISTING_NOT_DELETABLE',
          '只有未通过审核且没有交易记录的商品可以删除',
        )
      }
    },
  }
}

async function recordModeration(
  store: ListingStore,
  input: {
    listingId?: string
    sellerId: string
    action: 'CREATE' | 'UPDATE'
    title: string
    description: string
    result: TextModerationResult
  },
): Promise<void> {
  await store.recordModeration?.({
    listingId: input.listingId,
    sellerId: input.sellerId,
    action: input.action,
    title: input.title,
    description: input.description,
    decision: input.result.decision,
    // provider 结果里没有本地词表的命中规则/脱敏词条；审计看下面的 provider 字段（#228 §6）。
    matchedRules: [],
    matchedTermsMasked: [],
    ruleVersion: input.result.policyVersion,
    ...moderationTraceOf(input.result),
  })
}

/** #228：provider 结果里风险最高的那个字段（审计字段取它的 label/subLabel/score/requestId）。 */
function tracedField(result: TextModerationResult): FieldModerationResult | null {
  return (
    result.fields.find((field) => field.decision === 'BLOCK') ??
    result.fields.find((field) => field.decision === 'REVIEW') ??
    result.fields[0] ??
    null
  )
}

/** provider 结果 → 审核记录里的可追溯字段（#228 §6）。 */
function moderationTraceOf(result: TextModerationResult): ModerationTrace {
  const field = tracedField(result)
  return {
    provider: result.provider,
    providerRequestId: field?.requestId ?? null,
    suggestion: result.suggestion,
    label: field?.label ?? null,
    subLabel: field?.subLabel ?? null,
    score: field?.score ?? null,
  }
}

/** 对外只给**既有安全码**（客户端已能翻译），绝不透出腾讯 Label/Score/命中策略（#228 §6）。 */
function moderationReasonCodeFor(decision: ModerationDecision): string | null {
  if (decision === 'BLOCK') return 'PROHIBITED_CONTENT'
  if (decision === 'REVIEW') return 'CONTENT_REQUIRES_REVIEW'
  return null
}

/**
 * BLOCK → 可安全展示的字段级错误（`error.details`，`field` 与契约字段名一致，
 * 客户端据此把错误贴到对应输入框，而不是只给一句页面级通用错误）。
 *
 * **只给字段名与固定文案，绝不下发命中词或脱敏片段**：`rules.maskTerm()` 对两字词会露出
 * 首尾两字（`毒品` → `毒*品`），等于把词库交给绕过者，而词库本身还会继续演化（#74 口径）。
 *
 * 只取 `decision === 'BLOCK'` 的命中：同一次提交可能同时命中 BLOCK 与 REVIEW 规则，
 * 把只触发 REVIEW 的字段报成「禁止发布的内容」会指错方向。
 *
 * 返回 `undefined`（而不是空数组）当没有任何 BLOCK 命中时——那种情况下响应体与
 * 加 `details` 之前逐字节一致，调用方不必分辨 `[]` 与缺失。
 */
/**
 * 字段名 → 可展示的中文名。写成 `Record<ModerationField, string>` 而不是三元表达式：
 * 将来 `ModerationField` 多一个成员时，这里会在**类型检查**阶段逼着补文案，
 * 而不是把新字段静默说成「描述」（那会把用户指到错的输入框）。
 */
const MODERATION_FIELD_LABEL: Record<ModerationField, string> = {
  title: '标题',
  description: '描述',
}

function moderationBlockDetailsOf(result: TextModerationResult): ApiErrorDetail[] | undefined {
  // 只认**文本**被判 BLOCK 的字段。结论由图片抬升到 BLOCK 时（例如库内某张图已被人工结算为
  // BLOCK）文本其实干净，把 title/description 说成「包含禁止发布的内容」是误导（#228 复审 F1）。
  const fields = [
    ...new Set(
      result.fields.filter((field) => field.decision === 'BLOCK').map((field) => field.field),
    ),
  ]
  if (fields.length === 0) return undefined
  return fields.map((field) => ({
    field,
    message: `${MODERATION_FIELD_LABEL[field]}包含平台禁止发布的内容`,
  }))
}

function isAllowedMime(contentType: string): boolean {
  return (ALLOWED_IMAGE_MIME as readonly string[]).includes(contentType)
}

/** 两张图片列表是否**逐位**相同（顺序有意义：`objectKeys` 决定 `sort_order`，即封面）。 */
function sameObjectKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/**
 * 编辑 / 下架 / 上架共用的前置校验：存在性 → 归属 → 状态机。
 * 顺序不能换：先判归属会把"别人的商品是否存在"泄漏给调用方。
 */
async function requireOwnEditable(
  userId: string,
  id: string,
  store: ListingStore,
): Promise<ListingState> {
  const state = await store.findState(id)
  if (!state) throw new ListingServiceError(404, 'LISTING_NOT_FOUND', '商品不存在')
  if (state.sellerId !== userId) {
    throw new ListingServiceError(403, 'NOT_LISTING_OWNER', '只能操作自己的商品')
  }
  if (LOCKED_LISTING_STATUSES.includes(state.status)) {
    throw new ListingServiceError(409, 'LISTING_NOT_EDITABLE', '商品处于交易中或已售出，无法修改')
  }
  if (state.governanceDelistedAt) {
    throw new ListingServiceError(
      409,
      'LISTING_GOVERNANCE_BLOCKED',
      '商品已被平台下架，暂不能修改；如需恢复请联系平台处理',
    )
  }
  return state
}

/** 游标解码 + 与排序键类型对齐；不合法一律 422（契约 §2.1）。 */
function decodeFeedCursor(
  raw: string | undefined,
  sort: ListingFeedQuery['sort'],
): FeedCursorKey | null {
  if (raw === undefined) return null

  const decoded = decodeCursor(raw)
  if (!decoded) throw invalidCursor()

  if (sort === 'newest') {
    // 只接受我们自己生成的"微秒精度 UTC ISO"形态，且**值域**必须合法：
    // 否则 `::timestamptz` 转换失败又会变成 500（契约要求 422）。校验通过后原样传给 SQL 以保住微秒。
    if (typeof decoded.sortKey !== 'string' || !isCursorTimestamp(decoded.sortKey)) {
      throw invalidCursor()
    }
    return { kind: 'newest', createdAt: decoded.sortKey, id: decoded.id }
  }

  if (typeof decoded.sortKey !== 'number') throw invalidCursor()
  return { kind: sort, priceCents: decoded.sortKey, id: decoded.id }
}

function invalidCursor(): ListingServiceError {
  return new ListingServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])
}

function cursorKeyOf(entry: FeedEntry, sort: ListingFeedQuery['sort']): string | number {
  // newest 用 store 给的微秒文本；priceAsc/priceDesc 用整数分（本来就无损）。
  return sort === 'newest' ? entry.createdAtCursor : entry.listing.priceCents
}
