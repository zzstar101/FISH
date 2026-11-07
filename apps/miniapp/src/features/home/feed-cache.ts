/**
 * 首页 feed 的本地快照（#631）。
 *
 * **为什么要它**：`pages/home/index.tsx` 的 `useLoad` 以前只有 `void load('ALL')`，
 * 进页必等一次推荐 feed 往返（`features/fetchers.loadHomeFeed` →
 * `features/recommendation/api.fetchRecommendationFeed`，一次 50 条）。冷启动时这段
 * 等待是一整屏骨架，而上一轮已经拿到的结果其实就在用户自己的机器上。
 *
 * **为什么不复用 `features/list-snapshots`**（#619/#621 那张底座，Owner 已拍板）：它的
 * `read()` 要求 `account` 已经是 string，而 account 只由 `/me` 返回后 `auth/store` 调
 * `listSnapshots.syncAccount(...)` 写入。首页 `useLoad` 早于 `/me` —— 冷启动这一瞬身份
 * 必然是 unknown，那张底座读不出任何东西，正好是本单要修的场景。这里改用**同步可读**的
 * 本地会话指纹判身份（`lib/session` 的 `fish:session`），进页第一时间就能用。
 *
 * **不做什么**：不碰推荐排序、归因、曝光去重、「不感兴趣」语义；也不是一个通用的 GET
 * 缓存层 —— 只服务首页 feed，只有「上一次成功结果」这一种数据。
 *
 * **只缓存「推荐」**（Owner 拍板）：首页进页拉的就是 `ALL`，切分类仍走骨架屏 —— 少一屏
 * 骨架，比先上屏一份可能已经卖掉的旧货更不容易让用户误判。Key 依然按分类命名（验收①的
 * 隔离口径，也保证任何分类的旧数据不会冒充另一个分类），只是当前只有 `ALL` 会被写入。
 */
import Taro from '@tarojs/taro'
import { CATEGORY_LABEL } from '@/lib/listing-labels'
import { readSession } from '@/lib/session'
import type { ImageRatio, ListingCategory, MockListing, MockUser } from '@/mock/types'

/**
 * 一个分类一个 key：分类之间天然隔离，写入覆盖的是同一个分类，不会互相顶掉。
 *
 * 当前只有「推荐」（`ALL`）会落盘（写入点在 `apps/miniapp/src/pages/home/index.tsx` 的
 * `load()` 里），所以真实占用是一个 key、上限 `HOME_FEED_SNAPSHOT_MAX_BYTES`，远在
 * 小程序单 key 上限（1MB）与总配额（10MB）之内。
 */
const KEY_PREFIX = 'fish:home.feed-snapshot:'

/**
 * 载荷版本。**形状变了必须 +1**：旧版本载荷在读取时整条作废，而不是逐字段猜。
 * 条目内的逐字段校验（见 `toListing`）只兜「写坏的字节」，兜不了「字段语义变了」。
 */
const SNAPSHOT_VERSION = 1

/**
 * 30 分钟。首页 feed 是「附近有什么好东西」，半小时内的结果上屏基本不会让人误判；
 * 再长就等于给用户看一个已经过时的市场。
 */
export const HOME_FEED_SNAPSHOT_TTL_MS = 30 * 60 * 1000

/**
 * 只存一屏多一点。快照的职责是**首屏**别空着（网络结果回来就整屏替换），不是离线阅读；
 * 条数给满 50 条只会让 JSON 更大、读取更慢。
 */
export const HOME_FEED_SNAPSHOT_MAX_ITEMS = 24

/**
 * 256KB（口径与 `features/list-snapshots` 的 `SNAPSHOT_MAX_BYTES` 一致）。
 * 按 UTF-8 最坏 3 字节/码元估算，见 `utf8WorstCase`。
 */
export const HOME_FEED_SNAPSHOT_MAX_BYTES = 256 * 1024

/** `ALL` = 首页的「推荐」，不是契约里的分类枚举值 */
export type HomeFeedScope = ListingCategory | 'ALL'

export type HomeFeedSnapshot = {
  items: MockListing[]
  /**
   * 写入时刻（ms）。读出来时 TTL 已经校验过，所以页面上不需要再算新旧 —— 当前**没有
   * 消费点**，留着是为了在工具里看 Storage 时能一眼判断这条快照有多旧。
   */
  savedAt: number
}

/** 注入式存储：与 `features/list-snapshots` 同一种形状，测试里换成 Map */
export type HomeFeedSnapshotStorage = {
  get: (key: string) => unknown
  set: (key: string, value: string) => void
  remove: (key: string) => void
}

export type HomeFeedCache = {
  /** 当前身份的本地指纹（同步可读；进页时 `/me` 还没回来也能用） */
  viewer: () => string
  /** 读某个分类的快照；任何不可信的载荷一律返回 `null`（并顺手清掉） */
  read: (scope: HomeFeedScope) => HomeFeedSnapshot | null
  /**
   * 写快照。`viewerAtRequest` 必须是**请求发出时**捕获的指纹：账号在这之后切走了，
   * 这批数据属于上一个身份，写入会让下一个人看到别人的列表 —— 直接拒写。
   */
  write: (scope: HomeFeedScope, items: readonly MockListing[], viewerAtRequest: string) => boolean
}

