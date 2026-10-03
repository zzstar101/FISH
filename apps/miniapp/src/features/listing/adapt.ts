/**
 * 契约 `ListingCard` / `ListingDetail` → 页面在用的 `MockListing` 的**投影**。
 *
 * 为什么需要这一层，而不是把页面改成直接消费契约类型：
 * 页面（`product-card`、`home`、`search`、`listing-detail`）读的是
 * `MockListing` 的字段集合，其中若干项**契约里根本没有**。要改就得同时改 4 个页面
 * 的渲染逻辑与 CSS 依赖，风险大且与设计稿已验收的观感无关。
 * 所以这里做一次显式投影：**契约给得了的用真的，给不了的显式留 `null`**。
 *
 * ## 三条铁律
 *
 * 1. **绝不编造业务数据。** `views` / `originalPriceCents` / `spec` 契约没有，一律 `null`；
 *    `wants` 默认也是 `null`，但识图结果项的 `favoriteCount`（契约
 *    `VisualSearchResultItemSchema` 在卡片外挂的真实计数）由调用方经 `toMockListing` 的
 *    第三参**显式**传进来 —— 有真值才透传，拿不到仍是 `null`。
 *    页面已做 null 守卫，不渲染比渲染一个假数字诚实。
 * 2. **绝不编造卖家。** #191 起契约卡片带 `seller`（公开四字段），用它投影成真值；
 *    字段缺席（老客户端 mock 记录）时 `sellerId` 是**空串**哨兵 `NO_SELLER`、`seller` 是
 *    `null`，页面据此不渲染卖家行。这一条尤其要紧：`mock/users.ts` 的 `getUser()` 对未知 id
 *    **回退到 `USERS[0]`**，所以绝不能把卡片的卖家喂给 `getUser` —— 那会渲染出一个
 *    **完全捏造的卖家**（还带认证勾）。
 * 3. **纯排版量可以派生。** `ratio`（图片高度档位）纯粹是排版，与商品属性无关：
 *    真实数据没有比例字段，用 `id` 的稳定散列取档，保证瀑布流仍然错落且同一 id 永不抖动。
 *    这与 `features/listing/view.ts` 的 `imageHeightOf` 同一取舍，也与 Web 端
 *    `listing-thumb.tsx` 用 id 散列定占位色同源。
 */
import type { ListingCard, ListingCondition, ListingDetail } from '@fish/contracts/listings/schema'
import type { UserPresence } from '@fish/contracts/users/schema'
import { AVATAR_BLOCKS, LISTING_BLOCKS } from '@/mock/blocks'
import type { ImageRatio, MockListing, MockUser } from '@/mock/types'

/** 没有卖家信息时的哨兵值：页面用 `sellerId !== ''` 判断该不该渲染卖家行 */
export const NO_SELLER = ''

/** 无图商品的兜底色块：按分类取演示色块（与 `view.ts`、mock 同一套，不新增色值） */
function coverPlaceholder(category: string): string {
  const set = LISTING_BLOCKS[category]
  return set?.[0] ?? (LISTING_BLOCKS.OTHER as [string, string, string])[0]
}

/**
 * 图片比例档位：与 `view.ts` 的 `RATIO_STEPS` 同一组值，但这里返回设计稿的比例**名字**，
 * 因为页面用的是 `RATIO_HEIGHT[item.ratio]` 这张表。
 *
 * 为什么不在投影后直接给高度：列表页的列宽是页面自己算的（首页与搜索页列宽不同），
 * 投影层不该知道列宽。
 */
const RATIO_BY_HASH: ImageRatio[] = ['1x1', '4x5', '5x6', '3x4']

function ratioOf(id: string): ImageRatio {
  let hash = 0
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 100000
  return RATIO_BY_HASH[hash % RATIO_BY_HASH.length] ?? '1x1'
}

/**
 * 角标：契约没有 `badge` 字段，但**有** `free` / `urgent` 两个布尔量，
 * 由它们派生而不是编文案。两件事实可以同时成立（既急出又 0 元送），所以是数组取首个 ——
 * 页面当前只渲染一个角标位（`product-card` 的 `pcard__badge`），
 * 这里按「0元送 > 急出」的强度顺序取，与 `view.ts` 的 `badgesOf` 同序。
 */
function badgeOf(card: ListingCard): string | null {
  if (card.free) return '0元送'
  if (card.urgent) return '急出'
  return null
}

/** 发布距今小时数（页面用它渲染「2 小时前发布」这类相对时间） */
function hoursAgo(iso: string, now: number): number {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, (now - at) / 3600000)
}

/**
 * 契约卡片的卖家（#191）→ `MockUser`。只带公开四字段的真值；
 * `soldCount` / `goodRate` 契约没有、全仓也没有评价数据源 —— 恒 `null`，由页面不渲染。
 * 卖家缺席（契约 `seller` 缺席的老 mock 记录）返回 `null`，页面整行不渲染。
 */
export function toMockCardSeller(card: ListingCard): MockUser | null {
  if (!card.seller) return null
  return {
    id: card.seller.id,
    nickname: card.seller.nickname,
    // 契约的 `avatarUrl` 可为 null。缺图给一张**通用占位色块**（复用 mock 既有的
    // `AVATAR_BLOCKS`）：占位图是「这张图没有」的呈现，不是编造这个人的身份。
    avatarUrl: card.seller.avatarUrl ?? AVATAR_BLOCKS[0] ?? '',
    authStatus: card.seller.authStatus,
    soldCount: null,
    goodRate: null,
  }
}

