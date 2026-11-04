/**
 * 首页 feed 的本地快照：SWR 里「先拿旧数据上屏」的那一半。
 *
 * 为什么要有它：首页原来进页只做一件事 —— 发 `GET /recommendations/feed`（生产口径
 * 一次要二十多次库往返），拿到之前屏幕上只有骨架屏。用户反馈的「打开要等」「失败就白屏」
 * 里，属于小程序端的这一半与后端快慢无关：**手里明明有上一次的列表，却没有任何地方存过它**。
 * 存一份近期的快照，进页先上屏、网络回来再原地替换，等待时间就从「一次往返」变成「一帧」。
 *
 * 四条硬约束（改这个文件之前先读一遍）：
 *
 * 1. **快照没有归因上下文**。`requestId` / `position` 是服务端那一份 feed 才有的东西，
 *    快照里的件不是「这次请求下发的」，所以读出来的这批**不能**发 IMPRESSION /
 *    QUICK_SKIP —— 契约强制这两个事件必须带 requestId + position
 *    （见 `features/recommendation/use-impressions` 与页面里的 `feedContext`）。
 *    调用方（`pages/home`）在读快照时必须把 `requestId` 置空。
 * 2. **身份要对得上**。feed 是「给这个人看的」，换账号后拿上一个人的快照上屏，
 *    等于把别人的东西展示给新用户。小程序没有 userId 可直接读（会话只存 cookie，
 *    见 `lib/session`），所以这里记一份**身份指纹**：登录态取 cookie 尾部 8 个字符，
 *    未登录固定 `anon`。指纹对不上就整份丢弃，不做任何迁移。
 * 3. **过期就不给**。快照只用来填「网络还没回来的那几百毫秒」，不是离线数据源：
 *    超过 `SNAPSHOT_TTL_MS` 的商品价格 / 在售状态都可能已经变了，宁可先闪骨架屏。
 * 4. **宁缺勿滥**。存储是用户可清、可损坏的外部状态（换机型、清缓存、旧版本写入的旧结构），
 *    所以每个字段都做结构校验；只要有一件对不上，整条分类的条目直接作废 ——
 *    半坏的卡片（缺图 / 缺价 / 比例不认）比骨架屏难看得多，也更容易被当成真数据。
 *
 * 存储上限：`MAX_CATEGORIES` 个分类 × `MAX_ITEMS` 件。24 件的 feed 序列化后约几十 KB，
 * 远低于小程序单 key 1MB 的上限；分类超出就丢最旧的，不让它无限长胖。
 */
import Taro from '@tarojs/taro'
import { readSession } from '@/lib/session'
import type { ListingCategory, MockListing, MockUser } from '@/mock/types'

/** 存储 key：规格固定值，不要改名（改名等于让所有老用户的快照失效一次，没必要） */
const SNAPSHOT_KEY = 'fish.home.feedSnapshot'

/** 结构版本：不兼容的改动递增它，老结构整体作废（不做逐版迁移） */
const SNAPSHOT_VERSION = 1

/**
 * 快照有效期：30 分钟。
 *
 * 为什么不是「几天」：首页快照的唯一职责是**填等待**，网络一回来就被替换。
 * 时间窗拉长只会让「刚才明明看过」变成「这是几天前的价格」，反而像 bug。
 */
const SNAPSHOT_TTL_MS = 30 * 60 * 1000

/** 最多留几个分类的快照（超出丢最旧的） */
const MAX_CATEGORIES = 3

/** 单分类最多留几件（首页 feed 一页 24 件，留 30 够用） */
const MAX_ITEMS = 30

/** 首页顶部分类 + 「推荐」（`ALL` = 推荐，不是契约枚举值，与 `pages/home` 的 `category` 同义） */
export type HomeFeedCategory = ListingCategory | 'ALL'

/** 读出来的一份快照 */
export type HomeFeedSnapshot = {
  items: MockListing[]
  /** 写入时刻（ms），调用方据此判断新旧 */
  savedAt: number
}

type StoredEntry = { savedAt: number; items: unknown[] }

type StoredSnapshot = {
  v: number
  /** 身份指纹，见文件头第 2 条 */
  viewer: string
  entries: Record<string, StoredEntry>
}

/**
 * 当前身份指纹。
 *
 * 未登录 = `anon`：匿名 feed 对所有人是同一份公开数据，不需要再区分匿名 id（
 * 那个 id 属于埋点队列 `features/recommendation/queue`，职责不同，不在这里复用）。
 * 登录态取 cookie 尾部 8 字符而**不是**整串：整串是凭证，没有理由复制到第二个 key 里；
 * 8 字符足够区分「同一个人的同一个会话」与「换了个账号」。
 */
function viewerMarker(): string {
  const cookie = readSession()
  return cookie ? `auth:${cookie.slice(-8)}` : 'anon'
}

