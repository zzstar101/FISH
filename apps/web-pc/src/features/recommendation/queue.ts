import {
  type RecommendationEventInput,
  RecommendationEventInputSchema,
} from '@fish/contracts/recommendation/schema'
import { ApiError } from '../../lib/api-client'
import { postRecommendationEvents } from './api'

/**
 * 行为事件离线队列（#323 R1）。
 *
 * 埋点是尽力而为的旁路：断网、5xx 都不能影响用户操作，所以事件先落 localStorage，
 * 服务端确认后才出队。`eventId` 在入队时生成、重试沿用同一个值——服务端靠它去重，
 * 重新生成会把同一次行为记成两次。
 */
const QUEUE_STORAGE_KEY = 'fish.recommendation.queue'
/**
 * 「当前登录身份」标记的存储 key（#323 R1 复审 blocker）。
 *
 * 队列里没有 `requestId` 的事件（搜索 / 分类入口进详情产生的 `DETAIL_VIEW` 等）补发时
 * 由服务端按「补发那一刻的 Cookie」落 `user_id`（`apps/api/src/modules/recommendation/service.ts`
 * 的 `let userId = viewerId`），只有带 `requestId` 的事件才有 `ownsRequest()` 兜底。
 * 所以本地必须记住事件入队时的身份，切号后把旧身份的待发事件丢掉。
 *
 * 单独一个 key：队列存储格式（事件数组）不变，不需要处理旧格式迁移。
 */
const VIEWER_STORAGE_KEY = 'fish.recommendation.viewer'
/** 队列上限：超出丢最旧的。埋点不能让本地存储无限增长。 */
const MAX_QUEUE_LENGTH = 500
/** 单次请求条数上限（契约里 batch 上限就是 50）。 */
const FLUSH_BATCH_SIZE = 50
/** 定时冲刷间隔。 */
const FLUSH_INTERVAL_MS = 15_000

/** 写回队列；返回是否真的写成功——调用方不能假定内容已更新。 */
function writeQueue(events: readonly RecommendationEventInput[]): boolean {
  try {
    window.localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(events))
    return true
  } catch {
    // 配额写满：丢队列比让页面抛错重要，埋点不值得打断用户。
    return false
  }
}

/**
 * 读取队列。
 *
 * 逐条用契约 schema 自检，不合格的直接丢掉：一条坏事件会让**整批** 422，
 * 那是客户端 bug，不该连带把同一批里合法的事件也拖死。
 */
function readQueue(): RecommendationEventInput[] {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(QUEUE_STORAGE_KEY)
  } catch {
    return []
  }
  if (raw === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const valid: RecommendationEventInput[] = []
  let dropped = 0
  for (const item of parsed) {
    const result = RecommendationEventInputSchema.safeParse(item)
    if (result.success) valid.push(result.data)
    else dropped += 1
  }

  if (dropped > 0) {
    // 只可能来自旧版本客户端写下的数据；喊出来是为了让契约变更被看见。
    console.warn(`[recommendation] 丢弃 ${dropped} 条不合契约的本地事件`)
    writeQueue(valid)
  }
  return valid
}

/**
 * 读取身份标记；`null` 表示「没有标记」（首次使用、旧版本客户端、数据损坏、或存储不可用）。
 *
 * 读不出来、解析不出来一律当成「身份不明」：调用方按「不投递」处理（`drainQueue` 的第一道
 * 门），等 `syncRecommendationViewer` 写下标记后再补发。
 */
function readViewerMarker(): { userId: string | null } | null {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(VIEWER_STORAGE_KEY)
  } catch {
    return null
  }
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const userId = (parsed as { userId?: unknown }).userId
  if (userId === null || typeof userId === 'string') return { userId }
  return null
}

/**
 * 写入身份标记，返回**是否真的落盘**（写完重读核对）。
 *
 * 返回值是「采纳新身份」的前置条件：标记没写进去就采纳，内存身份会与存储标记分叉，下一次
 * 冲刷的复核就会失准。写不进去就退回「身份不明」（闸门关着），宁可停发也不能串号。
 */
function writeViewerMarker(userId: string | null): boolean {
  try {
    window.localStorage.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ userId }))
  } catch {
    // 配额写满 / 隐私模式：下面的重读才是判据。
  }
  const stored = readViewerMarker()
  return stored !== null && stored.userId === userId
}

