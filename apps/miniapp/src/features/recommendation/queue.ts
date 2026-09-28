/**
 * 埋点事件的本地队列与冲刷（Issue #323 R1 §3.2）。
 *
 * 为什么必须有队列：小程序切后台、断网、请求超时都是常态，事件不能「发一次不成功就丢」。
 * 队列把「记录行为」与「送达服务端」解耦：入队即落盘，之后尽力重发。
 *
 * 重发的正确性靠 `eventId`（入队时生成、之后永不改写）：服务端按它去重，重复投递的正常
 * 结果是 `duplicates` 而不是再记一条（契约里 `duplicates` 就是为这个场景定义的）。
 */
import {
  type RecommendationEventInput,
  RecommendationEventInputSchema,
} from '@fish/contracts/recommendation/schema'
import Taro from '@tarojs/taro'
import { postRecommendationEvents } from './api'

/** 存储 key：规格固定值，不要改名 */
const QUEUE_KEY = 'fish.recommendation.queue'

/** 队列上限：超出丢**最旧**的。不设上限会在长期离线时把 storage 撑爆 */
const MAX_QUEUE_LENGTH = 500

/** 单批条数：与 `RecommendationEventBatchSchema` 的 `.max(50)` 同值 */
const BATCH_SIZE = 50

/** 定时冲刷间隔 */
const FLUSH_INTERVAL_MS = 15_000

function readQueue(): RecommendationEventInput[] {
  try {
    const raw: unknown = Taro.getStorageSync(QUEUE_KEY)
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (item): item is RecommendationEventInput => typeof item === 'object' && item !== null,
    )
  } catch {
    return []
  }
}

/**
 * 写回队列，返回**是否真的落盘**。
 *
 * 返回值是 `runFlush` 的循环退出条件：写失败时队列内容不变，继续循环只会把同一批事件
 * 无限重发（见 `runFlush`）。
 */
function writeQueue(queue: RecommendationEventInput[]): boolean {
  try {
    if (queue.length === 0) {
      Taro.removeStorageSync(QUEUE_KEY)
      return true
    }
    Taro.setStorageSync(QUEUE_KEY, queue)
    return true
  } catch {
    /* 存储失败不致命：本轮不落盘，事件仍可能在本次冲刷里送出去 */
    return false
  }
}

/**
 * 发送前的契约自检。
 *
 * 不合格的事件（比如元数据多了个键）服务端一定拒收，**重试也不会变好** —— 留着它会让
 * 它所在的每一批都失败，把整个队列堵死。所以就地丢弃并留日志。
 */
function isSendable(event: RecommendationEventInput): boolean {
  const parsed = RecommendationEventInputSchema.safeParse(event)
  if (parsed.success) return true
  console.warn('[recommendation] 丢弃不合格的埋点事件', event.eventId, parsed.error.issues)
  return false
}

/**
 * 冲刷串行闸门。
 *
 * 两次并发冲刷会各自读到同一批事件、各自投递（服务端能去重，但白费一次请求），
 * 更糟的是两次成功时各自把基于旧快照的队列写回，把中间新入队的事件覆盖掉。
 */
let flushInFlight: Promise<void> | null = null

export function flushRecommendationQueue(): Promise<void> {
  if (flushInFlight) return flushInFlight
  const running = runFlush().finally(() => {
    flushInFlight = null
  })
  flushInFlight = running
  return running
}

async function runFlush(): Promise<void> {
  for (;;) {
    const queue = readQueue()
    if (queue.length === 0) return
    const batch = queue.slice(0, BATCH_SIZE)
    const sendable = batch.filter((event) => isSendable(event))

    if (sendable.length > 0) {
      try {
        await postRecommendationEvents(sendable)
      } catch {
        // 非 2xx / 网络异常：这一批**整体保留**（eventId 不变，下次重发），本轮到此为止
        return
      }
    }

    // 只有 2xx 才移除，且只移除本次**消费过**的那些 id（含被丢弃的不合格项）。
    // 不能整表写回 `queue.slice(BATCH_SIZE)`：await 期间新入队的事件会在这中间丢掉。
    const consumed = new Set(batch.map((event) => event.eventId))
    const rest = readQueue().filter((event) => !consumed.has(event.eventId))

    /*
      退出条件必须是「队列**真的**被缩短了」，不能是「这一批发完了」。
      写回失败时存储里还是原队列，下一轮读到同一批 → 再 POST 一次 → 再写失败……
      服务端能按 eventId 去重，但客户端会一直发下去：循环永不退出，flush promise 永不
      settle，之后所有入队与定时器都吊在这个死 promise 上。
      两个判据都要：写回抛错时看返回值；存储「不抛错但也没写进去」时，重读里那些已消费的
      id 还在，同样说明这一步没生效。任一为假就警告一次并结束本轮（事件留着，下轮重试）。
    */
    if (!writeQueue(rest) || readQueue().some((event) => consumed.has(event.eventId))) {
      console.warn('[recommendation] 事件队列写回失败，已停止本轮冲刷（事件保留，下次重试）')
      return
    }
  }
}

/** 入队一条事件并立刻尝试冲刷（落盘先于发送，所以即使立刻失败也不会丢） */
export function enqueueRecommendationEvent(event: RecommendationEventInput): void {
  const queue = readQueue()
  queue.push(event)
  // 超出上限丢最旧的：越近的事件越有价值，且曝光序号是递增的，尾部才是当前会话
  writeQueue(queue.length > MAX_QUEUE_LENGTH ? queue.slice(queue.length - MAX_QUEUE_LENGTH) : queue)
  void flushRecommendationQueue()
}

let autoFlushStarted = false

/**
 * 注册自动冲刷：应用启动、每 15 秒、回到前台、网络恢复各冲一次。
 *
 * 幂等：热重载或重复调用不应注册多个定时器（重复注册会让冲刷频率翻倍）。
 * 不需要清理 —— 它挂在应用级，生命周期与小程序进程一致。
 */
export function startRecommendationQueueAutoFlush(): void {
  if (autoFlushStarted) return
  autoFlushStarted = true
  // 启动就先冲一次：上次退出时队列里可能还留着没送出去的事件
  void flushRecommendationQueue()
  setInterval(() => {
    void flushRecommendationQueue()
  }, FLUSH_INTERVAL_MS)
  Taro.onAppShow(() => {
    void flushRecommendationQueue()
  })
  // 小程序没有浏览器的 online 事件，等价的「网络恢复」信号是网络状态变化
  Taro.onNetworkStatusChange((result) => {
    if (result.isConnected) void flushRecommendationQueue()
  })
}
