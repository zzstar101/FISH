/**
 * 消息页搜索（#669）——**纯函数层**，不碰 React、不碰 Taro、不发请求。
 *
 * 为什么单独一个文件：三段结果（联系人 / 商品名 / 聊天记录）的匹配与截断规则
 * 是这次改动里唯一有分支逻辑的部分，放在 `index.tsx` 里就只能靠开发者工具手点验证。
 * 这里全部是纯函数，`apps/miniapp/tests/chat-search.test.ts` 逐个用例钉住。
 *
 * **能力边界（V1 口径，写进 UI 文案，别让用户以为能搜全站）**：
 * - 联系人 / 商品名：只在**已加载的会话列表**（`GET /conversations` 第一页，契约上限 50 条）里匹配，
 *   契约没有「按昵称搜用户」的接口，也不该为搜索再发明一个；
 * - 聊天记录：只扫**最近聊过的 N 个会话**的消息页（`MAX_MESSAGE_SCAN_CONVERSATIONS`），
 *   没有全站消息搜索接口，扫更多会话就是把进搜索态变成几十个并发请求；
 * - 商品：这是唯一**全站**的一段，走已有的 `GET /listings?q=`（`searchListings`）。
 */

import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { ListingCard } from '@fish/contracts/listings/schema'
import type { ChatListState } from './list-view'

/** 输入防抖：输入即搜，但不为每个按键发一次请求（300ms 内连打不重复搜） */
export const SEARCH_DEBOUNCE_MS = 300

/** 聊天记录扫描的会话上限：取列表里最近的这几个（列表已按 `lastMessageAt` 降序） */
export const MAX_MESSAGE_SCAN_CONVERSATIONS = 10

/** 聊天记录结果条数上限：再多就该给「查看全部」，V1 不做 */
export const MAX_MESSAGE_HITS = 20

/** 全站商品结果条数上限 */
export const MAX_MARKET_HITS = 10

/** 联系人结果条数上限（同一个卖家可能挂多个会话，先按人去重再截断） */
export const MAX_CONTACT_HITS = 10

/**
 * 「自己会话里的商品」占商品段的上限：给全站结果留两个位。
 *
 * 会话内商品最多能有 50 条（每个会话一条），不单独封顶时它会把十条名额吃满，
 * 全站命中一条都显示不出来 —— 用户会以为「全站没有」，其实是被自己聊过的挤掉了。
 */
export const MAX_CONVERSATION_LISTING_HITS = 8

/** 搜索词归一：去首尾空白 + 折叠连续空白 + 小写（英文昵称/型号大小写不敏感） */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * 子串包含（大小写与空白不敏感）。
 *
 * 两侧都折叠空白：`query` 已经过 `normalizeQuery`，但**正文**没有 —— 消息里
 * 「k380　键盘」这种全角/连续空白很常见，只归一查询侧会出现「明明有这句话却搜不到」。
 * 空查询不算命中 —— 空搜索不该匹配全部。
 */
function hit(haystack: string | null | undefined, query: string): boolean {
  if (query.length === 0) return false
  return (haystack ?? '').replace(/\s+/g, ' ').toLowerCase().includes(query)
}

/** 查询是否有实际内容（只有空白 = 用户还没输入，不能当成「没找到」） */
export function hasQuery(rawQuery: string): boolean {
  return normalizeQuery(rawQuery).length > 0
}

/**
 * 命中片段：以关键词为中心取上下文，两端被裁掉时加省略号。
 *
 * 不返回整条消息正文 —— 聊天记录可能很长，列表里塞全文会把结果区撑成一面墙，
 * 而且用户要的是「哪条消息里提到过这个词」。
 */
