import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  backfillGapUntilConnected,
  backfillMessageGap,
  type GapPage,
  MAX_BACKOFF_MS,
  realtimeUrl,
  reconnectDelayMs,
} from '../src/features/chat/realtime-recovery'

/**
 * 实时通道的纯函数判据（#67 第三步）。
 *
 * 这里锁的是「重连后怎么补齐断档」这条**验收点**：断线期间错过的消息可能超过一页，
 * 只重取最新一页会在中间留一段永远补不上的空洞。所以 `backfillMessageGap` 必须
 * 从最新一页**往回翻**，直到接上本地已有的消息 id 为止 —— 用例专门覆盖「断档跨页」
 * 与「接上就停」两侧，因为只测其中一侧的话，实现退化成「只取一页」或「一直翻到最早」
 * 都能过。
 *
 * `reconnectDelayMs` / `realtimeUrl` 是纯计算，单独锁住边界（封顶、协议、尾斜杠）。
 */

let seq = 0

/** 契约 `MessageDto` 的最小实例；顺序由 `createdAt` 的秒数决定 */
function message(id: string, second: number): MessageDto {
  seq += 1
  return {
    id,
    conversationId: 'conversation-1',
    senderId: 'user-1',
    sender: { id: 'user-1', nickname: '小北', avatarUrl: null },
    type: 'TEXT',
    content: `content-${seq}`,
    createdAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
  }
}

/**
 * 按游标取页的假 loader。
 *
 * `first` 是「最新一页」（不传 before 时取的那页），其余键是服务端给的游标。
 * 每页的 `items` 必须**内部升序**、且越晚取的页整体越早 —— 这正是服务端的契约
 * （`messageListResponseSchema` 按 `(createdAt, id)` 升序返回，游标往前翻）。
 */
function pagedLoader(pages: Record<string, GapPage>) {
  const calls: Array<string | undefined> = []
  const loadPage = async (before?: string): Promise<GapPage> => {
    calls.push(before)
    const page = pages[before ?? 'first']
    if (!page) throw new Error(`用例没有准备游标 ${String(before)} 对应的页`)
    return page
  }
  return { loadPage, calls }
}

describe('reconnectDelayMs —— 重连退避', () => {
  test('从 1s 起翻倍', () => {
    expect(reconnectDelayMs(0)).toBe(1_000)
    expect(reconnectDelayMs(1)).toBe(2_000)
    expect(reconnectDelayMs(2)).toBe(4_000)
    expect(reconnectDelayMs(3)).toBe(8_000)
  })

  test('封顶 30s，不会随次数无限增长', () => {
    expect(reconnectDelayMs(5)).toBe(MAX_BACKOFF_MS)
    expect(reconnectDelayMs(20)).toBe(MAX_BACKOFF_MS)
  })

  test('负数 / 小数不会算出比首次更短或超界的值', () => {
    expect(reconnectDelayMs(-3)).toBe(1_000)
    expect(reconnectDelayMs(1.9)).toBe(2_000)
  })
})

describe('realtimeUrl —— 由 API 基地址推 WS 地址', () => {
  test('http → ws，拼上契约端点', () => {
    expect(realtimeUrl('http://localhost:3000')).toBe('ws://localhost:3000/ws/chat')
  })

  test('https → wss（真机 / 正式环境不能被降级成明文 ws）', () => {
    expect(realtimeUrl('https://fish.example.com')).toBe('wss://fish.example.com/ws/chat')
  })

  test('末尾斜杠不会拼出双斜杠', () => {
    expect(realtimeUrl('http://localhost:3000/')).toBe('ws://localhost:3000/ws/chat')
  })
})

