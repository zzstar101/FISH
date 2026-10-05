import { describe, expect, test } from 'bun:test'
import { VIEW_HISTORY_RETENTION_MS } from '@fish/contracts/view-history/schema'
import { encodeViewHistoryCursor } from './cursor'
import { createViewHistoryService, ViewHistoryServiceError } from './service'
import type { ViewHistoryRow, ViewHistoryStore } from './store'

const NOW = new Date('2026-10-02T00:00:00.000000Z')
const sinceCalls: Date[] = []

function row(overrides: Partial<ViewHistoryRow> = {}): ViewHistoryRow {
  return {
    id: '01930000-0000-7000-8000-0000000000b1',
    listingNo: 123456789012n,
    title: 'K380 键盘',
    priceCents: 16000,
    category: 'DIGITAL',
    condition: 'GOOD',
    status: 'ACTIVE',
    urgent: false,
    negotiable: true,
    free: false,
    createdAt: new Date('2026-09-12T01:00:00.000Z'),
    seller: {
      id: '01930000-0000-7000-8000-0000000000a1',
      nickname: '阿岚',
      avatarUrl: null,
      authStatus: 'UNVERIFIED',
    },
    coverObjectKey: null,
    viewedAt: '2026-10-01T03:00:00.000Z',
    viewedAtCursor: '2026-10-01T03:00:00.000100Z',
    // 想要数（已建会话的买家数）：卡片契约的必填字段，fake 行给 0（本用例不关心它）。
    wants: 0,
    ...overrides,
  }
}

function createFakeStore(rows: ViewHistoryRow[], total?: number): ViewHistoryStore {
  return {
    async listViewHistory(_userId, _limit, _cursor, since) {
      sinceCalls.push(since)
      return rows
    },
    async totalViewHistory(_userId, since) {
      sinceCalls.push(since)
      return total ?? rows.length
    },
    async clearViewHistory() {
      return 0
    },
  }
}

const storage = { publicUrl: (objectKey: string) => `https://cdn.example/${objectKey}` }

describe('view history service', () => {
  test('窗口起点 = 注入时钟 - 30 天，列表与 total 用同一个', async () => {
    sinceCalls.length = 0
    const service = createViewHistoryService({
      store: createFakeStore([row()]),
      storage,
      now: () => NOW,
    })

    await service.listMine('u', { limit: 20 })

    const expected = new Date(NOW.getTime() - VIEW_HISTORY_RETENTION_MS)
    expect(sinceCalls).toEqual([expected, expected])
  })

  test('映射成契约行（卡片 + viewedAt），多取的一行只用于产生 nextCursor', async () => {
    const service = createViewHistoryService({
      store: createFakeStore([
        row({
          viewedAt: '2026-10-01T05:00:00.000Z',
          viewedAtCursor: '2026-10-01T05:00:00.000100Z',
        }),
        row({
          id: '01930000-0000-7000-8000-0000000000b2',
          viewedAt: '2026-10-01T04:00:00.000Z',
          viewedAtCursor: '2026-10-01T04:00:00.000200Z',
        }),
        row({ id: '01930000-0000-7000-8000-0000000000b3' }),
      ]),
      storage,
      now: () => NOW,
    })

    const page = await service.listMine('u', { limit: 2 })

    expect(page.items).toHaveLength(2)
    expect(page.items[0]?.viewedAt).toBe('2026-10-01T05:00:00.000Z')
    expect(page.items[0]?.listing.id.startsWith('lst_')).toBe(true)
    expect(page.nextCursor).not.toBeNull()
    expect(page.total).toBe(3)
  })

  test('恰好一页时 nextCursor 为 null', async () => {
    const service = createViewHistoryService({
      store: createFakeStore([row()]),
      storage,
      now: () => NOW,
    })

    const page = await service.listMine('u', { limit: 2 })
    expect(page.nextCursor).toBeNull()
  })

  test('非法游标 → 422 VALIDATION_FAILED（不宽容解析）', async () => {
    const service = createViewHistoryService({
      store: createFakeStore([]),
      storage,
      now: () => NOW,
    })

    await expect(service.listMine('u', { limit: 20, cursor: 'not-a-cursor' })).rejects.toThrow(
      ViewHistoryServiceError,
    )

    // 合法游标照常。
    const cursor = encodeViewHistoryCursor({
      viewedAt: '2026-10-01T03:00:00.000100Z',
      listingId: '01930000-0000-7000-8000-0000000000b1',
    })
    await expect(service.listMine('u', { limit: 20, cursor })).resolves.toBeDefined()
  })

  test('清空回服务端的删除行数（0 也是成功）', async () => {
    const service = createViewHistoryService({
      store: { ...createFakeStore([]), clearViewHistory: async () => 3 },
      storage,
      now: () => NOW,
    })
    expect(await service.clearMine('u')).toEqual({ deleted: 3 })
  })
})
