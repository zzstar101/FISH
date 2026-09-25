/**
 * 实时通道的纯函数部分（#67 第三步）：地址推导、重连退避、断档补齐。
 *
 * 与 `realtime.ts`（持有 socket / 定时器的有状态客户端）分开，是为了让这些判据
 * 能在 bun 测试里直接跑，不必 mock `@tarojs/taro`。
 */
import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'

/** 重连退避上限（与 Web 端 `apps/web/src/features/chat/realtime.ts` 同值） */
export const MAX_BACKOFF_MS = 30_000

/** 第 `attempt` 次重连前该等多久（attempt 从 0 起：1s、2s、4s… 封顶 30s） */
export function reconnectDelayMs(attempt: number): number {
  const step = Math.max(0, Math.floor(attempt))
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** step)
}

/**
 * 由 API 基地址推出 WS 地址。
 *
 * 小程序没有 Vite 那层代理，`API_BASE` 是绝对地址（`lib/api-base.ts`），
 * 协议按 http→ws / https→wss 换；末尾多余的 `/` 要去掉，否则会拼出 `//ws/chat`。
 */
export function realtimeUrl(apiBase: string): string {
  const wsBase = apiBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  return `${wsBase.replace(/\/+$/, '')}${REALTIME_WS_PATH}`
}

/** 分页接口共有的三个字段（消息与媒体历史都长这样） */
export type GapPage<T> = {
  items: T[]
  nextCursor: string | null
  failed: boolean
}

/**
 * 一轮补齐为什么停下来。
 *
 * 前三种是**真的接上了**；后两种没接上 —— 必须把续拉位置交还给调用方，否则断线期间
 * 超过预算的那段消息会在中间留下一段永远补不上的空洞（#67 N5）。
 */
export type GapStopReason =
  /** 与 `knownIds` 有交集：已经接到本地窗口的前沿 */
  | 'connected'
  /** `nextCursor === null`：翻到了最早，更早的本地本来就没有 */
  | 'earliest'
  /** 本地一条都没有：首屏只加载一页（见下） */
  | 'empty-local'
  /** 取页失败：拿不到游标，继续翻只会把「没读到」当成「还有更早的」 */
  | 'failed'
  /** 页数预算耗尽，还没接上 */
  | 'budget'

/** `backfillMessageGap` 的结果 */
export type GapBackfill<T> = {
  /** 升序的合并结果（可直接交给 `mergeRefreshedMessages`） */
  items: T[]
  /** 是否已经把断档接上。`false` = 中间可能还有缺口，应带 `resumeCursor` 再来一轮 */
  complete: boolean
  /**
   * 没接上时下一轮的起始游标（即 `loadPage` 的 `before`）。接上了就是 `null`。
   *
   * `stoppedBy === 'failed'` 且本来就是从最新一页开始取的时候它也会是 `null` ——
   * 那表示下一轮重取最新一页（不是「没有续拉位置」）。
   */
  resumeCursor: string | null
  stoppedBy: GapStopReason
}

/**
 * 重连后把断档补回来。
 *
 * 契约明确「推送不保证不重不漏，离线端重连后用历史端点补齐」，所以**不能只重取最新
 * 一页**就认为消息完整：断线时间一长，错过的消息会超过一页（契约单页上限 100 条），
 * 只取一页会在中间留一段永远补不上的空洞。
 *
 * 做法是从最新一页**往回翻**，直到某一页里出现了本地已有的消息 id —— 那说明已经
 * 接到本地窗口的前沿，再往前的内容本地本来就有。三个终止条件：
 * - 与 `knownIds` 有交集（接上了）；
 * - `nextCursor === null`（翻到了最早）；
 * - 页数到 `maxPages`（防止服务端游标异常时无限翻页）。
 *
 * `knownIds` 为空（首次加载、换号刚清完场）时只取一页：本地一条都没有，往回翻等于
 * 把整段历史重拉一遍，而首屏本来就只加载一页。
 *
 * 返回**升序**的合并结果（服务端每页内部升序、页与页之间越翻越早，所以反转页序拼起来
 * 就是全局升序）。不在这里排序：排序规则是契约的 `(createdAt, id)`，重复实现一份容易
 * 与 `pages/conversation/view.ts` 的 `sortMessages` 走样。
 *
 * **没接上不是「补齐失败」，但更不能当作接上了**（#67 N5）：预算耗尽或中途取页失败时
 * `complete` 为 `false`，并把 `resumeCursor` 交回调用方 —— 调用方应当带着它再跑一轮，
 * 且要跨重连记住它（见 `pages/conversation/index.tsx` 的 `gapResumeCursorsRef`），否则断线
 * 超过 `maxPages` 页的消息永远补不上。
 */