/** 比例枚举：卡片高度按它算（`pages/home` 的 `RATIO_HEIGHT`），认不出的比例会让图片区塌成 0 */
const RATIOS = new Set(['1x1', '4x5', '5x6', '3x4', '4x3'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSeller(value: unknown): value is MockUser | null {
  if (value === null) return true
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.nickname === 'string' &&
    typeof value.avatarUrl === 'string' &&
    typeof value.authStatus === 'string'
  )
}

/**
 * 一件商品的结构校验。
 *
 * 只校验**卡片真的会读**的字段（`components/product-card` 与首页的 `RATIO_HEIGHT`）：
 * `priceCents` 缺了会渲染成 NaN、`ratio` 认不出会让图片区高度变 undefined、
 * `coverUrl` 缺了是白卡 —— 这三种都在用户眼里等于坏数据，直接整条作废。
 * 其余字段（`description` / `spec` / `images` …）卡片不读，缺了不影响观感，不校验。
 */
function toListing(value: unknown): MockListing | null {
  if (!isRecord(value)) return null
  const { id, title, priceCents, coverUrl, ratio, condition, status } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof title !== 'string') return null
  if (typeof priceCents !== 'number' || !Number.isFinite(priceCents)) return null
  if (typeof coverUrl !== 'string' || coverUrl.length === 0) return null
  if (typeof ratio !== 'string' || !RATIOS.has(ratio)) return null
  if (typeof condition !== 'string' || typeof status !== 'string') return null
  if (!isSeller(value.seller)) return null
  return value as unknown as MockListing
}

function readStored(): StoredSnapshot | null {
  try {
    const raw: unknown = Taro.getStorageSync(SNAPSHOT_KEY)
    if (!isRecord(raw)) return null
    if (raw.v !== SNAPSHOT_VERSION) return null
    if (typeof raw.viewer !== 'string') return null
    if (!isRecord(raw.entries)) return null
    return raw as unknown as StoredSnapshot
  } catch {
    return null
  }
}

function writeStored(snapshot: StoredSnapshot): void {
  try {
    Taro.setStorageSync(SNAPSHOT_KEY, snapshot)
  } catch {
    /* 写失败不致命：快照是纯优化，网络这一次照样会把列表填上 */
  }
}

/** 条目是否还新鲜（`savedAt` 在未来视为时钟被改过，按过期处理） */
function isFresh(entry: StoredEntry, now: number): boolean {
  if (typeof entry.savedAt !== 'number') return false
  const age = now - entry.savedAt
  return age >= 0 && age <= SNAPSHOT_TTL_MS
}

/**
 * 读某个分类的快照。
 *
 * 返回 `null` 的四种情况（都**不是**错误，调用方一律按「没有快照」处理）：
 * 没存过、身份指纹对不上、超过有效期、条目里有一件商品结构不对。
 */
export function readHomeFeedSnapshot(
  category: HomeFeedCategory,
  now: number = Date.now(),
): HomeFeedSnapshot | null {
  const stored = readStored()
  if (!stored) return null
  // 换过账号：整份丢弃（不做部分保留 —— 剩下那些也是上一个人的）
  if (stored.viewer !== viewerMarker()) return null
  const entry = stored.entries[category]
  if (!isRecord(entry)) return null
  const candidate = entry as StoredEntry
  if (!Array.isArray(candidate.items) || !isFresh(candidate, now)) return null
  const items: MockListing[] = []
  for (const raw of candidate.items) {
    const listing = toListing(raw)
    // 一件坏 → 整条作废（见文件头第 4 条）
    if (!listing) return null
    items.push(listing)
  }
  if (items.length === 0) return null
  return { items, savedAt: candidate.savedAt }
}

/**
 * 写某个分类的快照。
 *
 * 调用时机只有一处：**真实接口成功返回之后**（演示数据 / 失败结果不写 ——
 * 前者会把 mock 卖进真数据的位置，后者是把「没读到」存成「读到过」）。
 * 空列表同样不写：它只会让下次进页闪一下空态再被网络翻案。
 */
export function writeHomeFeedSnapshot(
  category: HomeFeedCategory,
  items: readonly MockListing[],
  now: number = Date.now(),
): void {
  if (items.length === 0) return
  const viewer = viewerMarker()
  const stored = readStored()
  const entries: Record<string, StoredEntry> =
    stored && stored.viewer === viewer ? { ...stored.entries } : {}
  entries[category] = { savedAt: now, items: items.slice(0, MAX_ITEMS) }
  // 超出上限：按写入时刻丢最旧的（分类只有十几个，排序成本可以忽略）
  const keys = Object.keys(entries)
  if (keys.length > MAX_CATEGORIES) {
    keys
      .sort((a, b) => (entries[a]?.savedAt ?? 0) - (entries[b]?.savedAt ?? 0))
      .slice(0, keys.length - MAX_CATEGORIES)
      .forEach((key) => {
        delete entries[key]
      })
  }
  writeStored({ v: SNAPSHOT_VERSION, viewer, entries })
}

/** 清掉整份快照（退出登录 / 换账号时由调用方决定何时清；读路径也会靠指纹自证失效） */
export function clearHomeFeedSnapshot(): void {
  try {
    Taro.removeStorageSync(SNAPSHOT_KEY)
  } catch {
    /* 忽略 */
  }
}
