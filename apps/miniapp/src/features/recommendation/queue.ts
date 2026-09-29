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

/**
 * 「当前身份」标记的存储 key：规格固定值，不要改名。
 *
 * 身份**单独一个 key**（不塞进队列条目里）：队列的存储格式保持不变，就不必处理旧格式迁移。
 */
const VIEWER_KEY = 'fish:recommendation:viewer'

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
 * 读「当前身份」标记。
 *
 * 三个返回值的区别是这个模块的关键：`undefined` = **没有标记 / 身份不明**（本客户端还没同步过
 * 身份、旧版本客户端留下的数据、数据损坏、存储不可用）；`null` = 标记存在且当时**未登录**；
 * 字符串 = 当时登录的 userId。读不出来、解析不出来一律当「身份不明」，调用方按「不投递」处理。
 */
function readViewerMarker(): string | null | undefined {
  try {
    const raw: unknown = Taro.getStorageSync(VIEWER_KEY)
    if (typeof raw !== 'object' || raw === null) return undefined
    const userId = (raw as { userId?: unknown }).userId
    if (userId === null) return null
    return typeof userId === 'string' ? userId : undefined
  } catch {
    return undefined
  }
}

/**
 * 写入身份标记，返回**是否真的落盘**（写完重读核对）。
 *
 * 返回值是「采纳新身份」的前置条件：标记没写进去就采纳，内存身份会与存储标记分叉，下一次
 * 冲刷的复核就会失准。写不进去就退回「身份不明」（闸门关着）—— 宁可停发也不能串号。
 */
function writeViewerMarker(userId: string | null): boolean {
  try {
    Taro.setStorageSync(VIEWER_KEY, { userId })
  } catch {
    // 存储失败：下面的重读才是判据。
  }
  const stored = readViewerMarker()
  return stored !== undefined && stored === userId
}

/**
 * 丢弃本地全部待发事件（离队 + 移除队列存储），返回**是否确认清空**（重读核对）。
 *
 * 身份变化时用它：未发送的事件属于**旧身份**，而服务端是按「投递那一刻的会话 cookie」
 * 解析事件归属的（`apps/api/src/modules/recommendation/service.ts` 的 `let userId = viewerId`），
 * 留在队列里只会在换号后被记到新账号头上 —— 那正是本次要修的 blocker。
 *
 * 返回值是「采纳新身份」的前置条件：`removeStorageSync` 同样会静默失效（既不抛错也不生效），
 * 只看有没有抛错就采纳新身份，等于把旧身份留在存储里的事件按新身份投出去。读不回来一律算
 * 没清干净。
 */
export function clearRecommendationQueue(): boolean {
  try {
    Taro.removeStorageSync(QUEUE_KEY)
  } catch {
    // 删不掉没关系，下面的重读才是判据。
  }
  try {
    const raw: unknown = Taro.getStorageSync(QUEUE_KEY)
    return raw === undefined || raw === null || raw === ''
  } catch {
    return false
  }
}

/**
 * 内存里的「当前身份」。
 *
 * `undefined` 与 `null` 的区别同 `readViewerMarker()`：前者是「身份不明」，后者是「标记为未登录」。
 * 模块初始化时读一次，之后只由 `syncRecommendationViewer()` 与冲刷前的存储比对更新。
 */
let currentViewer: string | null | undefined = readViewerMarker()

/**
 * 同步「事件归属身份」（登录 / 注册 / 退出 / 401 过期 / 检测到的换号都必须调）。
 *
 * 为什么宁丢不迁移：服务端从**投递那一刻的会话 cookie** 反解事件归属，客户端改不了这件事。
 * 身份变了以后队列里的事件只剩两条路 —— 以旧身份发（cookie 已经是新的，做不到）或被算成
 * 新身份的行为（错误数据）。所以「匿名 → 登录」与「A → B」一律**丢弃**未发送的旧事件：
 * 宁可丢一批身份不明的行为，也不能把 A 的行为挂到 B 上；把历史行为缝合到某个账号上
 * 留给后续 issue，R1 只解决「不串号」。
 */
