import { describe, expect, test } from 'bun:test'
import type { ConversationDto, MessageDto } from '@fish/contracts/chat/schema'
import type { ListingCard } from '@fish/contracts/listings/schema'
import {
  type ChatSearchResults,
  describeMessageFooter,
  describeSearchCoverage,
  EMPTY_RESULTS,
  hasQuery,
  isEmptyResults,
  MAX_CONTACT_HITS,
  MAX_CONVERSATION_LISTING_HITS,
  MAX_MESSAGE_HITS,
  matchConversationMessages,
  matchConversations,
  mergeMarketListings,
  normalizeQuery,
  shouldRerunSearch,
  snippetOf,
  sortMessageHits,
} from '../src/pages/chat/search'

/**
 * 消息页搜索（#669 V1，纯端上）。
 *
 * 这里锁的是「搜出来的东西与用户要的不是一回事」那一类缺陷：大小写/空白把本该命中的
 * 会话漏掉、把撤回的消息当正文搜出来、同一个商品在三段里重复出现、结果里混进没命中
 * 的条目、以及「没找到」被解释错原因。组件接线（页面怎么调用这些函数）由
 * `tests/chat-search-wiring.test.ts` 按源码文本钉住（本仓没有 Taro 组件渲染基建）。
 */

function conversation(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'c-1',
    listingId: 'l-1',
    role: 'buyer',
    listing: {
      id: 'l-1',
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE',
      coverUrl: null,
    },
    counterpart: { id: 'u-2', nickname: '卖家小鱼', avatarUrl: null },
    counterpartPresence: { online: false, lastActiveAt: null },
    unreadCount: 0,
    counterpartLastReadAt: null,
    lastMessage: null,
    lastMessageAt: '2026-09-21T04:00:00.000Z',
    createdAt: '2026-09-21T03:00:00.000Z',
    ...overrides,
  }
}

function message(overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: 'm-1',
    conversationId: 'c-1',
    senderId: 'u-2',
    sender: { id: 'u-2', nickname: '卖家小鱼', avatarUrl: null },
    type: 'TEXT',
    content: '键盘还在，晚上可以面交',
    listing: null,
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-09-21T04:00:00.000Z',
    ...overrides,
  }
}

function card(overrides: Partial<ListingCard> = {}): ListingCard {
  return {
    id: 'l-9',
    title: 'K380 蓝牙键盘（全新）',
    priceCents: 9900,
    category: 'DIGITAL',
    condition: 'LIKE_NEW',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-20T04:00:00.000Z',
    wants: 3,
    views: 20,
    ...overrides,
  }
}