export async function backfillMessageGap<T extends { id: string }>(
  loadPage: (before?: string) => Promise<GapPage<T>>,
  knownIds: ReadonlySet<string>,
  options?: { maxPages?: number; startBefore?: string },
): Promise<GapBackfill<T>> {
  const maxPages = options?.maxPages ?? 10
  const pages: T[][] = []
  // 上一轮没接上时从这里继续往回翻；不传就是新的一轮（从最新一页开始）
  let cursor: string | undefined = options?.startBefore
  let stoppedBy: GapStopReason = 'budget'
  let resumeCursor: string | null = null

  for (let index = 0; index < maxPages; index += 1) {
    const page = await loadPage(cursor)
    // 这一页没读到：拿不到游标，继续翻只会把「没读到」当成「还有更早的」。
    // 续拉位置停在**这一页**，下一轮从同一处重试（`cursor` 为 undefined 即重取最新一页）。
    if (page.failed) {
      stoppedBy = 'failed'
      resumeCursor = cursor ?? null
      break
    }
    pages.push(page.items)
    // 接上本地窗口的前沿：更早的历史本地已有，不必再翻
    if (knownIds.size > 0 && page.items.some((item) => knownIds.has(item.id))) {
      stoppedBy = 'connected'
      break
    }
    if (page.nextCursor === null) {
      stoppedBy = 'earliest'
      break
    }
    // 本地一条都没有：取最新一页就够（见上方说明）
    if (knownIds.size === 0) {
      stoppedBy = 'empty-local'
      break
    }
    // 还没接上：记下更早一页的游标，预算用完就从这里继续
    cursor = page.nextCursor
    resumeCursor = page.nextCursor
    stoppedBy = 'budget'
  }

  const out: T[] = []
  const seen = new Set<string>()
  for (const page of pages.reverse()) {
    for (const item of page) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }

  const complete = stoppedBy !== 'failed' && stoppedBy !== 'budget'
  return {
    items: out,
    complete,
    resumeCursor: complete ? null : resumeCursor,
    stoppedBy,
  }
}

/**
 * 多轮补齐：一轮翻不完就带着上一轮交出的续拉位置接着翻（#67 N5）。
 *
 * 单轮 `backfillMessageGap` 的页数预算有限（默认 10 页），断线时间长或中途取页失败时
 * 一轮翻不到本地窗口的前沿。修复前调用方只看单轮结果、把 `resumeCursor` 丢掉，那段
 * 缺口就再也没人补 —— 这里把它接着翻；翻不动的部分原样交回调用方，由调用方跨重连
 * 记住（见 `pages/conversation/index.tsx` 的 `gapResumeCursorsRef`）。
 *
 * `maxPasses` 与 `maxPages` 一样是硬上限：服务端游标异常时不能把重连变成无限翻页。
 * 后一轮翻到的消息整体早于前一轮，所以拼装时按轮序反转（与 `backfillMessageGap`
 * 处理页序的方式一致），结果仍是升序。
 */
export async function backfillGapUntilConnected<T extends { id: string }>(
  loadPage: (before?: string) => Promise<GapPage<T>>,
  knownIds: ReadonlySet<string>,
  options?: { maxPages?: number; maxPasses?: number; startBefore?: string },
): Promise<GapBackfill<T>> {
  const maxPasses = Math.max(0, options?.maxPasses ?? 3)
  const startAt = options?.startBefore
  const chunks: T[][] = []
  let last: GapBackfill<T> = {
    items: [],
    complete: false,
    resumeCursor: startAt ?? null,
    stoppedBy: 'budget',
  }
  let startBefore = startAt

  for (let pass = 0; pass < maxPasses; pass += 1) {
    last = await backfillMessageGap(loadPage, knownIds, {
      maxPages: options?.maxPages,
      startBefore,
    })
    chunks.push(last.items)
    if (last.complete) break
    // 续拉位置都拿不到（最新一页就没读到）：再跑一轮也只是重取同一页，等下一次重连
    if (last.resumeCursor === null) break
    startBefore = last.resumeCursor
  }

  const items: T[] = []
  const seen = new Set<string>()
  for (const chunk of chunks.reverse()) {
    for (const item of chunk) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      items.push(item)
    }
  }

  return { ...last, items }
}