export function snippetOf(text: string, query: string, radius = 8): string {
  const flat = text.replace(/\s+/g, ' ')
  if (query.length === 0) return flat.slice(0, radius * 2)
  const at = flat.toLowerCase().indexOf(query)
  if (at < 0) return flat.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(flat.length, at + query.length + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface ContactHit {
  kind: 'contact'
  conversationId: string
  userId: string
  nickname: string
  avatarUrl: string | null
  /** 这个会话挂在哪个商品上（联系人结果右侧的次要信息） */
  listingTitle: string
}

export interface ListingHit {
  kind: 'listing'
  listingId: string
  title: string
  priceCents: number
  coverUrl: string | null
  /**
   * `conversation` = 我自己会话里聊到的商品（点进去能直接开那个会话）；
   * `market` = 全站搜到的商品（点进商品详情）。同名商品两段都出现时以会话为准。
   */
  source: 'conversation' | 'market'
  /** 只有 `source === 'conversation'` 才有：这个商品挂在哪条会话上 */
  conversationId: string | null
}

export interface MessageHit {
  kind: 'message'
  conversationId: string
  messageId: string
  nickname: string
  avatarUrl: string | null
  snippet: string
  createdAt: string
}

export interface ChatSearchResults {
  contacts: ContactHit[]
  listings: ListingHit[]
  messages: MessageHit[]
}

export const EMPTY_RESULTS: ChatSearchResults = { contacts: [], listings: [], messages: [] }

/**
 * 会话列表里匹配「联系人」与「商品名」。
 *
 * 联系人按 `counterpart.nickname`（会话另一端）匹配；商品按 `listing.title` 匹配。
 * 两段都按列表原序（最近的在前），不再排序 —— 列表本身就是「最近聊的在前」。
 *
 * 联系人按 `counterpart.id`、商品按 `listing.id` **去重**：同一个卖家可能同时挂在几个
 * 会话上（不同商品），同一个商品也可能同时被几个买家聊着 —— 不去重就会出现几行同名的人 /
 * 同款同价的商品，用户分不清点哪个，而行 key 还会撞（`source + listingId`）；
 * 保留最先出现的（最近的会话）。
 */
export function matchConversations(
  conversations: readonly ConversationDto[],
  rawQuery: string,
): { contacts: ContactHit[]; listings: ListingHit[] } {
  const query = normalizeQuery(rawQuery)
  const contacts: ContactHit[] = []
  const listings: ListingHit[] = []
  if (query.length === 0) return { contacts, listings }
  const seenContacts = new Set<string>()
  const seenListings = new Set<string>()
  for (const item of conversations) {
    if (hit(item.counterpart.nickname, query)) {
      if (!seenContacts.has(item.counterpart.id) && contacts.length < MAX_CONTACT_HITS) {
        seenContacts.add(item.counterpart.id)
        contacts.push({
          kind: 'contact',
          conversationId: item.id,
          userId: item.counterpart.id,
          nickname: item.counterpart.nickname,
          avatarUrl: item.counterpart.avatarUrl,
          listingTitle: item.listing.title,
        })
      }
    }
    if (hit(item.listing.title, query)) {
      if (!seenListings.has(item.listing.id) && listings.length < MAX_CONVERSATION_LISTING_HITS) {
        seenListings.add(item.listing.id)
        listings.push({
          kind: 'listing',
          listingId: item.listing.id,
          title: item.listing.title,
          priceCents: item.listing.priceCents,
          coverUrl: item.listing.coverUrl,
          source: 'conversation',
          conversationId: item.id,
        })
      }
    }
  }
  return { contacts, listings }
}

/**
 * 一个会话的消息里匹配聊天记录。
 *
 * 只认 `TEXT` 且**未被撤回**的消息：
 * - `SYSTEM` 是交易事件文案，不是谁说的话，搜到也没法定位到「谁说的」；
 * - `LISTING` 卡片的 `content` 是商品公开 id（`lst_…`，见 `packages/contracts/src/chat/schema.ts`），
 *   不是标题 —— 搜它没有意义，商品由「商品」段负责；
 * - 撤回的消息正文仍是原内容，但用户在会话里已经看不到了，搜出来点不进上下文。
 */
export function matchConversationMessages(
  conversation: ConversationDto,
  messages: readonly MessageDto[],
  rawQuery: string,
): MessageHit[] {
  const query = normalizeQuery(rawQuery)
  if (query.length === 0) return []
  const hits: MessageHit[] = []
  for (const message of messages) {
    if (message.type !== 'TEXT') continue
    if (message.recalledAt !== null) continue
    if (!hit(message.content, query)) continue
    hits.push({
      kind: 'message',
      conversationId: conversation.id,
      messageId: message.id,
      nickname: conversation.counterpart.nickname,
      avatarUrl: conversation.counterpart.avatarUrl,
      snippet: snippetOf(message.content, query),
      createdAt: message.createdAt,
    })
  }
  return hits
}

/** 聊天记录全局排序：新的在前（同一会话内也是新的在前），并截断到 `MAX_MESSAGE_HITS` */
export function sortMessageHits(hits: readonly MessageHit[]): MessageHit[] {
  return [...hits]
    .sort((a, b) => {
      const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt)
      return Number.isNaN(delta) ? 0 : delta
    })
    .slice(0, MAX_MESSAGE_HITS)
}

/**
 * 合并「自己会话里的商品」与「全站搜到的商品」。
 *
 * 去重按 `listingId`：同一条商品既在自己聊过、又出现在全站结果里时只留一条，
 * 且保留 `source: 'conversation'`（点进去落在会话，比落在详情页更贴近用户当前在做的事）。
 *
 * **不再按标题重筛服务端结果**：`GET /listings?q=` 的匹配范围是 title + description
 * （`apps/api/src/modules/listings/store.ts`，契约 §2.1），客户端只看 `title` 会把
 * 「九成新」「面交」这类只出现在描述里的命中整段丢掉，表现为「明明有货却说没找到」。
 * 服务端给了什么就信什么，本地只做去重与截断。
 */
export function mergeMarketListings(
  conversationHits: readonly ListingHit[],
  marketCards: readonly ListingCard[],
  limit = MAX_MARKET_HITS,
): ListingHit[] {
  const merged: ListingHit[] = [...conversationHits]
  const seen = new Set(merged.map((item) => item.listingId))
  for (const card of marketCards) {
    if (merged.length >= limit) break
    if (seen.has(card.id)) continue
    merged.push({
      kind: 'listing',
      listingId: card.id,
      title: card.title,
      priceCents: card.priceCents,
      coverUrl: card.coverUrl,
      source: 'market',
      conversationId: null,
    })
    seen.add(card.id)
  }
  return merged.slice(0, limit)
}

/** 结果是否为空（三段都没命中） */
export function isEmptyResults(results: ChatSearchResults): boolean {
  return (
    results.contacts.length === 0 && results.listings.length === 0 && results.messages.length === 0
  )
}

/** 这次搜索实际覆盖到的范围（决定「没命中」该怎么解释） */
export interface SearchCoverage {
  /** 会话列表当前形态（与 `list-view.ts` 的 `ChatListState` 同口径） */
  listState: ChatListState
  /** 这次实际扫了几个会话的消息（不是常量上限） */
  scanned: number
  /** 扫描时没连上服务器的会话数 */
  failedScans: number
  /** 全站商品检索是否失败 */
  marketFailed: boolean
}

/**
 * 一句话交代「这次到底搜了什么」—— 空态与结果区底注**共用这一份**。
 *
 * 为什么必须共用：这两处各写一份时，空结果路径把「没连上」说成「没有」、
 * 结果路径说了失败数而空态不提，同一屏里两种口径（审查连抓两轮）。
 *
 * 四种「没有结果」的原因要分开说，不能糊成「换个词试试」：
 * - 会话列表**加载失败** → 本地两段根本没搜（不是没有，是没搜到）；
 * - 会话列表**还在加载**（`scanned === 0`）→ 只搜了全站商品；
 * - 列表加载成功但**账号确实没有会话**（`empty`）→ 不是「还没加载出来」；
 * - 全站商品**请求失败** → 商品段也没搜成。
 */
export function describeSearchCoverage(coverage: SearchCoverage): string {
  if (coverage.listState === 'error') {
    return coverage.marketFailed
      ? '会话列表和全站商品都没连上服务器，这次什么都没搜成'
      : '会话列表没加载出来，联系人和聊天记录都没搜，这次只搜了全站商品'
  }
  const local =
    coverage.scanned > 0
      ? `${scopePrefix(coverage.scanned)}${describeScanScope(coverage)}`
      : coverage.listState === 'empty'
        ? '你还没有任何会话'
        : '会话列表还没加载完'
  const market = coverage.marketFailed
    ? '；全站商品也没连上服务器'
    : coverage.scanned > 0
      ? '和全站商品'
      : '，这次只搜了全站商品'
  return `${local}${market}`
}

/** 「只」只有在真的被上限截断时才敢说 —— 会话不足 10 个时说「只搜了 2 个」会让人以为被砍过 */
function scopePrefix(scanned: number): string {
  return scanned >= MAX_MESSAGE_SCAN_CONVERSATIONS ? '只搜了' : '搜了'
}

/** 「最近 N 个会话（其中 M 个没连上）」—— 空态与底注共用的同一段范围描述 */
function describeScanScope(coverage: SearchCoverage): string {
  return `最近 ${coverage.scanned} 个会话${
    coverage.failedScans > 0 ? `（其中 ${coverage.failedScans} 个没连上）` : ''
  }`
}

/** 结果区底注需要的上下文（比 `SearchCoverage` 多两样：命中有几条、每个会话取多深） */
export interface MessageFooterInput extends SearchCoverage {
  /** 聊天记录这次命中几条 */
  hits: number
  /** 每个会话只取了最近多少条消息（`MESSAGE_PAGE_LIMIT`） */
  depth: number
}

/**
 * 结果区底注：聊天记录这一段到底盖了多大、有没有漏搜。
 *
 * **有命中时也必须说失败数**：10 个会话里 3 个没连上，只写「仅搜索最近 10 个会话」
 * 会让用户以为「这 10 个里就这些」，实际那 3 个压根没读到 —— 这正是空态那条
 * 「把没搜成说成没有」在结果路径上的同一形态，所以两者共用 `describeScanScope`。
 */
export function describeMessageFooter(input: MessageFooterInput): string {
  if (input.scanned === 0) return `聊天记录没有搜：${describeSearchCoverage(input)}`
  const scope = describeScanScope(input)
  const body =
    input.hits > 0
      ? `聊天记录仅搜索${scope}，点结果进入该会话`
      : `聊天记录没有命中（${scopePrefix(input.scanned)}${scope}）`
  return `${body}（每个会话只取最近 ${input.depth} 条消息）`
}
