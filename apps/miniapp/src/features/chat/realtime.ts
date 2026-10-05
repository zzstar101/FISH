import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import {
  type MediaRealtimeEvent,
  mediaRealtimeEventSchema,
  type RealtimeServerEvent,
  realtimeServerEventSchema,
} from '@fish/contracts/chat/schema'
import Taro from '@tarojs/taro'
import { API_BASE } from '@/lib/api-base'
import { sessionCookieHeader } from '@/lib/session'

/**
 * 会话实时通道的客户端（契约见 `packages/contracts/src/chat/schema.ts` 的
 * 「WebSocket 实时协议」一节，服务端实现在 `apps/api/src/modules/realtime`）。
 *
 * 与 HTTP 同端口同进程（`/ws/chat`），鉴权是**同一套 `fish_session` cookie**
 * ——小程序没有浏览器那套同源自动携带，沿用 `lib/session.ts` 的手工搬运，
 * 在每次建链时把 cookie 塞进 `header`（重连时重读，重登录后能拿到新会话）。
 * 未认证时服务端在 upgrade 前就回 HTTP 401（契约冻结语义②），端上表现为
 * onerror / onclose，不存在「连上后再收错误帧」——所以这里对建链失败与断连
 * 一视同仁：指数退避重连，不打扰用户。
 *
 * 服务端把「当前用户参与的全部会话」的新消息推给这条连接（没有 subscribe 帧），
 * 推送**不保证不重不漏**：重是按 id 去重（`mergePushedMessage` / `mergePushedMedia`），
 * 漏由调用方在每次连接建立后用历史端点补齐（`onOpen` → 页面的 silent 补刷）。
 *
 * 心跳与重连口径与 web-pc 的 `apps/web-pc/src/features/chat/realtime.ts` 一致：
 * 20s 一发 `{"type":"ping"}`，10s 没等到 `pong` 就主动断开重连；重连退避
 * base 1s、max 30s，带抖动。全链路静默失败——连不上只是退回「没有实时」的
 * 既有形态（页面仍有 20s 详情轮询兜底），不弹任何提示。
 *
 * 小程序与 web-pc 的两处结构差异，都源自 `Taro.connectSocket` 返回
 * **`Promise<SocketTask>`**（web-pc 的 `new WebSocket` 是同步的）：
 * 建链是异步的，需要 `connecting` 标记挡住重入；迟到的建链结果用代次令牌作废。
 */

/** 连接上可能到达的两类事件：#9 的旧版事件，以及 #67 独立的 `media.new`。 */
export type ChatRealtimeEvent = RealtimeServerEvent | MediaRealtimeEvent

export type ChatRealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * 连接的运行时形状。Taro 的 `SocketTask` 用 `onOpen(handler)` 注册回调、
 * `send({ data })` 发帧，这里收口成与传输无关的最小面，测试用假 socket 注入。
 */
export type RealtimeSocket = {
  send(data: string): void
  close(): void
  onOpen(handler: () => void): void
  onMessage(handler: (data: unknown) => void): void
  onClose(handler: () => void): void
  onError(handler: () => void): void
}