/**
 * 丢弃队列（含存储里的副本），返回**是否确认清空**（重读核对）。
 *
 * 身份轮换时这是「采纳新身份」的**前置条件**：`removeItem` 会在隐私模式 / 存储异常下静默
 * 失效（既不抛错也不生效），只看有没有抛错就采纳新身份，等于把旧身份留在存储里的事件按新
 * 身份的 Cookie 补发出去 —— 那正是「A 的行为记到 B 头上」的复现路径。读不回来一律算没清干净。
 */
export function clearRecommendationQueue(): boolean {
  try {
    window.localStorage.removeItem(QUEUE_STORAGE_KEY)
  } catch {
    // 删不掉没关系，下面的重读才是判据。
  }
  try {
    return window.localStorage.getItem(QUEUE_STORAGE_KEY) === null
  } catch {
    return false
  }
}

/**
 * 当前身份（内存副本）。`undefined` = 还不知道（没有标记）；`null` = 匿名。
 * 模块初始化时从标记读一次，之后只由 `syncRecommendationViewer` 与冲刷时的复核更新。
 */
let currentViewer: string | null | undefined = readViewerMarker()?.userId

/**
 * 身份变化时调用（登录 / 注册 / 退出 / 401 过期 / 检测到换号）。
 *
 * 语义锁定为「**不迁移、丢弃**」：匿名 → 登录、A → B 都不把待发事件带过去。理由是这个
 * 队列里的事件没有身份声明（上报 payload 里不能出现 userId 之类的字段），一旦被新身份
 * 补发就会被服务端记成新账号的行为——宁可丢一批身份不明的行为，也不能把 A 的行为挂到 B 上。
 * 把匿名与登录身份缝合起来（例如让服务端在契约里接受身份声明）留给后续 issue，R1 不做。
 *
 * 身份**没变**时绝不轮换：`resetPcSession` 与 `loadMe` 会在每次刷新页面、每次窗口聚焦复核
 * 身份时各调一次，动不动队列就会把待发事件全丢光。
 */
export function syncRecommendationViewer(userId: string | null): void {
  const marker = readViewerMarker()

  // 身份没变（标记与内存都在同一个身份上）：队列一个字都不动。
  if (marker !== null && marker.userId === userId && currentViewer === userId) return

  // 「身份未知 → 匿名」是**唯一保留队列**的轮换：以匿名投递时服务端只会落 `user_id = NULL`，
  // 事件各自带 `anonymousSessionId`，挂不到任何账号头上 —— 冷启动断网期间入队的事件正是靠这条
  // 保住并在身份就绪后补发（不能按「身份不明一律丢」处理，那会把整段离线会话的埋点全删掉，
  // 而且这里并没有任何串号风险）。
  if (marker === null && userId === null) {
    if (!writeViewerMarker(null)) {
      currentViewer = undefined
      return
    }
    currentViewer = null
    return
  }

  // 其余都是真正的轮换：匿名 → 登录、A → B、退出登录，以及「身份未知 → 登录」（那批事件可能
  // 来自匿名会话，按锁定口径「不迁移」丢弃）。必须**先确认队列清空、再确认标记写入**才采纳
  // 新身份；任一步失败就退回「身份不明」，冲刷的身份门会一直关着 —— 宁可停发一批，也不能把
  // 旧身份的行为按新身份的 Cookie 投出去（隐私模式 / 存储异常下 `removeItem` 会静默失效）。
  if (!clearRecommendationQueue()) {
    currentViewer = undefined
    return
  }
  if (!writeViewerMarker(userId)) {
    currentViewer = undefined
    return
  }
  currentViewer = userId

  // 这里**不主动冲刷**：被身份门挡下的事件会由紧接着的入队、15s 定时器、联网 / 回前台事件
  // 补发。在 sync 里 `void flushRecommendationQueue()` 会让 `flushPromise` 在接下来一个
  // 微任务里停留在「刚 settle 但还没清空」的状态，紧跟其后的入队会复用它、白白压一轮。
}

/** 入队即尝试冲刷，不等定时器。 */
export function enqueueRecommendationEvent(event: RecommendationEventInput): void {
  const queue = readQueue()
  queue.push(event)

  const trimmed =
    queue.length > MAX_QUEUE_LENGTH ? queue.slice(queue.length - MAX_QUEUE_LENGTH) : queue
  writeQueue(trimmed)

  void flushRecommendationQueue()
}

