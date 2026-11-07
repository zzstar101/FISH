import { expect, mock, test } from 'bun:test'
import type { MockListing } from '../src/mock/types'

mock.module('@tarojs/taro', () => ({ default: {} }))
const {
  createHomeFeedCache,
  HOME_FEED_SNAPSHOT_MAX_BYTES,
  HOME_FEED_SNAPSHOT_MAX_ITEMS,
  HOME_FEED_SNAPSHOT_TTL_MS,
} = await import('../src/features/home/feed-cache')

const KEY = 'fish:home.feed-snapshot:'

/** 一条形状合法的条目；需要「写坏的字节」时在 `overrides` 里覆盖 */
function listing(id: string, overrides: Record<string, unknown> = {}): MockListing {
  return {
    id,
    title: `标题 ${id}`,
    priceCents: 1200,
    originalPriceCents: null,
    category: 'DIGITAL',
    sub: '',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: 'assets/covers/digital-headphone.png',
    images: ['assets/covers/digital-headphone.png'],
    ratio: '4x5',
    badge: null,
    description: '',
    spec: '',
    sellerId: 'seller-1',
    seller: {
      id: 'seller-1',
      nickname: '同学',
      avatarUrl: null,
      authStatus: 'VERIFIED',
      soldCount: null,
      goodRate: null,
    },
    views: 3,
    wants: 1,
    createdHoursAgo: 2,
    createdAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  } as MockListing
}

function fixture(initialViewer = 'auth:alice') {
  const disk = new Map<string, unknown>()
  let current = initialViewer
  let now = 1_000_000
  const storage = {
    get: (key: string) => disk.get(key),
    set: (key: string, value: string) => {
      disk.set(key, value)
    },
    remove: (key: string) => {
      disk.delete(key)
    },
  }
  const cache = createHomeFeedCache(
    storage,
    () => current,
    () => now,
  )
  return {
    cache,
    disk,
    storage,
    /** 换账号 / 退出后调用：同一台设备上「现在是谁」变了 */
    switchViewer: (next: string) => {
      current = next
    },
    advance: (ms: number) => {
      now += ms
    },
    clock: () => now,
    /** 绕过 `write` 直接塞字节，模拟写坏的 / 别的版本留下的存储 */
    poke: (scope: string, value: unknown) => {
      disk.set(`${KEY}${scope}`, value)
    },
  }
}

test('成功一次就能在下次进页读到同一批（按分类隔离）', () => {
  const f = fixture()
  expect(f.cache.write('ALL', [listing('a'), listing('b')], 'auth:alice')).toBe(true)
  expect(f.cache.write('BOOKS', [listing('c')], 'auth:alice')).toBe(true)

  expect(f.cache.read('ALL')?.items.map((item) => item.id)).toEqual(['a', 'b'])
  expect(f.cache.read('BOOKS')?.items.map((item) => item.id)).toEqual(['c'])
  // 没写过的分类没有快照（不能拿别的分类顶）
  expect(f.cache.read('DIGITAL')).toBeNull()
  // 读出来的是要上屏的东西，不是要归因的东西
  expect(f.cache.read('ALL')?.savedAt).toBe(f.clock())
})

test('换账号 / 退出后读到上一身份的快照：作废，且从存储里清掉', () => {
  const f = fixture()
  expect(f.cache.write('ALL', [listing('a')], 'auth:alice')).toBe(true)
  expect(f.cache.read('ALL')).not.toBeNull()

  f.switchViewer('auth:bob')
  expect(f.cache.read('ALL')).toBeNull()
  expect(f.disk.size).toBe(0)
})

test('请求在途时账号被切走：旧请求晚到不许写进新身份名下', () => {
  const f = fixture()
  const viewerAtRequest = f.cache.viewer()
  expect(viewerAtRequest).toBe('auth:alice')
  // 请求还没回来，用户退出并登录了另一个号
  f.switchViewer('auth:bob')
  expect(f.cache.write('ALL', [listing('a')], viewerAtRequest)).toBe(false)
  expect(f.disk.size).toBe(0)
  expect(f.cache.read('ALL')).toBeNull()
})