describe('backfillMessageGap —— 重连后补齐断档', () => {
  test('本地一条都没有时只取最新一页（不把整段历史重拉一遍）', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m2', 2), message('m3', 3)], nextCursor: 'c2', failed: false },
      c2: { items: [message('m1', 1)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set())

    expect(calls).toEqual([undefined])
    expect(result.items.map((item) => item.id)).toEqual(['m2', 'm3'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'empty-local' })
  })

  test('断档跨多页时往回翻到接上本地窗口为止（这正是「只取一页」补不上的）', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m3', 3)], nextCursor: 'c2', failed: false },
      c2: { items: [message('m2', 2)], nextCursor: 'c1', failed: false },
      c1: { items: [message('m1', 1)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m1']))

    expect(calls).toEqual([undefined, 'c2', 'c1'])
    expect(result.items.map((item) => item.id)).toEqual(['m1', 'm2', 'm3'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'connected' })
  })

  test('一接上就停，不会多翻一页；结果按时间升序（反转页序拼接）', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m3', 3), message('m4', 4)], nextCursor: 'c2', failed: false },
      c2: { items: [message('m1', 1), message('m2', 2)], nextCursor: 'c1', failed: false },
      c1: { items: [message('m0', 0)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m2']))

    expect(calls).toEqual([undefined, 'c2'])
    expect(result.items.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'connected' })
  })

  test('翻到最早（nextCursor 为 null）就停，即使一直没接上', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m3', 3)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m1']))

    expect(calls).toEqual([undefined])
    expect(result.items.map((item) => item.id)).toEqual(['m3'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'earliest' })
  })

  test('页数上限兜底：游标异常时不会无限翻下去，并把续拉位置交出来', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m9', 9)], nextCursor: 'c1', failed: false },
      c1: { items: [message('m8', 8)], nextCursor: 'c2', failed: false },
      c2: { items: [message('m7', 7)], nextCursor: 'c3', failed: false },
      c3: { items: [message('m6', 6)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['never']), { maxPages: 3 })

    expect(calls).toEqual([undefined, 'c1', 'c2'])
    expect(result.items.map((item) => item.id)).toEqual(['m7', 'm8', 'm9'])
    // 没接上就不能假装接上了：预算耗尽要交出续拉位置，否则这段缺口再也没人补（#67 N5）
    expect(result).toMatchObject({ complete: false, resumeCursor: 'c3', stoppedBy: 'budget' })
  })

  test('这一页没读到就停：不把「没读到」当成「还有更早的」', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [], nextCursor: 'c1', failed: true },
      c1: { items: [message('m1', 1)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m0']))

    expect(calls).toEqual([undefined])
    expect(result.items).toEqual([])
    // 最新一页就没读到：续拉位置停在「最新」（null = 重取第一页），不能指向 c1
    expect(result).toMatchObject({ complete: false, resumeCursor: null, stoppedBy: 'failed' })
  })

  test('中途取页失败：续拉位置停在失败那一页，重试时不会跳过它', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m9', 9)], nextCursor: 'c8', failed: false },
      c8: { items: [], nextCursor: 'c7', failed: true },
      c7: { items: [message('m7', 7)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m7']))

    expect(calls).toEqual([undefined, 'c8'])
    expect(result.items.map((item) => item.id)).toEqual(['m9'])
    expect(result).toMatchObject({ complete: false, resumeCursor: 'c8', stoppedBy: 'failed' })
  })

  test('从上一轮交出的续拉位置接着翻，不把已翻过的页重取一遍', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m9', 9)], nextCursor: 'c8', failed: false },
      c8: { items: [message('m8', 8)], nextCursor: 'c7', failed: false },
      c7: { items: [message('m7', 7)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m7']), { startBefore: 'c8' })

    expect(calls).toEqual(['c8', 'c7'])
    expect(result.items.map((item) => item.id)).toEqual(['m7', 'm8'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'connected' })
  })

  test('跨页重复的服务端 id 只保留一条', async () => {
    const { loadPage } = pagedLoader({
      first: { items: [message('m2', 2), message('m3', 3)], nextCursor: 'c1', failed: false },
      c1: { items: [message('m2', 2)], nextCursor: null, failed: false },
    })

    const result = await backfillMessageGap(loadPage, new Set(['m9']))

    expect(result.items.map((item) => item.id)).toEqual(['m2', 'm3'])
    expect(result).toMatchObject({ complete: true, stoppedBy: 'earliest' })
  })
})

describe('backfillGapUntilConnected —— 一轮翻不完就接着翻（#67 N5）', () => {
  const threePageGap = () => ({
    first: { items: [message('m5', 5)], nextCursor: 'c4', failed: false },
    c4: { items: [message('m3', 3)], nextCursor: 'c2', failed: false },
    c2: { items: [message('m1', 1)], nextCursor: null, failed: false },
  })

  test('页数预算不够时自动用交出的续拉位置接着翻，直到接上', async () => {
    const { loadPage, calls } = pagedLoader(threePageGap())

    const result = await backfillGapUntilConnected(loadPage, new Set(['m1']), {
      maxPages: 1,
      maxPasses: 3,
    })

    expect(calls).toEqual([undefined, 'c4', 'c2'])
    // 后一轮翻到的整体更早，拼装时按轮序反转，结果仍是升序
    expect(result.items.map((item) => item.id)).toEqual(['m1', 'm3', 'm5'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'connected' })
  })

  test('轮数用尽仍没接上：如实报 incomplete 并交出下一轮的续拉位置', async () => {
    const { loadPage, calls } = pagedLoader(threePageGap())

    const result = await backfillGapUntilConnected(loadPage, new Set(['m1']), {
      maxPages: 1,
      maxPasses: 2,
    })

    expect(calls).toEqual([undefined, 'c4'])
    expect(result.items.map((item) => item.id)).toEqual(['m3', 'm5'])
    // 修复前这里只会返回数组、丢掉 c2，这段缺口再也没人补
    expect(result).toMatchObject({ complete: false, resumeCursor: 'c2', stoppedBy: 'budget' })
  })

  test('取页失败时停在失败那一页重试，不会跳过它去翻更早的', async () => {
    const { loadPage, calls } = pagedLoader({
      first: { items: [message('m9', 9)], nextCursor: 'c8', failed: false },
      c8: { items: [], nextCursor: 'c7', failed: true },
      c7: { items: [message('m7', 7)], nextCursor: null, failed: false },
    })

    const result = await backfillGapUntilConnected(loadPage, new Set(['m7']), {
      maxPages: 1,
      maxPasses: 3,
    })

    expect(calls).toEqual([undefined, 'c8', 'c8'])
    expect(result.items.map((item) => item.id)).toEqual(['m9'])
    expect(result).toMatchObject({ complete: false, resumeCursor: 'c8', stoppedBy: 'failed' })
  })

  test('从传入的续拉位置起跑，不重取最新一页', async () => {
    const { loadPage, calls } = pagedLoader({
      c8: { items: [message('m8', 8)], nextCursor: 'c7', failed: false },
      c7: { items: [message('m7', 7)], nextCursor: null, failed: false },
    })

    const result = await backfillGapUntilConnected(loadPage, new Set(['m7']), {
      maxPages: 1,
      maxPasses: 2,
      startBefore: 'c8',
    })

    expect(calls).toEqual(['c8', 'c7'])
    expect(result.items.map((item) => item.id)).toEqual(['m7', 'm8'])
    expect(result).toMatchObject({ complete: true, resumeCursor: null, stoppedBy: 'connected' })
  })
})
