/**
 * 业务实时通道的小程序端实现（#67 第三步）。
 *
 * 契约冻结的三条连接语义（`packages/contracts/src/chat/schema.ts`）：
 * ① 鉴权走 session cookie，与 HTTP 是同一身份；② 未认证时服务端在 upgrade 前
 * 401 拒绝，不存在「连上后再收错误帧」；③ 服务端把当前用户**全部**会话的新消息
 * 推给本连接，没有 subscribe 帧。
 *
 * 小程序没有浏览器那套 cookie jar，`Taro.connectSocket` 不会自动带上 cookie，
 * 所以握手头必须自己塞 `Cookie` —— 与 `lib/request.ts` 对 HTTP 的做法同源。
 *
 * 与 Web 端（`apps/web/src/features/chat/realtime.ts`）的两处关键差别：
 *
 * 1. **身份绑定**。Web 端是模块单例、连接寿命等于标签页；小程序里退出 / 换号发生在
 *    同一个进程内，所以这里记下每条连接属于哪个 `userId`：`connectRealtime` 发现身份
 *    变了就先关旧连接、并把它的重连任务一并作废（`generation` 自增），再连新的。
 *    少了这层，旧账号的连接会继续把**它的**消息推给新账号的界面。
 * 2. **「已重连」信号**。`onOpen` 除了重置退避，还会派发一次重连信号，订阅方据此用
 *    历史接口补齐断档（见 `realtime-recovery.ts` 的 `backfillMessageGap`）。
 */
import type { MediaRealtimeEvent, RealtimeServerEvent } from '@fish/contracts/chat/schema'
import { mediaRealtimeEventSchema, realtimeServerEventSchema } from '@fish/contracts/chat/schema'
import Taro from '@tarojs/taro'
import { useEffect, useRef } from 'react'
import { API_BASE } from '@/lib/api-base'
import { sessionCookieHeader } from '@/lib/session'
import { realtimeUrl, reconnectDelayMs } from './realtime-recovery'

/** 保活心跳间隔（与 Web 端同值）。服务端只回 pong，不按心跳超时踢人。 */
const PING_INTERVAL_MS = 25_000

/**
 * `Taro.connectSocket` 解析出来的 SocketTask。
 *
 * 类型上它返回 `Promise<SocketTask>`（Taro 4 的文档示例也是 `.then(task => …)`），
 * 而有的平台在运行时直接给同步的 task 对象；调用处统一 `await` 取，
 * 两种形态都能拿到 task，不必分支判断。
 */
type SocketTask = Awaited<ReturnType<typeof Taro.connectSocket>>

/** 服务端在 `/ws/chat` 上推的两类事件：通用实时事件 + 独立媒体事件 */
export type RealtimeEvent = RealtimeServerEvent | MediaRealtimeEvent

export type RealtimeListener = (event: RealtimeEvent) => void
/** 「连接已建立 / 已重连」——订阅方据此补齐断档，不是「消息」事件 */
export type ReconnectListener = () => void

const eventListeners = new Set<RealtimeListener>()
const reconnectListeners = new Set<ReconnectListener>()

type RealtimeState = {
  socket: SocketTask | null
  /** 这条连接属于哪个账号；null = 当前没有连接 */
  identity: string | null
  /**
   * 连接代次。每次 `disconnectRealtime` / 换身份自增，在途的 open / message / close
   * 回调与重连定时器都带着旧代次，一律失效 —— 这就是「退出、换号时作废重连任务」。
   */
  generation: number
  retry: number
  timer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
  /** 主动关闭（登出 / 未登录）：onClose 不得再排程重连 */
  intentionallyClosed: boolean
  /** 当前 socket 是否已经 onOpen（用来区分「连接中」与「已连上」） */
  opened: boolean
  /**
   * 正在建连的数量。`Taro.connectSocket` 要 await 才拿得到 task，那段窗口里
   * `state.socket` 还是 null —— 没有这个计数，`useRealtimeSession` 的 effect 与
   * `onAppShow` 补连在同一 tick 各调一次 `connectRealtime` 就会开出两条连接，
   * 其中一条的事件还会被重复派发。
   */
  inflight: number
}

const state: RealtimeState = {
  socket: null,
  identity: null,
  generation: 0,
  retry: 0,
  timer: null,
  pingTimer: null,
  intentionallyClosed: true,
  opened: false,
  inflight: 0,
}

function stopPing(): void {
  if (state.pingTimer) clearInterval(state.pingTimer)
  state.pingTimer = null
}

function clearRetryTimer(): void {
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
}

/** 关掉当前 socket，并把与它绑定的一切（心跳、打开标记）一起清掉 */
function teardownSocket(): void {
  const socket = state.socket
  state.socket = null
  state.opened = false
  stopPing()
  if (!socket) return
  try {
    socket.close({})
  } catch {
    /* 已经断了：close 抛错不致命 */
  }
}

function dispatchEvent(event: RealtimeEvent): void {
  for (const listener of eventListeners) listener(event)
}

/**
 * 坏帧静默忽略（与服务端「不因坏帧断连」对称），过期连接的帧一律丢弃。
 *
 * 媒体走**独立的** `media.new` 事件（服务端刻意不并进 `realtimeServerEventSchema`，
 * 以免破坏未接入媒体的客户端），所以这里要依次试两个 schema。
 */
function handleMessage(generation: number, raw: unknown): void {
  if (generation !== state.generation) return
  if (typeof raw !== 'string') return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return
  }
  const result = realtimeServerEventSchema.safeParse(parsed)
  if (result.success) {
    dispatchEvent(result.data)
    return
  }
  const media = mediaRealtimeEventSchema.safeParse(parsed)
  if (media.success) dispatchEvent(media.data)
}

