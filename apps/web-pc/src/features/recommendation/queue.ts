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
 * 读取身份标记；`null` 表示「没有标记」（首次使用、旧版本客户端、或存储不可用）。
 *
 * 读不出来一律当成没有标记：调用方按「身份不明 → 不投递」处理（遗留队列在模块加载时就被
 * `dropUnattributableQueue()` 丢掉了，身份解析出来之前入队的事件则留在队列里等身份就绪）。
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

/** 写入身份标记；写不进去只影响下一次轮换的判定，不能打断用户操作。 */
function writeViewerMarker(userId: string | null): void {
  try {
    window.localStorage.setItem(VIEWER_STORAGE_KEY, JSON.stringify({ userId }))
  } catch {
    // 配额写满 / 隐私模式：与队列同样的尽力而为语义，这里连告警都不值得打。
  }
}

/** 丢弃队列（含存储里的副本）：无法归属的事件宁可丢，也不能挂到别人账号上。 */
export function clearRecommendationQueue(): void {
  try {
    window.localStorage.removeItem(QUEUE_STORAGE_KEY)
  } catch {
    // 存储不可用时本来也没有可用的队列。
  }
}

/**
 * 丢弃「身份不明」的遗留队列。
 *
 * 模块**加载时**调用一次：那一刻队列里的事件不可能是本次页面生命周期写下的（埋点入口还没
 * 接上），只可能来自旧版本客户端（那时还没有身份标记）。这类事件无法归属，补发时会被服务端
 * 按当时的 Cookie 记到别人账号上 —— 宁可丢，也不能串号。
 *
 * 导出是为了可测：模块加载后就再没有第二个这样的时机了。
 */
export function dropUnattributableQueue(): void {
  if (readViewerMarker() !== null) return
  if (readQueue().length === 0) return
  clearRecommendationQueue()
}

dropUnattributableQueue()

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

  if (marker === null) {
    // 身份从「未知」第一次变成已知。已知身份是某个账号时，队列里那批事件可能是匿名会话产生
    // 的（身份解析出来之前就入了队），挂到账号上就是一次「匿名 → 登录」迁移 —— 按锁定口径
    // 丢弃。已知身份仍是匿名则保留：它们本来就是匿名会话的事件。
    // 遗留队列（旧版本客户端写的、身份不明）不在这里丢，`dropUnattributableQueue()` 在模块
    // 加载时已经处理过一次了。
    if (userId !== null && readQueue().length > 0) clearRecommendationQueue()
  } else if (marker.userId !== userId) {
    // 登录 / 退出 / 换号：未发送的旧身份事件一律丢弃。
    clearRecommendationQueue()
  }

  writeViewerMarker(userId)
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
  // 身份未知（冷启动还没解析出登录态）时不投递：此刻发送只能按当时的 Cookie 落 `user_id`，
  // 分不清这批事件属于谁。事件留在队列里，等 `syncRecommendationViewer` 写下标记后补发。
  const marker = readViewerMarker()
  if (marker === null) return

  // 标记与内存不一致说明本页落后了一轮（另一个标签页 / 页面轮换过身份）。对方会清掉共享
  // 队列，但本页可能在之后又入过队，那一批属于新身份、却和旧身份的事件混在同一个队列里——
  // 分不干净，一律丢弃，绝不替旧身份补发。
  if (marker.userId !== currentViewer) {
    clearRecommendationQueue()
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
