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
  for (;;) {
    const queue = readQueue()
    if (queue.length === 0) return

    const batch = queue.slice(0, FLUSH_BATCH_SIZE)
    if (!(await deliverBatch(batch))) return

    // 按 eventId 出队：冲刷期间新入队的事件要留下（读最新再过滤）。
    const sent = new Set(batch.map((event) => event.eventId))
    const written = writeQueue(readQueue().filter((event) => !sent.has(event.eventId)))
    if (written) continue

    // 写回失败：本地队列一个字都没变，再循环只会把同一批无限重发——`flushPromise` 永不
    // settle，之后所有入队与定时器都挂在死 promise 上。埋点是尽力而为的旁路，喊一声就收工；
    // 事件留在本地，下次写成功时连原 eventId 一起补发。
    console.warn('[recommendation] 本地队列写回失败，停止本轮冲刷', batch.length)
    return
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
