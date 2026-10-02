import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { FavoriteItem as ContractFavoriteItem } from '@fish/contracts/favorites/schema'
import type { ListingCard, ListingStatus } from '@fish/contracts/listings/schema'
import { VIEW_HISTORY_ROUTES } from '@fish/contracts/view-history/routes'
import type { ViewHistoryItem } from '@fish/contracts/view-history/schema'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'

/**
 * 浏览记录（#415 M1）的两层：
 *
 * 1. **API 请求构造**（`features/view-history/api`）：路径取自契约常量、query / method 正确、
 *    响应过 zod 收口 —— 替换 `@/lib/request` 的 `apiRequest` 一个依赖即可，手法同
 *    `wishes-api.test.ts` / `chat-media-api.test.ts`；
 * 2. **纯适配层**（`pkg-browse/pages/history/records`）：`goneLabelOf` / `recordCellOf` /
 *    `historyDaysOf` / `canClearTab`。
 *
 * 这里刻意**不做组件渲染**（本仓 tests/ 没有 Taro 组件基建），页面接线靠 code review。
 * `@tarojs/taro` 一并顶掉：为了把 `pages/favorites/list` 拉进来做「角标与收藏页同源」的
 * 交叉断言，Bun 下加载真 Taro 会在求值阶段抛（手法同 `favorites-list.test.ts`）。
 */

mock.module('@tarojs/taro', () => ({ default: {} }))

type ApiCall = { path: string; query?: Record<string, unknown>; method?: string; body?: unknown }

const calls: ApiCall[] = []
let response: unknown = null

mock.module('@/lib/request', () => ({
  apiRequest: (
    path: string,
    options: { query?: Record<string, unknown>; method?: string; body?: unknown } = {},
  ) => {
    calls.push({ path, query: options.query, method: options.method, body: options.body })
    return Promise.resolve(response)
  },
}))

const { clearMyViewHistory, fetchMyViewHistory } = await import('../src/features/view-history/api')
const { canClearTab, goneLabelOf, historyDaysOf, recordCellOf } = await import(
  '../src/pkg-browse/pages/history/records'
)
const { toFavoriteItems } = await import('../src/pkg-browse/pages/favorites/list')

const uuid = (n: number) => `01930000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`
const LISTING_ID = encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(11))

function card(over: Partial<ListingCard> = {}): ListingCard {
  return {
    id: LISTING_ID,
    title: '九成新山地车',
    priceCents: 38000,
    category: 'SPORTS',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    moderationStatus: null,
    ...over,
  }
}

function item(viewedAt: string, over: Partial<ListingCard> = {}): ViewHistoryItem {
  return { listing: card(over), viewedAt }
}