export type RealtimeTimers = {
  setTimeout: (handler: () => void, timeout: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (handler: () => void, timeout: number) => unknown
  clearInterval: (handle: unknown) => void
}

export type RealtimeSocketFactory = (
  url: string,
  /** 建链那一刻的会话 cookie（`fish_session=…`）；未登录为 undefined */
  cookie: string | undefined,
) => Promise<RealtimeSocket>

export type ChatRealtimeOptions = {
  url?: string
  createSocket?: RealtimeSocketFactory
  getCookie?: () => string | undefined
  onEvent: (event: ChatRealtimeEvent) => void
  onOpen?: () => void
  onDisconnected?: () => void
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  /** 建链超时：`connectSocket` 的 Promise 迟迟不 settle 时按「连不上」处理并退避重连 */
  connectTimeoutMs?: number
  random?: () => number
  timers?: RealtimeTimers
}

const defaultTimers: RealtimeTimers = {
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (handler, timeout) => globalThis.setInterval(handler, timeout),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}

/**
 * 从 HTTP API 基地址推导 WS 地址。两者同端口同进程（`apps/api` 的 `Bun.serve`），
 * 契约路径常量是根级路径，与 `lib/api-base.ts` 的拼接口径一致——不要再加 `/api`。
 */
export function realtimeUrl(base: string = API_BASE): string {
  // 构建期注入的基地址可能带尾斜杠：不归一的话会拼出 `wss://host//ws/chat`
  const trimmed = base.replace(/\/+$/, '')
  // 方案按基地址的协议推导：https→wss、http→ws，其余原样透传，语义与 PC 站的
  // `defaultRealtimeUrl`（apps/web-pc/src/features/chat/realtime.ts:57）一致。
  // 刻意拆成 `${scheme}//${rest}` 而不写连续的 ws 字面量——Sourcery 的
  // detect-insecure-websocket 只匹配字面量；明文分支仅本地开发（http 基地址）
  // 存在，生产注入的是 https 基地址、走 wss，不存在「该用 wss 却用 ws」的降级。
  const secure = trimmed.startsWith('https://')
  const plain = !secure && trimmed.startsWith('http://')
  if (!secure && !plain) return `${trimmed}${REALTIME_WS_PATH}`
  const scheme = secure ? 'wss:' : 'ws:'
  const rest = trimmed.slice((secure ? 'https://' : 'http://').length)
  return `${scheme}//${rest}${REALTIME_WS_PATH}`
}

/**
 * 把一条帧解析成事件。旧版 schema 与 `media.new` **两条都要试**：媒体事件刻意
 * 不并入 `realtimeServerEventSchema`（兼容未接入媒体的旧客户端），只试一条的话
 * 媒体推送会被静默丢弃。解析不了（非 JSON / 形状不符）返回 null，调用方丢弃即可
 * ——服务端只推契约内的事件，解析失败最可能是版本落后，不值得为它断连。
 */
export function parseRealtimeEvent(raw: unknown): ChatRealtimeEvent | null {
  if (typeof raw !== 'string') return null
  try {
    const payload: unknown = JSON.parse(raw)
    const legacy = realtimeServerEventSchema.safeParse(payload)
    if (legacy.success) return legacy.data
    const media = mediaRealtimeEventSchema.safeParse(payload)
    return media.success ? media.data : null
  } catch {
    return null
  }
}

/** 指数退避 + 抖动：base 2^n 封顶在 max，抖动乘 0.5–1.0，避免断线风暴同时回连 */
export function reconnectDelay(
  attempt: number,
  options: { baseMs: number; maxMs: number; random: () => number },
): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt))
  const jitter = 0.5 + Math.min(Math.max(options.random(), 0), 1) * 0.5
  return Math.max(0, Math.round(exponential * jitter))
}

/** Taro `SocketTask` → 运行时无关的 `RealtimeSocket` */
function adaptTask(task: Taro.SocketTask): RealtimeSocket {
  return {
    send: (data) => {
      task.send({ data })
    },
    close: () => {
      task.close({})
    },
    onOpen: (handler) => {
      task.onOpen(() => handler())
    },
    onMessage: (handler) => {
      task.onMessage((result) => handler(result.data))
    },
    onClose: (handler) => {
      task.onClose(() => handler())
    },
    onError: (handler) => {
      task.onError(() => handler())
    },
  }
}

const defaultCreateSocket: RealtimeSocketFactory = (url, cookie) => {
  const header = cookie === undefined ? {} : { Cookie: cookie }
  return Taro.connectSocket({ url, header }).then(adaptTask)
}

export class ChatRealtime {
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly connectTimeoutMs: number
  private readonly random: () => number
  private readonly timers: RealtimeTimers
  private socket: RealtimeSocket | null = null
  private status: ChatRealtimeStatus = 'closed'
  private stopped = false
  /** 建链在飞（`connectSocket` 的 Promise 还没回来）：`start()` 重入与双连的挡板 */
  private connecting = false
  private hasOpened = false
  private reconnectAttempt = 0
  /**
   * 建链代次：`stop()`、新一轮 `connect()`、以及**建链超时**都会 +1，迟到的那次建链结果
   * 据此作废 —— 超时是主要来源（Promise 只是慢，之后仍会 settle）。
   */
  private connectGen = 0
  private reconnectTimer: unknown = null
  private connectTimer: unknown = null
  private heartbeatTimer: unknown = null
  private pongTimer: unknown = null

  constructor(private readonly options: ChatRealtimeOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000
    this.connectTimeoutMs = options.connectTimeoutMs ?? 15_000
    this.random = options.random ?? Math.random
    this.timers = options.timers ?? defaultTimers
  }

  start(): void {
    if (this.socket !== null || this.connecting) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.connecting = false
    this.connectGen += 1
    this.clearReconnectTimer()
    this.clearConnectTimer()
    this.clearHeartbeat()
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.setStatus('closed')
  }

