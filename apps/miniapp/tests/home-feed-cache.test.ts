import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { MockListing } from '../src/mock/types'

/**
 * 首页 feed 快照（SWR「先上屏旧数据」那一半）的存储契约。
 *
 * 这个模块是**存储层**：它读的是用户可清、可损坏、可被旧版本写乱的外部状态，
 * 所以每条用例守的都是「宁可没有快照，也不能把坏数据当列表上屏」：
 * 结构坏一件 / 过了期 / 换了账号 / 分类对不上 —— 一律返回 `null`，由页面退回骨架屏。
 *
 * 为什么用 `mock.module`：`feed-cache.ts` 与 `lib/session.ts` 都 `import Taro`，
 * 而 Bun 下加载真 Taro 会抛 `ENABLE_INNER_HTML is not defined`
 * （手法同 `tests/recommendation-viewer.test.ts` / `tests/recommendation-queue.test.ts`）。
 */
const SNAPSHOT_KEY = 'fish.home.feedSnapshot'
const SESSION_KEY = 'fish:session'

const store = new Map<string, unknown>()

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => store.get(key) ?? '',
    setStorageSync: (key: string, data: unknown) => {
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
  },
}))

const { clearHomeFeedSnapshot, readHomeFeedSnapshot, writeHomeFeedSnapshot } = await import(
  '../src/features/home/feed-cache'
)

function listing(id: string): MockListing {
  return {
    id,
    title: `商品 ${id}`,
    priceCents: 1200,
    originalPriceCents: null,
    category: 'DIGITAL',
    sub: '数码',
    condition: 'LIKE_NEW',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: 'https://example.test/cover.jpg',
    images: ['https://example.test/cover.jpg'],
    ratio: '4x5',
    badge: null,
    description: '描述',
    spec: '规格',
    sellerId: 'usr_01',
    seller: null,
    views: 3,
    wants: 1,
    createdHoursAgo: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function items(count: number, prefix = 'lst'): MockListing[] {
  return Array.from({ length: count }, (_unused, index) => listing(`${prefix}_${index}`))
}

/** 以「登录态」写入：会话 cookie 决定身份指纹（见 `feed-cache` 文件头第 2 条） */
function loginAs(cookie: string): void {
  store.set(SESSION_KEY, cookie)
}

const NOW = 1_700_000_000_000

beforeEach(() => {
  store.clear()
  loginAs('fish_session=aaaaaaaa1111')
})

describe('读写往返', () => {
  test('没存过 → null（页面据此走骨架屏，不是错误）', () => {
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })

  test('同一个身份、同一个分类：写进去能原样读回来', () => {
    const saved = items(3)
    writeHomeFeedSnapshot('ALL', saved, NOW)
    const snapshot = readHomeFeedSnapshot('ALL', NOW + 1000)
    expect(snapshot).not.toBeNull()
    expect(snapshot?.savedAt).toBe(NOW)
    expect(snapshot?.items.map((item) => item.id)).toEqual(saved.map((item) => item.id))
  })

  test('删掉整份快照后读不到（退出登录时调用）', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    clearHomeFeedSnapshot()
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })
})

describe('失效判定：过期 / 换账号 / 分类对不上', () => {
  test('超过 30 分钟 → null（价格与在售状态可能已经变了）', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    expect(readHomeFeedSnapshot('ALL', NOW + 30 * 60 * 1000)).not.toBeNull()
    expect(readHomeFeedSnapshot('ALL', NOW + 30 * 60 * 1000 + 1)).toBeNull()
  })

  test('savedAt 在未来（用户改过系统时间）→ 按过期处理', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    expect(readHomeFeedSnapshot('ALL', NOW - 1)).toBeNull()
  })

  test('换了账号 → 整份丢弃，不把上一个人的列表给新用户看', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    loginAs('fish_session=bbbbbbbb2222')
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })

  test('退出登录后变成匿名身份 → 也不复用登录态的列表', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    store.delete(SESSION_KEY)
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })

  test('分类之间互不串用：写了「推荐」不能拿来填「教材书籍」', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    expect(readHomeFeedSnapshot('BOOKS', NOW)).toBeNull()
  })
})

describe('结构校验：坏一件就整条作废', () => {
  test('缺封面（白卡）→ null', () => {
    writeHomeFeedSnapshot('ALL', items(2), NOW)
    const stored = store.get(SNAPSHOT_KEY) as {
      entries: Record<string, { items: Record<string, unknown>[] }>
    }
    const broken = stored.entries.ALL?.items[1]
    if (!broken) throw new Error('测试数据没写进去')
    delete broken.coverUrl
    store.set(SNAPSHOT_KEY, stored)
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })

  test('比例认不出（图片区高度会算成 undefined）→ null', () => {
    writeHomeFeedSnapshot('ALL', items(1), NOW)
    const stored = store.get(SNAPSHOT_KEY) as {
      entries: Record<string, { items: Record<string, unknown>[] }>
    }
    const first = stored.entries.ALL?.items[0]
    if (!first) throw new Error('测试数据没写进去')
    first.ratio = '9x16'
    store.set(SNAPSHOT_KEY, stored)
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })

  test('价格不是数字（会渲染成 NaN）→ null', () => {
    writeHomeFeedSnapshot('ALL', items(1), NOW)
    const stored = store.get(SNAPSHOT_KEY) as {
      entries: Record<string, { items: Record<string, unknown>[] }>
    }
    const first = stored.entries.ALL?.items[0]
    if (!first) throw new Error('测试数据没写进去')
    first.priceCents = '1200'
    store.set(SNAPSHOT_KEY, stored)
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })

  test('存储里是字符串 / 旧结构 / 垃圾 → null，不抛错', () => {
    store.set(SNAPSHOT_KEY, 'not-an-object')
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
    store.set(SNAPSHOT_KEY, { v: 99, viewer: 'anon', entries: {} })
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
    store.set(SNAPSHOT_KEY, { v: 1, viewer: 'anon', entries: { ALL: 'nope' } })
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })
})

describe('写入侧的裁剪', () => {
  test('空列表不写：只会让下次进页闪一下空态再被网络翻案', () => {
    writeHomeFeedSnapshot('ALL', [], NOW)
    expect(store.has(SNAPSHOT_KEY)).toBe(false)
  })

  test('最多留 30 件（首屏一页 24 件，留 30 够用）', () => {
    writeHomeFeedSnapshot('ALL', items(40), NOW)
    expect(readHomeFeedSnapshot('ALL', NOW)?.items).toHaveLength(30)
  })

  test('最多留 3 个分类，超出丢最旧的', () => {
    writeHomeFeedSnapshot('ALL', items(1, 'a'), NOW)
    writeHomeFeedSnapshot('BOOKS', items(1, 'b'), NOW + 1)
    writeHomeFeedSnapshot('DIGITAL', items(1, 'c'), NOW + 2)
    writeHomeFeedSnapshot('SPORTS', items(1, 'd'), NOW + 3)
    const stored = store.get(SNAPSHOT_KEY) as { entries: Record<string, unknown> }
    expect(Object.keys(stored.entries).sort()).toEqual(['DIGITAL', 'SPORTS', 'BOOKS'].sort())
    // 被丢掉的正是最早那条
    expect(readHomeFeedSnapshot('ALL', NOW)).toBeNull()
  })
})