/* -------------------------------------------------------------- 身份指纹 */

/**
 * 32 位散列（djb2 变种）。为什么要哈希而不是直接留 cookie 尾 8 位（那是草稿里的写法）：
 * 本地存储里没理由躺一段凭据原文，指纹只需要「同一登录态稳定、不同登录态可区分」。
 *
 * 只用 `*` / `+` / `|0` 这类 ES5 运算，不碰 `Math.imul` / `padStart`：真机逻辑层是
 * JSCore / V8，老系统上少一个 API 就整页白屏，而这里一点也不需要它们。
 */
function fingerprint(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33 + input.charCodeAt(i)) | 0
  }
  return `0000000${(hash >>> 0).toString(16)}`.slice(-8)
}

/**
 * 当前身份指纹。会话 cookie 变了（重新登录、换账号、退出）指纹就变，
 * 旧快照的 `viewer` 对不上 → 读取时整条作废。
 *
 * 用 `fish:session` 而不是用户 id：`fish:session` 在冷启动的第一行代码就能同步读到，
 * 而用户 id 要等 `/me`。
 */
export function homeFeedViewer(): string {
  const session = readSession()
  return session ? `auth:${fingerprint(session)}` : 'anon'
}

/* ---------------------------------------------------------------- 校验 */

/**
 * 与 `MockListing['ratio']` 对齐的运行时表。**值域的唯一来源仍是那个类型** ——
 * 这张表是穷举 `Record`，类型加了值而这里没加会编译报错，所以两边不会漂。
 * `ratio` 是唯一「坏值会画错」的字段：页面按它算卡片高度（`RATIO_HEIGHT`）。
 */
const RATIOS: Record<ImageRatio, true> = {
  '1x1': true,
  '4x5': true,
  '5x6': true,
  '3x4': true,
  '4x3': true,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验通过后的窄化：`table` 的键集就是该类型的值域，命中即说明值在该类型内。
 * 用 `hasOwnProperty.call` 而不是 `Object.hasOwn`（ES2022，老版本 iOS 的 JSCore 没有）。
 */
function pick<T extends string>(value: unknown, table: Record<T, unknown>): T | null {
  if (typeof value !== 'string') return null
  // biome-ignore lint/suspicious/noPrototypeBuiltins: 这条规则建议的 `Object.hasOwn` 是 ES2022，老版本 iOS 的 JSCore 没有；`check-es5` 只校验语法，抓不到运行时 API 缺失
  return Object.prototype.hasOwnProperty.call(table, value) ? (value as T) : null
}

/**
 * 展示型枚举（成色 / 状态 / 卖家认证态）**不做校验**，只做类型窄化：
 * 它们只喂给 `conditionLabel` / `outOfMarketLabel` 这类带默认分支的文案函数，未知值最坏
 * 退回默认文案；为这个丢掉一张卡（甚至整屏快照）不划算。
 *
 * 分类不在此列 —— 它决定卡片走哪套宽高比与占位图，未知值会画塌，所以 `toListing` 里对
 * `CATEGORY_LABEL` 是硬校验。形状层面的漂移由 `SNAPSHOT_VERSION` 负责。
 */
function asShown<T extends string>(value: unknown, fallback: T): T {
  return typeof value === 'string' && value.length > 0 ? (value as T) : fallback
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 卖家行整行依赖它：形状不对就当「没有卖家信息」（`null` 是卡片已有的合法入参） */
function toSeller(value: unknown): MockUser | null {
  if (!isRecord(value)) return null
  const { id, nickname } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof nickname !== 'string') return null
  return {
    id,
    nickname,
    avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
    authStatus: asShown(value.authStatus, 'UNVERIFIED'),
    soldCount: optionalCount(value.soldCount),
    goodRate: optionalCount(value.goodRate),
  }
}

/**
 * 一条快照条目 → `MockListing`。
 *
 * 只硬校验「缺了会画错或点不动」的字段（id / 标题 / 价格 / 封面 / 比例 / 分类），
 * 其它字段给兜底值：坏一条不该让整屏退回骨架屏。
 */
function toListing(value: unknown): MockListing | null {
  if (!isRecord(value)) return null
  const { id, title, priceCents, coverUrl } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof title !== 'string') return null
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) return null
  if (typeof coverUrl !== 'string') return null
  const ratio = pick(value.ratio, RATIOS)
  if (ratio === null) return null
  const category = pick(value.category, CATEGORY_LABEL)
  if (category === null) return null
  const images = Array.isArray(value.images)
    ? value.images.filter((url): url is string => typeof url === 'string')
    : []
  return {
    id,
    title,
    priceCents,
    originalPriceCents: optionalCount(value.originalPriceCents),
    category,
    sub: typeof value.sub === 'string' ? value.sub : '',
    condition: asShown(value.condition, 'GOOD'),
    status: asShown(value.status, 'ACTIVE'),
    urgent: value.urgent === true,
    negotiable: value.negotiable === true,
    free: value.free === true,
    coverUrl,
    images,
    ratio,
    badge: typeof value.badge === 'string' ? value.badge : null,
    description: typeof value.description === 'string' ? value.description : '',
    spec: typeof value.spec === 'string' ? value.spec : '',
    sellerId: typeof value.sellerId === 'string' ? value.sellerId : '',
    seller: toSeller(value.seller),
    views: optionalCount(value.views),
    wants: optionalCount(value.wants),
    createdHoursAgo: optionalCount(value.createdHoursAgo) ?? 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  }
}

