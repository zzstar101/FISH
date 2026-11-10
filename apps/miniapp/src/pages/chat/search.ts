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

/** 输入防抖：输入即搜，但不为每个按键发一次请求（400ms 内连打不重复搜） */
export const SEARCH_DEBOUNCE_MS = 300

/** 聊天记录扫描的会话上限：取列表里最近的这几个（列表已按 `lastMessageAt` 降序） */
export const MAX_MESSAGE_SCAN_CONVERSATIONS = 10

/** 聊天记录结果条数上限：再多就该给「查看全部」，V1 不做 */
export const MAX_MESSAGE_HITS = 20

/** 全站商品结果条数上限 */
export const MAX_MARKET_HITS = 10

/** 搜索词归一：去首尾空白 + 折叠连续空白 + 小写（英文昵称/型号大小写不敏感） */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 子串包含（大小写不敏感）。空串不算命中 —— 空搜索不该匹配全部。 */
function hit(haystack: string | null | undefined, query: string): boolean {
  if (query.length === 0) return false
  return (haystack ?? '').toLowerCase().includes(query)
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
 */
export function matchConversations(
  conversations: readonly ConversationDto[],
  rawQuery: string,
): { contacts: ContactHit[]; listings: ListingHit[] } {
  const query = normalizeQuery(rawQuery)
  const contacts: ContactHit[] = []
  const listings: ListingHit[] = []
  if (query.length === 0) return { contacts, listings }
  for (const item of conversations) {
    if (hit(item.counterpart.nickname, query)) {
      contacts.push({
        kind: 'contact',
        conversationId: item.id,
        userId: item.counterpart.id,
        nickname: item.counterpart.nickname,
        avatarUrl: item.counterpart.avatarUrl,
        listingTitle: item.listing.title,
      })
    }
    if (hit(item.listing.title, query)) {
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
  return { contacts, listings }
}

/**
 * 一个会话的消息里匹配聊天记录。
 *
 * 只认 `TEXT` 且**未被撤回**的消息：`SYSTEM` 是交易事件文案（不是谁说的话，搜到也没法
 * 定位到「谁说的」），`LISTING` 卡片正文就是商品标题（商品段已经覆盖）。撤回的消息
 * 正文仍是原内容，但用户在会话里已经看不到了，搜出来点不进上下文。
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
 */
export function mergeMarketListings(
  conversationHits: readonly ListingHit[],
  marketCards: readonly ListingCard[],
  rawQuery: string,
  limit = MAX_MARKET_HITS,
): ListingHit[] {
  const query = normalizeQuery(rawQuery)
  const merged: ListingHit[] = [...conversationHits]
  const seen = new Set(merged.map((item) => item.listingId))
  for (const card of marketCards) {
    if (merged.length >= limit) break
    if (seen.has(card.id)) continue
    if (!hit(card.title, query)) continue
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