export function syncRecommendationViewer(userId: string | null | undefined): void {
  /*
    `undefined` = 调用方明确表示「这次广播不是权威身份」（例如冷启动 `/me` 网络失败，cookie 却
    可能仍然是登录态）。这时既不采纳存储里的标记、也不碰队列，只把内存身份退回「身份不明」、
    闸门关上 —— 否则队列会按仍然有效的登录 Cookie 投出去，那正是要修的串号。
  */
  if (userId === undefined) {
    currentViewer = undefined
    return
  }

  const stored = readViewerMarker()

  /*
    「身份不明 → 匿名」是**唯一保留队列**的轮换：以匿名投递时服务端只会落 `user_id = NULL`，
    事件各自带 `anonymousSessionId`，挂不到任何账号头上 —— 冷启动断网期间入队的事件正是靠这条
    保住并在身份就绪后补发（不能按「身份不明一律丢」处理：那会把整段离线会话的埋点删光，
    而且这里并没有任何串号风险）。
  */
  if (stored === undefined && userId === null) {
    if (!writeViewerMarker(null)) {
      currentViewer = undefined
      return
    }
    currentViewer = null
    return
  }

  if (stored === userId && stored !== undefined && currentViewer === userId) {
    // 身份没变：只更新内存。**不许轮换** —— 否则每次刷新页面 / 每个 401 都会把待发事件丢光
    return
  }

  /*
    其余都是真正的轮换：匿名 → 登录、A → B、退出登录，以及「身份不明 → 登录」（那批事件可能
    来自匿名会话，按锁定口径「不迁移」丢弃）。必须**先确认队列清空、再确认标记写入**才采纳新
    身份；任一步失败就退回「身份不明」，冲刷的闸门会一直关着 —— 宁可停发一批，也不能把旧身份
    的行为按新身份的 Cookie 投出去。
  */
  if (!clearRecommendationQueue()) {
    currentViewer = undefined
    return
  }
  if (!writeViewerMarker(userId)) {
    currentViewer = undefined
    return
  }
  currentViewer = userId
}

/**
 * 用存储里的身份标记校正内存身份；返回「本轮还能不能用手里这份队列投递」。
 *
 * 四种情况：
 * - 没有标记（`undefined`）：身份还没解析出来，手里这批事件属于谁不知道 —— 留着，等
 *   `syncRecommendationViewer` 写下标记后再发（冷启动会先入队、后解析身份）。
 * - 内存身份也是「不明」（上一次轮换没能确认清空队列）：闸门关着，不投递。
 * - 标记与内存一致：正常投递。
 * - 标记与内存不一致：另一个页面在本页不知情时轮换过身份。对方会清空队列，所以本页通常读到
 *   空队列；但队列也可能还在（对方写存储失败，或标记不是走 `syncRecommendationViewer` 改的）
 *   —— 那时队列里的事件属于**旧身份**，只能丢，绝不能以新身份投递；清不干净就退回「身份不明」。
 *   代价是「对方轮换后、本页下一次冲刷前新入队的事件」也会被丢，在「宁丢不串号」的口径下这是
 *   可接受的保守选择。
 */
function refreshViewerFromStorage(): boolean {
  const stored = readViewerMarker()
  if (stored === undefined) return false
  if (currentViewer === undefined) return false
  if (stored === currentViewer) return true
  if (!clearRecommendationQueue()) {
    currentViewer = undefined
    return false
  }
  currentViewer = stored
  return false
}

/**
 * 投递前的最后一道把关：存储里的身份标记与内存身份是否仍然一致。
 *
 * 读批次与 POST 之间用户完全可能换号（换号方会清队列，但本页手里已经握着那一批了），标记也
 * 可能整个消失（身份重新变成未知）。这里再读一次存储，把竞态窗口压到「一次同步读」；要**彻底**
 * 消除它，需要服务端在契约上声明事件归属身份（上报 payload 里带 userId 之类字段），R1 明确
 * 不做 —— 所以这是取舍，不是完备解。
 */
function viewerStillCurrent(): boolean {
  const stored = readViewerMarker()
  return stored !== undefined && stored === currentViewer
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
    // 先按存储里的标记刷新内存身份：另一个页面可能已经轮换过（此时队列已被对方清空，
    // 本轮读到空队列直接返回）；身份对不上就丢弃手里那份旧身份的队列并收工
    if (!refreshViewerFromStorage()) return

    const queue = readQueue()
    if (queue.length === 0) return
    const batch = queue.slice(0, BATCH_SIZE)
    const sendable = batch.filter((event) => isSendable(event))

    if (sendable.length > 0) {
      // 读批次 → 投递之间可能被换号：POST 前再比对一次存储标记（理由见 `viewerStillCurrent`）
      if (!viewerStillCurrent()) return
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