/** 用**本地分量**构造 ISO：保证「本地日」在任意时区都是同一天，标签断言不随 CI 时区漂。 */
const at = (y: number, m: number, d: number, h = 10, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString()

/** 契约收藏行：只填交叉断言真正读的字段 */
function saved(status: ListingStatus): ContractFavoriteItem {
  return {
    listing: card({ status }),
    favoritedAt: '2026-09-30T00:00:00.000Z',
  }
}

beforeEach(() => {
  calls.length = 0
  response = null
})

describe('fetchMyViewHistory —— 请求构造与 zod 收口', () => {
  test('默认取第一页、一页 20 条（路径取自契约常量）', async () => {
    response = { items: [item('2026-09-12T03:00:00.000Z')], nextCursor: 'next', total: 3 }
    const page = await fetchMyViewHistory()

    expect(calls).toEqual([
      {
        path: VIEW_HISTORY_ROUTES.myViewHistory,
        query: { limit: 20, cursor: undefined },
        method: undefined,
        body: undefined,
      },
    ])
    expect(page.total).toBe(3)
    expect(page.nextCursor).toBe('next')
    expect(page.items[0]?.viewedAt).toBe('2026-09-12T03:00:00.000Z')
  })

  test('limit / cursor 原样透传（游标只回传上一页的 nextCursor）', async () => {
    response = { items: [], nextCursor: null, total: 0 }
    await fetchMyViewHistory({ limit: 1 })
    await fetchMyViewHistory({ cursor: 'abc' })

    expect(calls[0]?.query).toEqual({ limit: 1, cursor: undefined })
    expect(calls[1]?.query).toEqual({ limit: 20, cursor: 'abc' })
  })

  test('响应形状漂移在解析处就炸（缺 total）', async () => {
    response = { items: [], nextCursor: null }
    await expect(fetchMyViewHistory()).rejects.toThrow()
  })

  test('失效商品也在 items 里：status 由适配层决定怎么显示', async () => {
    response = {
      items: [item('2026-09-12T03:00:00.000Z', { status: 'SOLD' })],
      nextCursor: null,
      total: 1,
    }
    const page = await fetchMyViewHistory()
    expect(page.items[0]?.listing.status).toBe('SOLD')
  })
})

describe('clearMyViewHistory —— DELETE 且以服务端为准', () => {
  test('发 DELETE 到同一路径，回 { deleted }', async () => {
    response = { deleted: 2 }
    const result = await clearMyViewHistory()

    expect(result).toEqual({ deleted: 2 })
    expect(calls).toEqual([
      {
        path: VIEW_HISTORY_ROUTES.myViewHistory,
        query: undefined,
        method: 'DELETE',
        body: undefined,
      },
    ])
  })

  test('幂等：没有记录时 deleted: 0 也是成功', async () => {
    response = { deleted: 0 }
    await expect(clearMyViewHistory()).resolves.toEqual({ deleted: 0 })
  })

  test('负数 deleted 是契约违例，解析处就炸', async () => {
    response = { deleted: -1 }
    await expect(clearMyViewHistory()).rejects.toThrow()
  })
})

describe('goneLabelOf —— 失效角标与收藏页同源', () => {
  test('OFFLINE → 已下架、SOLD → 已卖掉；ACTIVE / RESERVED 仍有效', () => {
    expect(goneLabelOf('OFFLINE')).toBe('已下架')
    expect(goneLabelOf('SOLD')).toBe('已卖掉')
    expect(goneLabelOf('ACTIVE')).toBeNull()
    expect(goneLabelOf('RESERVED')).toBeNull()
  })

  test('与收藏页的判据逐状态一致（同一件商品两页角标不能打架）', () => {
    for (const status of ['ACTIVE', 'RESERVED', 'SOLD', 'OFFLINE'] as const) {
      const row = toFavoriteItems([saved(status)], 0)[0]
      const favoriteGone = row?.segment === 'gone' ? row.goneReason : null
      expect(goneLabelOf(status)).toBe(favoriteGone)
    }
  })
})

describe('recordCellOf —— 契约行 → 三列格', () => {
  test('字段透传，失效由 status 推出', () => {
    const cell = recordCellOf(
      item('2026-09-12T03:00:00.000Z', {
        title: '小米 12',
        priceCents: 89000,
        category: 'DIGITAL',
        status: 'OFFLINE',
      }),
    )
    expect(cell).toEqual({
      id: LISTING_ID,
      category: 'DIGITAL',
      title: '小米 12',
      priceCents: 89000,
      gone: '已下架',
    })
  })
})

describe('historyDaysOf —— 按本地日分组', () => {
  test('今天 / 昨天 / 同年月日 / 跨年带年份，组内保持输入顺序', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime() // 2026-11-02 12:00（本地）
    const items = [
      item(at(2026, 11, 2, 10), { id: LISTING_ID }),
      item(at(2026, 11, 2, 9), { id: encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(12)) }),
      item(at(2026, 11, 1, 20), { id: encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(13)) }),
      item(at(2026, 10, 30, 8), { id: encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(14)) }),
      item(at(2025, 12, 31, 23), { id: encodePublicId(PUBLIC_ID_PREFIX.listing, uuid(15)) }),
    ]
    const days = historyDaysOf(items, now)

    expect(days.map((day) => day.date)).toEqual(['今天', '昨天', '10月30日', '2025年12月31日'])
    expect(days.map((day) => day.items.length)).toEqual([2, 1, 1, 1])
    // 组内顺序 = 输入顺序（服务端已按 last_viewed_at DESC 下发，不再二次排序）
    expect(days[0]?.items.map((cell) => cell.id)).toEqual([
      items[0]?.listing.id,
      items[1]?.listing.id,
    ])
  })

  test('同一天只出一组；空输入给空数组', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime()
    const days = historyDaysOf(
      [item(at(2026, 11, 2, 8)), item(at(2026, 11, 2, 9)), item(at(2026, 11, 2, 10))],
      now,
    )
    expect(days).toHaveLength(1)
    expect(days[0]?.items).toHaveLength(3)
    expect(historyDaysOf([], now)).toEqual([])
  })

  test('不就地改输入（跨页拼接要能拿到原数组）', () => {
    const now = new Date(2026, 10, 2, 12, 0).getTime()
    const items = [item(at(2026, 11, 2, 10))]
    historyDaysOf(items, now)
    expect(items).toHaveLength(1)
  })
})

describe('canClearTab —— 真实构建只放行浏览档', () => {
  test('演示构建三档都能清', () => {
    for (const tab of ['history', 'favs', 'msgs'] as const) {
      expect(canClearTab(true, tab)).toBe(true)
    }
  })

  test('真实构建：浏览档有 DELETE /me/view-history；收藏 / 留言没有清空端点', () => {
    expect(canClearTab(false, 'history')).toBe(true)
    expect(canClearTab(false, 'favs')).toBe(false)
    expect(canClearTab(false, 'msgs')).toBe(false)
  })
})