/**
 * 一次重连要补的**两笔账**（#67 复查 #221）。
 *
 * `backfillGapUntilConnected` 只认一笔账：从交进来的位置往回翻。历史欠账的游标一旦被
 * 当成起点，整次重连就只剩「补旧的」——断线期间新增的消息（最新消息 → 本地前沿）反倒
 * 一条都不取，要等下一次刷新或下一轮补齐才可能冒出来。
 */
export type GapRecovery = {
  /** 新账在前、旧账在后的合并结果（各段内部升序）；顺序无所谓，调用方会重新定序 */
  items: MessageDto[]
  /**
   * 还没补上的位置（新 → 旧）。下次重连要**同时**做两件事：从最新一页取新款，再逐个
   * 位置接着往回翻。空数组 = 两笔账都清了。
   */
  resumeCursors: string[]
  /** 本次「最新消息 → 本地前沿」是否接上 */
  freshComplete: boolean
}

/**
 * 重连补齐：`最新消息 → 本地前沿` 与 `历史欠账` 各补一遍（#67 复查 #221）。
 *
 * 为什么不能拿历史欠账的游标当起点（修复前的做法）：
 *
 * ```
 * 本地原有消息 1
 * → 第一次恢复拿到 5–8，2–4 读取失败      → 欠账游标停在 2–4 之前
 * → 再次断线，服务端新增 9–12
 * → 重连时从欠账游标起跑，补回 2–4 就报「补齐完成」→ 9–12 一条没取
 * ```
 *
 * 所以固定先跑一趟**不带起点**的补齐（永远从最新一页往回翻），拿到本次重连的新缺口；
 * 再把上一轮交出来的欠账位置逐个接着翻。两笔账各自记账：新缺口没翻完就把它自己的续拉
 * 位置也记进 `resumeCursors`，历史欠账没翻完就继续留着。
 *
 * 为什么欠账是一**串**位置而不是一个：往回翻一碰到本地已有的消息就停，所以一个补不上
 * 的位置会挡住它下面（更早）的每一页 —— 新缺口与历史欠账各占一段，必须分别记。
 */
export async function recoverGapsOnReconnect(
  loadPage: (before?: string) => Promise<GapPage>,
  knownIds: ReadonlySet<string>,
  options?: { maxPages?: number; maxPasses?: number; resumeCursors?: readonly string[] },
): Promise<GapRecovery> {
  const budget = { maxPages: options?.maxPages, maxPasses: options?.maxPasses }

  const fresh = await backfillGapUntilConnected(loadPage, knownIds, budget)

  const items = [...fresh.items]
  // 后面每一段都要认前面刚拉到的消息，否则会在同一段里重复翻页
  const known = new Set(knownIds)
  for (const item of items) known.add(item.id)

  const resumeCursors: string[] = []
  const remember = (cursor: string | null) => {
    if (cursor === null || resumeCursors.includes(cursor)) return
    resumeCursors.push(cursor)
  }
  // 新缺口自己没翻完（预算耗尽 / 取页失败）：它也是欠账，下一次重连不能只从最新一页重来
  remember(fresh.complete ? null : fresh.resumeCursor)

  for (const cursor of options?.resumeCursors ?? []) {
    const debt = await backfillGapUntilConnected(loadPage, known, {
      ...budget,
      startBefore: cursor,
    })
    for (const item of debt.items) {
      if (known.has(item.id)) continue
      known.add(item.id)
      items.push(item)
    }
    remember(debt.complete ? null : debt.resumeCursor)
  }

  return { items, resumeCursors, freshComplete: fresh.complete }
}