/** UTF-8 最坏情况下的字节上限：一个码元最多 3 字节，够用来卡住怪东西 */
function utf8WorstCase(raw: string): number {
  return raw.length * 3
}

/* ---------------------------------------------------------------- 缓存 */

/**
 * 造一个首页 feed 快照器。`storage` / `viewer` / `now` 全部注入，方便测试
 * （同 `features/list-snapshots` 的 `createListSnapshots`）。
 */
export function createHomeFeedCache(
  storage: HomeFeedSnapshotStorage,
  viewer: () => string = homeFeedViewer,
  now: () => number = Date.now,
): HomeFeedCache {
  const keyOf = (scope: HomeFeedScope): string => `${KEY_PREFIX}${scope}`

  /** 存储层的读写失败（配额满、被清理）一律当「没有快照」，绝不上抛打断进页 */
  const drop = (scope: HomeFeedScope): void => {
    try {
      storage.remove(keyOf(scope))
    } catch {
      /* 清不掉也无所谓：下次读取还会再判一次 TTL/指纹 */
    }
  }

  const read = (scope: HomeFeedScope): HomeFeedSnapshot | null => {
    let raw: unknown
    try {
      raw = storage.get(keyOf(scope))
    } catch {
      return null
    }
    if (typeof raw !== 'string') {
      // 键下被别的东西占了（不是我们写进去的字符串）：顺手清掉，否则每次进页都白读一遍
      if (raw !== undefined && raw !== null) drop(scope)
      return null
    }
    // 空串 = 这条键不存在（Taro 对缺失的键返回 `''`），不是坏数据
    if (raw.length === 0) return null
    if (utf8WorstCase(raw) > HOME_FEED_SNAPSHOT_MAX_BYTES) {
      drop(scope)
      return null
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      drop(scope)
      return null
    }
    if (!isRecord(parsed)) {
      drop(scope)
      return null
    }
    if (parsed.v !== SNAPSHOT_VERSION) {
      drop(scope)
      return null
    }
    // 换账号 / 退出后残留的上一身份数据：读到就作废，任何情况下都不许上屏
    if (parsed.viewer !== viewer()) {
      drop(scope)
      return null
    }
    const savedAt = parsed.savedAt
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) {
      drop(scope)
      return null
    }
    const age = now() - savedAt
    // `age < 0` = 设备时钟往回调过（或写了未来时间戳）。宁可当过期，也别把它当新数据
    if (age < 0 || age > HOME_FEED_SNAPSHOT_TTL_MS) {
      drop(scope)
      return null
    }
    const source = Array.isArray(parsed.items) ? parsed.items : []
    const items: MockListing[] = []
    for (const entry of source) {
      const listing = toListing(entry)
      if (listing) items.push(listing)
      if (items.length >= HOME_FEED_SNAPSHOT_MAX_ITEMS) break
    }
    if (items.length === 0) {
      drop(scope)
      return null
    }
    return { items, savedAt }
  }

  const write = (
    scope: HomeFeedScope,
    items: readonly MockListing[],
    viewerAtRequest: string,
  ): boolean => {
    /*
      身份在请求途中变了（换成别人的账号 / 退出登录）：这批数据属于上一个身份。
      旧实现是「写入时才取身份」，于是把上一个账号的列表写到了新身份名下 —— 这里
      必须在**请求发出时**捕获、写入时比对，对不上就一个字都不落盘。
    */
    if (viewerAtRequest !== viewer()) return false
    // 空列表不写：空快照上屏等于把「还没读到」画成「这个分类没货」
    if (items.length === 0) return false
    const payload = {
      v: SNAPSHOT_VERSION,
      viewer: viewerAtRequest,
      savedAt: now(),
      items: items.slice(0, HOME_FEED_SNAPSHOT_MAX_ITEMS),
    }
    let raw: string
    try {
      raw = JSON.stringify(payload)
    } catch {
      return false
    }
    // 超上限就整条不写，不截断：半个列表上屏比骨架屏更像「这就是全部」
    if (utf8WorstCase(raw) > HOME_FEED_SNAPSHOT_MAX_BYTES) return false
    try {
      storage.set(keyOf(scope), raw)
      return true
    } catch {
      return false
    }
  }

  return { viewer, read, write }
}

/** 小程序端唯一实例：Taro 存储 + 当前会话指纹 + 系统时钟 */
export const homeFeedCache: HomeFeedCache = createHomeFeedCache({
  get: (key) => Taro.getStorageSync(key),
  set: (key, value) => {
    Taro.setStorageSync(key, value)
  },
  remove: (key) => {
    Taro.removeStorageSync(key)
  },
})