describe('normalizeQuery —— 输入归一', () => {
  test('去首尾空白、折叠中间空白、转小写', () => {
    expect(normalizeQuery('  K380  ')).toBe('k380')
    expect(normalizeQuery('K380   键盘')).toBe('k380 键盘')
    // 只有空白等于没输入：不该发请求
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('snippetOf —— 命中片段带上下文', () => {
  test('长正文截一段带省略号，短正文原样', () => {
    expect(snippetOf('短的', '短')).toBe('短的')
    const long = '前面一堆铺垫的话然后才是键盘这两个字后面还有很多别的字'
    const cut = snippetOf(long, '键盘', 4)
    expect(cut).toContain('键盘')
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('…')).toBe(true)
  })
})

describe('matchConversations —— 联系人与会话内商品', () => {
  test('昵称命中进联系人，商品标题命中进商品段，各自带会话 id', () => {
    const list = [conversation()]
    const byName = matchConversations(list, '小鱼')
    expect(byName.contacts.map((item) => item.nickname)).toEqual(['卖家小鱼'])
    expect(byName.contacts[0]?.conversationId).toBe('c-1')
    expect(byName.listings).toHaveLength(0)

    const byListing = matchConversations(list, 'k380')
    expect(byListing.contacts).toHaveLength(0)
    expect(byListing.listings).toHaveLength(1)
    // 会话内商品点进去要能开那个会话，不是商品详情
    expect(byListing.listings[0]).toMatchObject({ source: 'conversation', conversationId: 'c-1' })
  })

  test('大小写不敏感；都不命中时两段皆空', () => {
    const list = [conversation()]
    expect(matchConversations(list, 'K380').listings).toHaveLength(1)
    expect(matchConversations(list, '完全不相关').contacts).toHaveLength(0)
    expect(matchConversations(list, '完全不相关').listings).toHaveLength(0)
  })
})

describe('matchConversationMessages —— 只搜真正能看的文本消息', () => {
  const conv = conversation()

  test('命中的 TEXT 消息给出昵称、片段与时间', () => {
    const hits = matchConversationMessages(conv, [message()], '面交')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      conversationId: 'c-1',
      messageId: 'm-1',
      nickname: '卖家小鱼',
    })
    expect(hits[0]?.snippet).toContain('面交')
  })

  test('已撤回的消息不参与搜索（正文还在库里，但不能被搜出来）', () => {
    const recalled = message({ recalledAt: '2026-09-21T05:00:00.000Z' })
    expect(matchConversationMessages(conv, [recalled], '面交')).toHaveLength(0)
  })

  test('SYSTEM / LISTING 消息不参与搜索', () => {
    const system = message({ type: 'SYSTEM', content: '面交已确认', senderId: null, sender: null })
    const listing = message({ type: 'LISTING', content: '面交商品' })
    expect(matchConversationMessages(conv, [system, listing], '面交')).toHaveLength(0)
  })

  test('空关键词返回空', () => {
    expect(matchConversationMessages(conv, [message()], '   ')).toHaveLength(0)
  })
})

describe('sortMessageHits —— 新的在前并截断', () => {
  test('按 createdAt 降序，超过上限截断', () => {
    const hits = Array.from({ length: MAX_MESSAGE_HITS + 5 }, (_, index) => ({
      kind: 'message' as const,
      conversationId: 'c-1',
      messageId: `m-${index}`,
      nickname: '卖家小鱼',
      avatarUrl: null,
      snippet: '键盘',
      createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString(),
    }))
    const sorted = sortMessageHits(hits)
    expect(sorted).toHaveLength(MAX_MESSAGE_HITS)
    expect(sorted[0]?.messageId).toBe(`m-${MAX_MESSAGE_HITS + 4}`)
  })
})

describe('mergeMarketListings —— 会话优先 + 去重 + 截断', () => {
  test('同 id 只留会话那条，其余全站商品补齐', () => {
    const inChat = matchConversations([conversation()], 'k380').listings
    const merged = mergeMarketListings(inChat, [card({ id: 'l-1' }), card({ id: 'l-9' })])
    // l-1 在会话里已经出现过，不再重复；l-9 补进来且没有会话可进
    expect(merged.map((item) => item.listingId)).toEqual(['l-1', 'l-9'])
    expect(merged[0]?.source).toBe('conversation')
    expect(merged[1]).toMatchObject({ source: 'market', conversationId: null })
  })

  /**
   * 服务端的结果**原样采信**：`GET /listings?q=` 的匹配范围是 title + description
   * （`apps/api/src/modules/listings/store.ts`，契约 §2.1）。这里若再按标题筛一遍，
   * 「九成新」「面交」这种只出现在描述里的命中会被客户端整段丢掉，用户看到的是
   * 「明明有货却说没找到」。
   */
  test('标题对不上的全站商品也保留（描述命中由服务端判定）', () => {
    const merged = mergeMarketListings([], [card({ id: 'l-d', title: '罗技无线键盘' })])
    expect(merged.map((item) => item.listingId)).toEqual(['l-d'])
    expect(merged[0]).toMatchObject({ source: 'market', conversationId: null })
  })

  test('商品段受上限约束', () => {
    const many = Array.from({ length: 30 }, (_, index) =>
      card({ id: `l-m${index}`, title: `K380 键盘 ${index}` }),
    )
    expect(mergeMarketListings([], many)).toHaveLength(10)
  })
})

describe('hasQuery —— 只有空白等于还没输入', () => {
  test('空串 / 纯空白不是有效查询，有字才是', () => {
    // 这条守的是「刚点开搜索框就显示『没有找到「」』」那个缺陷：
    // 空查询必须走「还没输入」的提示态，而不是空结果态。
    expect(hasQuery('')).toBe(false)
    expect(hasQuery('   ')).toBe(false)
    expect(hasQuery('　')).toBe(false)
    expect(hasQuery(' k ')).toBe(true)
  })
})

describe('matchConversations —— 联系人按人去重并封顶', () => {
  test('同一卖家挂多个会话只出现一次，且联系人段有上限', () => {
    const sameSeller = [conversation(), conversation({ id: 'c-2', listingId: 'l-2' })]
    expect(
      matchConversations(sameSeller, '卖家小鱼').contacts.map((c) => c.conversationId),
    ).toEqual(['c-1'])

    const many = Array.from({ length: MAX_CONTACT_HITS + 5 }, (_, index) =>
      conversation({
        id: `c-${index}`,
        counterpart: { id: `u-${index}`, nickname: `卖家小鱼 ${index}`, avatarUrl: null },
      }),
    )
    expect(matchConversations(many, '卖家小鱼').contacts).toHaveLength(MAX_CONTACT_HITS)
  })
})

describe('matchConversationMessages —— 正文里的连续空白不影响命中', () => {
  test('消息正文「k380  键盘」能被「k380 键盘」搜到', () => {
    const hits = matchConversationMessages(
      conversation(),
      [message({ content: 'k380　 键盘\n还在' })],
      'k380 键盘',
    )
    expect(hits).toHaveLength(1)
  })
})

describe('isEmptyResults —— 三段都空才算没找到', () => {
  test('任一段有命中就不是空结果', () => {
    expect(isEmptyResults(EMPTY_RESULTS)).toBe(true)
    const onlyContact: ChatSearchResults = {
      ...EMPTY_RESULTS,
      contacts: [
        {
          kind: 'contact',
          conversationId: 'c-1',
          userId: 'u-2',
          nickname: '卖家小鱼',
          avatarUrl: null,
          listingTitle: 'K380 键盘',
        },
      ],
    }
    expect(isEmptyResults(onlyContact)).toBe(false)
  })
})

describe('matchConversations —— 会话内商品按同一条商品去重', () => {
  test('同一商品挂在多个买家会话上时只出一行（行 key 撞了会丢行、也没法区分点哪个）', () => {
    // 卖家侧真实形态：一件商品同时在跟几个买家聊，会话列表里是几条不同会话、同一个 listing.id。
    // 不去重则商品段出现几行完全相同的标题/价格，React key（source + listingId）也重复。
    const sameListing = {
      id: 'l-keyboard',
      title: 'K380 键盘',
      priceCents: 16000,
      status: 'ACTIVE' as const,
      coverUrl: null,
    }
    const rows = [
      conversation({ id: 'c-buyer-1', listingId: 'l-keyboard', listing: sameListing }),
      conversation({ id: 'c-buyer-2', listingId: 'l-keyboard', listing: sameListing }),
      conversation({ id: 'c-buyer-3', listingId: 'l-keyboard', listing: sameListing }),
    ]
    const listings = matchConversations(rows, '键盘').listings
    expect(listings).toHaveLength(1)
    // 保留最先出现的（最近的会话）
    expect(listings[0]?.conversationId).toBe('c-buyer-1')
  })
})

describe('matchConversations —— 会话内商品不能挤掉全站结果', () => {
  test('会话内商品封顶 8 条，合并后仍给全站留出名额', () => {
    // 会话内商品最多会有 50 条（每个会话一条）。不单独封顶时它能把十条名额吃满，
    // 全站命中一条都显示不出来 —— 用户以为「全站没有」，其实是被自己聊过的挤掉了。
    const many = Array.from({ length: 20 }, (_, index) =>
      conversation({
        id: `c-${index}`,
        listingId: `l-${index}`,
        listing: {
          id: `l-${index}`,
          title: `K380 键盘 ${index}`,
          priceCents: 16000,
          status: 'ACTIVE',
          coverUrl: null,
        },
      }),
    )
    const local = matchConversations(many, '键盘').listings
    expect(local).toHaveLength(MAX_CONVERSATION_LISTING_HITS)

    const market = Array.from({ length: 5 }, (_, index) =>
      card({ id: `m-${index}`, title: `全站键盘 ${index}` }),
    )
    const merged = mergeMarketListings(local, market)
    expect(merged).toHaveLength(10)
    expect(merged.filter((item) => item.source === 'market')).toHaveLength(2)
  })
})

/**
 * 范围说明是所有「没找到」解释的唯一来源：空态与结果区底注共用它。
 * 每条用例对应一种**不同的没找到原因** —— 混成一句「换个词试试」正是在说假话。
 */
describe('describeSearchCoverage —— 每种「没找到」都要说清原因', () => {
  test('会话列表加载失败：本地两段根本没搜', () => {
    expect(
      describeSearchCoverage({
        listState: 'error',
        scanned: 0,
        failedScans: 0,
        marketFailed: false,
      }),
    ).toBe('会话列表没加载出来，联系人和聊天记录都没搜，这次只搜了全站商品')
  })

  test('会话列表与全站商品都失败：什么都没搜成', () => {
    expect(
      describeSearchCoverage({
        listState: 'error',
        scanned: 0,
        failedScans: 0,
        marketFailed: true,
      }),
    ).toBe('会话列表和全站商品都没连上服务器，这次什么都没搜成')
  })

  test('列表还在加载：不能说成「你还没有会话」', () => {
    expect(
      describeSearchCoverage({
        listState: 'loading',
        scanned: 0,
        failedScans: 0,
        marketFailed: false,
      }),
    ).toBe('会话列表还没加载完，这次只搜了全站商品')
  })

  test('列表加载成功但确实没有会话：不能说成「还没加载出来」', () => {
    expect(
      describeSearchCoverage({
        listState: 'empty',
        scanned: 0,
        failedScans: 0,
        marketFailed: false,
      }),
    ).toBe('你还没有任何会话，这次只搜了全站商品')
  })

  test('正常扫过 N 个会话：如实给数量', () => {
    expect(
      describeSearchCoverage({
        listState: 'list',
        scanned: 10,
        failedScans: 0,
        marketFailed: false,
      }),
    ).toBe('只搜了最近 10 个会话和全站商品')
  })

  test('扫的时候有会话没连上：失败数必须露出来，不能算成没命中', () => {
    expect(
      describeSearchCoverage({
        listState: 'list',
        scanned: 10,
        failedScans: 3,
        marketFailed: false,
      }),
    ).toBe('只搜了最近 10 个会话（其中 3 个没连上）和全站商品')
  })

  test('商品段失败：范围里不能说「和全站商品」', () => {
    expect(
      describeSearchCoverage({
        listState: 'list',
        scanned: 10,
        failedScans: 0,
        marketFailed: true,
      }),
    ).toBe('只搜了最近 10 个会话；全站商品也没连上服务器')
    expect(
      describeSearchCoverage({
        listState: 'empty',
        scanned: 0,
        failedScans: 0,
        marketFailed: true,
      }),
    ).toBe('你还没有任何会话；全站商品也没连上服务器')
  })

  test('会话不足上限时不能说「只」：没被截断就没有「只」', () => {
    expect(
      describeSearchCoverage({
        listState: 'list',
        scanned: 3,
        failedScans: 0,
        marketFailed: false,
      }),
    ).toBe('搜了最近 3 个会话和全站商品')
  })

  test('搜完之后列表刷新失败：事实优先，不能说成「都没搜」', () => {
    // 真实路径：结果已出 → 点进会话 → 返回时 useDidShow 重拉列表失败 →
    // listState 变 error，但这一轮确实扫过 10 个会话、屏幕上还摆着命中
    expect(
      describeSearchCoverage({
        listState: 'error',
        scanned: 10,
        failedScans: 1,
        marketFailed: false,
      }),
    ).toBe('只搜了最近 10 个会话（其中 1 个没连上）和全站商品')
  })
})

/**
 * 补跑判据是搜索里唯一的时序逻辑：用源码文本断言只能证明「这行还在」，
 * 证明不了「哪种跃迁该跑、哪种不该跑」。
 */
describe('shouldRerunSearch —— 只有「列表刚就绪」那一次才补跑', () => {
  test('loading → list：补跑', () => {
    expect(shouldRerunSearch('loading', 'list', '键盘')).toBe(true)
  })

  test('error → list：补跑（重试成功后也要补）', () => {
    expect(shouldRerunSearch('error', 'list', '键盘')).toBe(true)
  })

  test('loading → empty：补跑（账号确实没有会话，也要给一次结论）', () => {
    expect(shouldRerunSearch('loading', 'empty', '键盘')).toBe(true)
  })

  test('list → list：不补（从会话页返回重拉列表，不能打断已经看到的结果）', () => {
    expect(shouldRerunSearch('list', 'list', '键盘')).toBe(false)
  })

  test('list → error：不补（没有可搜的东西，补跑只会再失败一次）', () => {
    expect(shouldRerunSearch('list', 'error', '键盘')).toBe(false)
  })

  test('关键词为空：不补（还没开始搜）', () => {
    expect(shouldRerunSearch('loading', 'list', '   ')).toBe(false)
  })
})

/**
 * 结果区底注：有命中时也必须交代「有几个会话没读到」，
 * 否则用户会把「10 个里就这些」当成结论，实际有 3 个压根没搜成。
 */
describe('describeMessageFooter —— 有命中时也要说清漏搜', () => {
  const base = {
    listState: 'list' as const,
    scanned: 10,
    failedScans: 0,
    marketFailed: false,
    depth: 100,
  }

  test('有命中 + 全部会话都读到：说范围与深度', () => {
    expect(describeMessageFooter({ ...base, hits: 2 })).toBe(
      '聊天记录仅搜索最近 10 个会话，点结果进入该会话（每个会话只取最近 100 条消息）',
    )
  })

  test('有命中 + 有会话没连上：失败数不能被吞掉', () => {
    expect(describeMessageFooter({ ...base, failedScans: 3, hits: 2 })).toBe(
      '聊天记录仅搜索最近 10 个会话（其中 3 个没连上），点结果进入该会话（每个会话只取最近 100 条消息）',
    )
  })

  test('没有命中：复用空态那套范围说法', () => {
    expect(describeMessageFooter({ ...base, hits: 0 })).toBe(
      '聊天记录没有命中（只搜了最近 10 个会话）（每个会话只取最近 100 条消息）',
    )
  })

  test('一个会话都没扫（列表没就绪）：说「没有搜」而不是「没有命中」', () => {
    expect(
      describeMessageFooter({
        listState: 'loading',
        scanned: 0,
        failedScans: 0,
        marketFailed: false,
        hits: 0,
        depth: 100,
      }),
    ).toBe('聊天记录没有搜：会话列表还没加载完，这次只搜了全站商品')
  })
})