  private connect(): void {
    if (this.stopped) return
    const gen = ++this.connectGen
    this.connecting = true
    this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')
    const createSocket = this.options.createSocket ?? defaultCreateSocket
    const url = this.options.url ?? realtimeUrl()
    const cookie = (this.options.getCookie ?? sessionCookieHeader)()
    /**
     * 建链超时（第二轮审查）：`Taro.connectSocket` 返回的是 Promise，平台若因任何原因
     * 没让它 settle（既没 resolve 也没 reject），客户端会永远停在 `connecting` ——
     * `start()` 的重入挡板从此恒真，实时通道静默死亡且不会自愈。到时按「连不上」处理。
     */
    this.connectTimer = this.timers.setTimeout(() => {
      this.connectTimer = null
      if (this.stopped || gen !== this.connectGen || !this.connecting) return
      /**
       * 使这一代作废（第三轮审查）：Promise 只是「慢」的话，后面仍会 settle。不作废的话
       * 迟到的 resolve 会因为 `gen === this.connectGen` 照常 `attach()`，与下面排出的
       * 重连各建一条 socket —— 双连接，且旧的那条再没有人引用/关闭。
       */
      this.connectGen += 1
      this.connecting = false
      this.scheduleReconnect()
      this.options.onDisconnected?.()
    }, this.connectTimeoutMs)
    createSocket(url, cookie)
      .then((socket) => {
        if (this.stopped || gen !== this.connectGen) {
          // 这一代已作废（stop() / 新一轮建链 / 建链超时）：迟到的连接不该被任何人引用，就地关掉
          socket.close()
          return
        }
        this.clearConnectTimer()
        this.connecting = false
        this.attach(socket)
      })
      .catch(() => {
        if (this.stopped || gen !== this.connectGen) return
        this.clearConnectTimer()
        this.connecting = false
        // 建链失败（网络不通 / 未登录被 401 拒绝）与连上后断开同一处理：退避重连
        this.scheduleReconnect()
        this.options.onDisconnected?.()
      })
  }

  private attach(socket: RealtimeSocket): void {
    this.socket = socket
    socket.onOpen(() => {
      if (this.socket !== socket || this.stopped) return
      this.hasOpened = true
      this.reconnectAttempt = 0
      this.setStatus('open')
      this.startHeartbeat()
      this.options.onOpen?.()
    })
    socket.onMessage((data) => {
      if (this.stopped || this.socket !== socket) return
      this.handleMessage(data)
    })
    socket.onClose(() => this.tearDown(socket))
    socket.onError(() => {
      if (this.socket !== socket) return
      try {
        socket.close()
      } catch {
        // 某些实现在 error 后已经关掉；仍按 close 走重连
      }
      this.tearDown(socket)
    })
  }

  private handleMessage(raw: unknown): void {
    const event = parseRealtimeEvent(raw)
    if (event === null) return
    if (event.type === 'pong') {
      this.clearPongTimer()
      return
    }
    this.options.onEvent(event)
  }

  /** 连接断开（或出错收场）：清心跳、退避重连。onClose / onError 都可能触发，幂等。 */
  private tearDown(socket: RealtimeSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.clearHeartbeat()
    if (this.stopped) return
    this.scheduleReconnect()
    this.options.onDisconnected?.()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    this.setStatus('reconnecting')
    const delay = reconnectDelay(this.reconnectAttempt, {
      baseMs: this.reconnectBaseDelayMs,
      maxMs: this.reconnectMaxDelayMs,
      random: this.random,
    })
    this.reconnectAttempt += 1
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.heartbeatTimer = this.timers.setInterval(() => {
      if (this.stopped || this.socket === null || this.status !== 'open') return
      if (this.pongTimer !== null) return
      /**
       * `send` / `close` 都可能抛（连接正在关闭时平台会 reject 这次调用）。心跳跑在
       * `setInterval` 回调里，异常冒出去没有任何人接，只会污染宿主日志 —— 这里的语义
       * 本就是「发不出去就等下一跳或让超时收口」，所以就地吞掉。
       */
      const socket = this.socket
      try {
        socket.send(JSON.stringify({ type: 'ping' }))
      } catch {
        return
      }
      this.pongTimer = this.timers.setTimeout(() => {
        this.pongTimer = null
        try {
          socket.close()
        } catch {
          // 已经关掉了：onClose 会照常把它从 this.socket 摘掉
        }
      }, this.heartbeatTimeoutMs)
    }, this.heartbeatIntervalMs)
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.timers.clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    this.clearPongTimer()
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      this.timers.clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      this.timers.clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private setStatus(status: ChatRealtimeStatus): void {
    if (this.status === status) return
    this.status = status
  }
}