test('超过 TTL 就作废（并且顺手清掉），未来时间戳同样不信', () => {
  const f = fixture()
  expect(f.cache.write('ALL', [listing('a')], 'auth:alice')).toBe(true)

  f.advance(HOME_FEED_SNAPSHOT_TTL_MS)
  expect(f.cache.read('ALL')).not.toBeNull()

  f.advance(1)
  expect(f.cache.read('ALL')).toBeNull()
  expect(f.disk.size).toBe(0)

  // 设备时钟往回调过（写入时间戳比现在还新）：宁可当过期
  f.poke(
    'ALL',
    JSON.stringify({
      v: 1,
      viewer: 'auth:alice',
      savedAt: f.clock() + 5000,
      items: [listing('a')],
    }),
  )
  expect(f.cache.read('ALL')).toBeNull()
})

test('版本不符 / JSON 坏掉：整条作废，不清屏也不抛', () => {
  const f = fixture()
  f.poke(
    'ALL',
    JSON.stringify({ v: 2, viewer: 'auth:alice', savedAt: f.clock(), items: [listing('a')] }),
  )
  expect(f.cache.read('ALL')).toBeNull()
  expect(f.disk.size).toBe(0)

  f.poke('ALL', '{ 这不是 JSON')
  expect(f.cache.read('ALL')).toBeNull()

  f.poke('ALL', JSON.stringify({ v: 1, viewer: 'auth:alice', savedAt: 'yesterday', items: [] }))
  expect(f.cache.read('ALL')).toBeNull()
})

test('坏条目只丢那一条，全坏才算没快照', () => {
  const f = fixture()
  f.poke(
    'ALL',
    JSON.stringify({
      v: 1,
      viewer: 'auth:alice',
      savedAt: f.clock(),
      items: [
        listing('good'),
        // 比例不在值域里：页面按它算卡片高度，留着会画塌
        listing('bad-ratio', { ratio: '9x9' }),
        // 价格不是数字
        listing('bad-price', { priceCents: '1200' }),
        // 卖家形状不对：卡片按「没有卖家信息」渲染，条目本身留着
        listing('bad-seller', { seller: { nickname: '缺 id' } }),
      ],
    }),
  )
  const snapshot = f.cache.read('ALL')
  expect(snapshot?.items.map((item) => item.id)).toEqual(['good', 'bad-seller'])
  expect(snapshot?.items[1]?.seller).toBeNull()

  f.poke('ALL', JSON.stringify({ v: 1, viewer: 'auth:alice', savedAt: f.clock(), items: [{}] }))
  expect(f.cache.read('ALL')).toBeNull()
})

test('空列表不写，超条数按上限截断', () => {
  const f = fixture()
  expect(f.cache.write('ALL', [], 'auth:alice')).toBe(false)
  expect(f.disk.size).toBe(0)

  const many = Array.from({ length: HOME_FEED_SNAPSHOT_MAX_ITEMS + 6 }, (_, i) => listing(`x${i}`))
  expect(f.cache.write('ALL', many, 'auth:alice')).toBe(true)
  expect(f.cache.read('ALL')?.items).toHaveLength(HOME_FEED_SNAPSHOT_MAX_ITEMS)
})

test('字节上限：超限的载荷不写，读到超限的字节也拒绝并清掉', () => {
  const f = fixture()
  // 条数没超，但撑爆字节上限：整条不写，不截断成一屏「部分结果」
  const fat = Array.from({ length: HOME_FEED_SNAPSHOT_MAX_ITEMS }, (_, i) =>
    listing(`x${i}`, { description: 'x'.repeat(5000) }),
  )
  expect(f.cache.write('ALL', fat, 'auth:alice')).toBe(false)
  expect(f.disk.size).toBe(0)

  // 不是本模块写的超大载荷：读侧同样拒绝，别把一大坨字节塞进渲染
  f.poke('ALL', 'x'.repeat(HOME_FEED_SNAPSHOT_MAX_BYTES))
  expect(f.cache.read('ALL')).toBeNull()
  expect(f.disk.size).toBe(0)
})

test('存储层抛错（配额满 / 读不到）不打断进页', () => {
  const f = fixture()
  const broken = createHomeFeedCache(
    {
      get: () => {
        throw new Error('storage exploded')
      },
      set: () => {
        throw new Error('storage exploded')
      },
      remove: () => {
        throw new Error('storage exploded')
      },
    },
    () => 'auth:alice',
    () => 1_000_000,
  )
  expect(broken.read('ALL')).toBeNull()
  expect(broken.write('ALL', [listing('a')], 'auth:alice')).toBe(false)
  // 正常那份不受影响
  expect(f.cache.write('ALL', [listing('a')], 'auth:alice')).toBe(true)
  expect(f.cache.read('ALL')?.items).toHaveLength(1)
})
