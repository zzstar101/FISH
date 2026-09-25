import { describe, expect, test } from 'bun:test'
import type { MessageDto } from '@fish/contracts/chat/schema'
import {
  backfillGapUntilConnected,
  backfillMessageGap,
  type GapPage,
  MAX_BACKOFF_MS,
  realtimeUrl,
  reconnectDelayMs,
  recoverGapsOnReconnect,
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
function pagedLoader(pages: Record<string, GapPage<MessageDto>>) {
  const calls: Array<string | undefined> = []
  const loadPage = async (before?: string): Promise<GapPage<MessageDto>> => {
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

/**
 * 会「长出新消息」的假服务端：`ids` 升序（越靠后越新），游标 `c<i>` = 「给我 `ids[i]`
 * 之前那一页」。用例可以在两次重连之间往 `ids` 尾部追加消息 —— 这正是「第二次断线又产生
 * 新消息」。`failing` 每次调用都重新取，所以用例可以中途把某一页改成能读到。
 */
function growingServer(pageSize: number, ids: string[], failing: () => ReadonlySet<string>) {
  const calls: Array<string | undefined> = []
  const loadPage = async (before?: string): Promise<GapPage> => {
    calls.push(before)
    if (failing().has(before ?? 'first')) {
      return { items: [], nextCursor: before ?? null, failed: true }
    }
    const end = before === undefined ? ids.length : Number(before.slice(1))
    const start = Math.max(0, end - pageSize)
    return {
      items: ids.slice(start, end).map((id, index) => message(id, start + index + 1)),
      nextCursor: start > 0 ? `c${start}` : null,
      failed: false,
    }
  }
  return { loadPage, calls }
}

describe('recoverGapsOnReconnect —— 新缺口和历史欠账各记一笔（#67 复查 #221）', () => {
  const twoPerPage = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8']

  test('两次断线：第一次补拉没完成，第二次又产生新消息 —— 新消息不能被旧游标顶掉', async () => {
    const ids = [...twoPerPage]
    // 第一次重连：m3/m4 那一页读取失败（service 侧持续报错）
    const failing = new Set(['c4'])
    const { loadPage, calls } = growingServer(2, ids, () => failing)

    const first = await recoverGapsOnReconnect(loadPage, new Set(['m1']), {
      maxPages: 1,
      maxPasses: 3,
    })

    expect(first.items.map((item) => item.id)).toEqual(['m5', 'm6', 'm7', 'm8'])
    expect(first.freshComplete).toBe(false)
    // 欠账停在「m3/m4 之前」：这一段没补上，下一次重连要接着来
    expect(first.resumeCursors).toEqual(['c4'])

    // 第二次断线：服务端新增 m9–m12，且 m3/m4 现在能读到了
    ids.push('m9', 'm10', 'm11', 'm12')
    failing.clear()
    calls.length = 0

    const second = await recoverGapsOnReconnect(loadPage, new Set(['m1', 'm5', 'm6', 'm7', 'm8']), {
      maxPages: 1,
      maxPasses: 3,
      resumeCursors: first.resumeCursors,
    })

    // 修复前这里会拿 'c4' 当起点，补回 m3/m4 就报「补齐完成」，本次断线新增的 m9–m12
    // 一条都不取 —— 先锁「第一趟一定从最新一页起跑」。
    expect(calls[0]).toBeUndefined()
    expect(calls).toContain('c4')
    // 新缺口补上了
    expect(second.freshComplete).toBe(true)
    const recovered = second.items.map((item) => item.id)
    expect(recovered).toContain('m9')
    expect(recovered).toContain('m12')
    // 历史欠账也在同一次重连里结清
    expect(recovered).toContain('m3')
    expect(recovered).toContain('m4')
    expect(second.resumeCursors).toEqual([])
  })

  test('第二次重连没有新消息时，历史欠账照样继续补', async () => {
    const ids = [...twoPerPage]
    const failing = new Set(['c4'])
    const { loadPage } = growingServer(2, ids, () => failing)

    const first = await recoverGapsOnReconnect(loadPage, new Set(['m1']), { maxPages: 1 })
    expect(first.resumeCursors).toEqual(['c4'])

    failing.clear()
    const second = await recoverGapsOnReconnect(loadPage, new Set(['m1', 'm5', 'm6', 'm7', 'm8']), {
      maxPages: 1,
      resumeCursors: first.resumeCursors,
    })

    // m2 本地也没有（原本只有 m1，5–8 是上一轮补回来的），所以它同样要落地
    expect(second.items.map((item) => item.id)).toEqual(['m7', 'm8', 'm2', 'm3', 'm4'])
    expect(second.resumeCursors).toEqual([])
  })

  test('新缺口自己没翻完时也记一笔：两段欠账并存，不会被彼此顶掉', async () => {
    const ids = [...twoPerPage]
    const { loadPage } = growingServer(2, ids, () => new Set())

    // 本地只有 m1，且预算只够翻一页：最新的 m7/m8 拿到了，往下的还没翻
    const first = await recoverGapsOnReconnect(loadPage, new Set(['m1']), {
      maxPages: 1,
      maxPasses: 1,
    })

    expect(first.items.map((item) => item.id)).toEqual(['m7', 'm8'])
    expect(first.freshComplete).toBe(false)
    expect(first.resumeCursors).toEqual(['c6'])

    // 第二次断线又长了两条：新缺口（m9/m10）与旧欠账（c6 往下）都要记
    ids.push('m9', 'm10')
    const second = await recoverGapsOnReconnect(loadPage, new Set(['m1', 'm7', 'm8']), {
      maxPages: 1,
      maxPasses: 1,
      resumeCursors: first.resumeCursors,
    })

    expect(second.items.map((item) => item.id)).toEqual(['m9', 'm10', 'm5', 'm6'])
    // 新 → 旧：一个游标装不下两段
    expect(second.resumeCursors).toEqual(['c8', 'c4'])

    // 第三次重连把两段都结清
    const third = await recoverGapsOnReconnect(
      loadPage,
      new Set(['m1', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']),
      { resumeCursors: second.resumeCursors },
    )

    expect(third.items.map((item) => item.id)).toEqual(['m9', 'm10', 'm2', 'm3', 'm4'])
    expect(third.resumeCursors).toEqual([])
  })

  test('没有欠账时就是一趟普通的「从最新一页往回翻」', async () => {
    const { loadPage, calls } = growingServer(2, twoPerPage, () => new Set())

    const result = await recoverGapsOnReconnect(loadPage, new Set(['m3']), { maxPages: 10 })

    expect(calls).toEqual([undefined, 'c6', 'c4'])
    // 接到 m3 所在的那一页就停：更早的本地本来就有
    expect(result.items.map((item) => item.id)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7', 'm8'])
    expect(result).toMatchObject({ freshComplete: true, resumeCursors: [] })
  })
})