/** 同一时刻只允许一个冲刷在飞：并发会把同一批事件发两遍，白白制造 duplicates。 */
let flushPromise: Promise<void> | null = null

/** 串行冲刷队列；重复调用复用同一轮，不会堆积请求。 */
export function flushRecommendationQueue(): Promise<void> {
  flushPromise ??= drainQueue().finally(() => {
    flushPromise = null
  })
  return flushPromise
}

async function drainQueue(): Promise<void> {
  // 身份未知时不投递：冷启动还没解析出登录态，或上一次轮换没能确认清空队列。此刻发送只能按
  // 当时的 Cookie 落 `user_id`，分不清这批事件属于谁。事件留在队列里，等身份就绪后补发。
  const marker = readViewerMarker()
  if (marker === null) return
  if (currentViewer === undefined) return

  // 标记与内存不一致说明本页落后了一轮（另一个标签页 / 页面轮换过身份）。对方会清掉共享
  // 队列，但本页可能在之后又入过队，那一批属于新身份、却和旧身份的事件混在同一个队列里——
  // 分不干净，一律丢弃，绝不替旧身份补发。清不干净就退回「身份不明」：宁可停发。
  if (marker.userId !== currentViewer) {
    if (!clearRecommendationQueue()) {
      currentViewer = undefined
      return
    }
    currentViewer = marker.userId
    return
  }

  for (;;) {
    const queue = readQueue()
    if (queue.length === 0) return

    const batch = queue.slice(0, FLUSH_BATCH_SIZE)

    // 拿到批次之后、POST 之前再复核一次标记：从「读到队列」到这里之间另一个标签页可能
    // 刚换完号，这批事件已经不能算在当前身份名下了；标记消失（身份重新变成未知）同理。
    // 这是把竞态窗口压到一次同步读的取舍——彻底消除它需要服务端在契约上接受「事件所属身份」
    // 的声明（R1 不做），所以这里只是收窄窗口，不是证明安全。
    const beforeSend = readViewerMarker()
    if (beforeSend === null || beforeSend.userId !== currentViewer) return

    if (!(await deliverBatch(batch))) return

    // 按 eventId 出队：冲刷期间新入队的事件要留下（读最新再过滤）。
    const sent = new Set(batch.map((event) => event.eventId))
    const rest = readQueue().filter((event) => !sent.has(event.eventId))

    // 两道判据：写回是否返回成功，以及**重读确认**已发出的 id 真的不在队列里了。
    // `setItem` 在某些浏览器 / 隐私模式下既不抛错也不落盘（静默失败），只看返回值就会以为
    // 出队成功，于是同一批被无限重发、`flushPromise` 永不 settle（之后所有入队与定时器都挂在
    // 死 promise 上）。埋点是尽力而为的旁路，喊一声就收工；事件留在本地，下次写成功时连原
    // eventId 一起补发。
    if (!writeQueue(rest) || readQueue().some((event) => sent.has(event.eventId))) {
      console.warn('[recommendation] 本地队列写回失败，停止本轮冲刷', batch.length)
      return
    }
  }
}

/** 返回是否成功；失败时保留队列，下次连 eventId 一起重试。 */
async function deliverBatch(batch: readonly RecommendationEventInput[]): Promise<boolean> {
  try {
    await postRecommendationEvents(batch)
    return true
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      // 422 只可能是服务端契约校验失败，也就是客户端构造的事件不合法。重试不会变好，
      // 但契约要求非 2xx 一律保留，所以只在开发期喊一声，把客户端 bug 暴露出来。
      console.warn('[recommendation] 事件批次被契约校验拒绝，检查事件构造', error.message)
    }
    return false
  }
}

let lifecycleStarted = false

/**
 * 应用启动时调用一次：补发离线积压，并挂上「重新联网 / 回到前台 / 每 15 秒」的冲刷时机。
 * 幂等，重复调用不会挂上第二组监听器。
 */
export function startRecommendationQueue(): void {
  if (lifecycleStarted) return
  lifecycleStarted = true

  void flushRecommendationQueue()
  window.addEventListener('online', () => void flushRecommendationQueue())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void flushRecommendationQueue()
  })
  window.setInterval(() => void flushRecommendationQueue(), FLUSH_INTERVAL_MS)
}