function scheduleReconnect(): void {
  if (state.intentionallyClosed || state.timer) return
  const delay = reconnectDelayMs(state.retry)
  state.retry += 1
  state.timer = setTimeout(() => {
    state.timer = null
    void openSocket()
  }, delay)
}

/**
 * 建一条连接并挂上事件。
 *
 * `Taro.connectSocket` 是异步给出 task 的，所以拿到之后要再验一次代次：await 期间
 * 完全可能发生退出 / 换号，那条连接已经不属于任何身份，必须就地关掉 —— 否则它会以
 * 「幽灵连接」的身份继续把旧账号的消息推进来。
 */
async function openSocket(): Promise<void> {
  if (state.identity === null) return
  const cookie = sessionCookieHeader()
  // 本地没有会话就没有可用身份：连上去也只会被 upgrade 前 401 打回
  if (!cookie) return

  const generation = state.generation
  state.inflight += 1
  let socket: SocketTask
  try {
    socket = await Taro.connectSocket({
      url: realtimeUrl(API_BASE),
      header: { Cookie: cookie },
    })
  } catch {
    state.inflight -= 1
    if (generation !== state.generation) return
    scheduleReconnect()
    return
  }
  state.inflight -= 1

  if (generation !== state.generation) {
    try {
      socket.close({})
    } catch {
      /* 已断开 */
    }
    return
  }
  attachSocket(socket, generation)
}

function attachSocket(socket: SocketTask, generation: number): void {
  state.socket = socket
  state.opened = false

  socket.onOpen(() => {
    if (generation !== state.generation) return
    state.retry = 0
    state.opened = true
    stopPing()
    state.pingTimer = setInterval(() => {
      if (generation !== state.generation) return
      socket.send({ data: JSON.stringify({ type: 'ping' }) })
    }, PING_INTERVAL_MS)
    // 每次建立连接都派发：首次连接时订阅方还没有本地消息，补齐会退化成取一页
    // （见 `backfillMessageGap` 对空 `knownIds` 的处理），代价可忽略
    for (const listener of reconnectListeners) listener()
  })

  socket.onMessage((event) => {
    handleMessage(generation, event.data)
  })

  socket.onClose(() => {
    if (generation !== state.generation) return
    state.socket = null
    state.opened = false
    stopPing()
    scheduleReconnect()
  })

  socket.onError(() => {
    if (generation !== state.generation) return
    // 与 Web 端同款：交给 onClose 统一走重连排程，避免两条路径各排一次
    try {
      socket.close({})
    } catch {
      /* 忽略 */
    }
  })
}

/**
 * 建立（或复用）属于 `identity` 的连接。
 *
 * 同身份重复调用是安全的：已经连上就空转（`Taro.onAppShow` 每次回前台都会调一次），
 * 没有 socket 时（后台被系统回收、退避还没到点）立刻重试而不等退避。
 */
export function connectRealtime(identity: string): void {
  if (state.identity === identity) {
    // 建连中或已连上：空转（`Taro.onAppShow` 每次回前台都会调一次）
    if (state.socket || state.inflight > 0) return
    clearRetryTimer()
    state.retry = 0
    state.intentionallyClosed = false
    void openSocket()
    return
  }

  // 换身份：先关旧连接，再作废它的重连任务
  disconnectRealtime()
  state.identity = identity
  state.intentionallyClosed = false
  state.generation += 1
  void openSocket()
}

/**
 * 关闭连接并作废它的重连任务（退出登录 / 未登录 / 换号前）。
 *
 * `generation` 自增是关键：旧 socket 的 onClose 回来时代次已经变了，不会再去排下一次
 * 重连 —— 否则退出后旧账号的连接会一直重连下去。
 */
export function disconnectRealtime(): void {
  state.intentionallyClosed = true
  state.identity = null
  state.retry = 0
  state.generation += 1
  clearRetryTimer()
  teardownSocket()
}

/** 订阅服务端事件（`message.new` / `conversation.read` / `pong`），返回退订函数 */
export function subscribeRealtime(listener: RealtimeListener): () => void {
  eventListeners.add(listener)
  return () => {
    eventListeners.delete(listener)
  }
}

/** 订阅「连接已建立」（含重连），返回退订函数 */
export function subscribeReconnect(listener: ReconnectListener): () => void {
  reconnectListeners.add(listener)
  return () => {
    reconnectListeners.delete(listener)
  }
}

/** 当前连接属于哪个账号（测试 / 调试用） */
export function realtimeIdentity(): string | null {
  return state.identity
}

/**
 * 登录后建立连接，登出 / 换号自动关闭。
 *
 * 挂载点只有一个（`app.ts`），所以这里不写「卸载即断开」的清理：身份变化本身就会
 * 触发重连，而清理函数在换号时反而会先把新连接关掉。
 */
export function useRealtimeSession(identity: string | null): void {
  const identityRef = useRef(identity)
  identityRef.current = identity

  useEffect(() => {
    if (identity) connectRealtime(identity)
    else disconnectRealtime()
  }, [identity])

  /**
   * 回到前台补连：小程序退到后台后 socket 可能已被系统回收，而 `onClose` 未必送达
   * （那时既没有重连排程，界面也再也收不到新消息）。按**当前**身份再连一次，
   * 同身份且已连上时空转。
   *
   * 身份走 ref 读最新值：`onAppShow` 只注册一次，直接闭包会拿到挂载时的 `identity`。
   * `offAppShow` 必须在清理时调用，否则每次重挂都会多一个监听器。
   */
  useEffect(() => {
    const onShow = () => {
      const current = identityRef.current
      if (current) connectRealtime(current)
    }
    Taro.onAppShow(onShow)
    return () => {
      Taro.offAppShow(onShow)
    }
  }, [])
}