/**
 * 无图商品的兜底色块由 `resolveCover` 之外的调用方处理：这里保持 `coverUrl` 原样
 * （契约允许 `null`），页面已有 `null` 处理路径。
 *
 * `wants` 是**向后兼容的**第三参：`views` 恒 `null`，但「想要数」在识图结果里有真值
 * （契约把 `favoriteCount` 挂在**卡片外层**，见 `VisualSearchResultItemSchema`）。
 * 不能把它并进 `now` 那个位置、也不改成选项对象 —— 现有调用方全按位置传 `now`
 * （`toMockListings`、`features/match/adapt.ts`、`pages/mylist`、`pages/vision-result`），
 * 加第三个可选参数是唯一不碰它们的写法。不传 = 照旧 `null`（不编造）。
 */
export function toMockListing(
  card: ListingCard,
  now: number = Date.now(),
  wants: number | null = null,
): MockListing {
  return {
    id: card.id,
    title: card.title,
    priceCents: card.priceCents,
    // 契约无原价
    originalPriceCents: null,
    category: card.category,
    // 契约无二级分类
    sub: '',
    condition: card.condition,
    status: card.status,
    urgent: card.urgent,
    negotiable: card.negotiable,
    free: card.free,
    // 契约允许无图（seed 里 6 条有 3 条无图）：缺图给同分类的演示色块占位，
    // 与 `view.ts` 的 `coverPlaceholder` 同一套色值；留空串会让 <Image> 渲染成裂图。
    coverUrl: card.coverUrl ?? coverPlaceholder(card.category),
    // 契约的 images 只在详情里有；列表卡没有图集
    images: card.coverUrl ? [card.coverUrl] : [],
    ratio: ratioOf(card.id),
    badge: badgeOf(card),
    // 契约无描述（列表卡）
    description: '',
    // 契约无规格行
    spec: '',
    // 空串 = 本卡片没有卖家信息（见文件头铁律 2）；有卖家时是真值（#191）
    sellerId: card.seller?.id ?? NO_SELLER,
    // 卖家公开资料：契约 `seller` 同源投影，缺席为 null（页面不渲染卖家行）
    seller: toMockCardSeller(card),
    // 契约无这两个计数 —— 不编数字。`wants` 由调用方给真值时才透传（识图结果的
    // `favoriteCount`，见函数头）；`views` 全仓没有数据源，恒 null
    views: null,
    wants,
    // 卖家本人视角的两个内部状态：只在查自己时非 null（契约如是说），这里原样带过去，
    // 由「我的发布」判段与动作。公开 Feed / 他人视角拿到的是 null，页面据此按「已通过」渲染。
    moderationStatus: card.moderationStatus,
    governanceDelisted: card.governanceDelisted ?? null,
    moderationReason: card.moderationReason ?? null,
    createdHoursAgo: hoursAgo(card.createdAt, now),
    createdAt: card.createdAt,
  }
}

export function toMockListings(cards: ListingCard[], now: number = Date.now()): MockListing[] {
  return cards.map((card) => toMockListing(card, now))
}

/**
 * 详情页的卖家：契约 `ListingDetail.seller` 有
 * `id / nickname / avatarUrl / authStatus`（`ListingSellerSchema` =
 * `MeSchema.pick({id,nickname,avatarUrl}).extend({authStatus})`；#86 F 后无校区字段）。
 *
 * **`authStatus` 用契约真值**（#122 修正）：此前这里硬写 `'UNVERIFIED'`，注释理由是
 * 「当前 authStatus 来自 Mock Provider，不可作为信任依据」——那条理由在 #68 之后已不成立
 * （VERIFIED 只能由校园邮箱验证事务写入），后端也确实在详情响应里返回真值（实测把某用户
 * 置 VERIFIED 后 `GET /listings/:id` 立即返回 VERIFIED）。继续硬写会让小程序详情页的
 * 认证勾**永远不显示**，而 Web 端详情页一直用的是真值（两个端口径不一致）。
 *
 * `goodRate` 契约里没有、全仓也没有评价数据源 —— 恒 `null`，由页面不渲染。
 * `soldCount` 由调用方从公开资料端点（`GET /users/:id/public`）取来传进来，
 * 取不到就是 `null`（页面已有 `null` 守卫）。
 *
 * `presence`（#359 第五点）与 `soldCount` **同一个来源、同一次请求**：详情页的
 * `loadListingDetail` 本来就要拉公开资料拿「卖出 N 件」，在线态就在那份响应里。
 * 不填（undefined）即「拿不到」，页面整块不渲染 —— 与 `soldCount` 的 null 守卫同款。
 */
export function toMockSeller(
  detail: ListingDetail,
  soldCount: number | null = null,
  presence: UserPresence | null = null,
): MockUser {
  return {
    id: detail.seller.id,
    nickname: detail.seller.nickname,
    // 契约的 `avatarUrl` 可为 null。缺图给一张**通用占位色块**（复用 mock 既有的
    // `AVATAR_BLOCKS`）：占位图是「这张图没有」的呈现，不是编造这个人的身份。
    avatarUrl: detail.seller.avatarUrl ?? AVATAR_BLOCKS[0] ?? '',
    authStatus: detail.seller.authStatus,
    soldCount,
    // 契约无这一项，且没有真实口径（无评价表）：不编百分比
    goodRate: null,
    presence,
  }
}

/** 成色文案（与 mock/api.ts 的 `conditionLabel` 同口径；真实数据下也要用同一套词） */
export function conditionText(condition: ListingCondition): string {
  switch (condition) {
    case 'NEW':
      return '全新'
    case 'LIKE_NEW':
      return '九成新'
    case 'GOOD':
      return '八成新'
    default:
      return '七成新'
  }
}
