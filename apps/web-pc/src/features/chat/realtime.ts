import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import { type RealtimeServerEvent, realtimeServerEventSchema } from '@fish/contracts/chat/schema'
import { useEffect, useRef, useState } from 'react'

export type ChatRealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export type RealtimeSocket = {
  send(data: string): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type RealtimeTimers = {
  setTimeout: (handler: () => void, timeout: number) => unknown
  clearTimeout: (handle: unknown) => void
  setInterval: (handler: () => void, timeout: number) => unknown
  clearInterval: (handle: unknown) => void
}

export type ChatRealtimeOptions = {
  url?: string
  createSocket?: (url: string) => RealtimeSocket
  onEvent: (event: RealtimeServerEvent) => void
  onOpen?: () => void
  onStatusChange?: (status: ChatRealtimeStatus) => void
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  random?: () => number
  timers?: RealtimeTimers
}

const defaultTimers: RealtimeTimers = {
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (handler, timeout) => globalThis.setInterval(handler, timeout),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}

function defaultRealtimeUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}${REALTIME_WS_PATH}`
}

export function parseRealtimeEvent(raw: unknown): RealtimeServerEvent | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = realtimeServerEventSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function reconnectDelay(
  attempt: number,
  options: { baseMs: number; maxMs: number; random: () => number },
): number {
  const exponential = Math.min(options.maxMs, options.baseMs * 2 ** Math.max(0, attempt))
  const jitter = 0.5 + Math.min(Math.max(options.random(), 0), 1) * 0.5
  return Math.max(0, Math.round(exponential * jitter))
}

export class ChatRealtime {
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly reconnectBaseDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly random: () => number
  private readonly timers: RealtimeTimers
  private socket: RealtimeSocket | null = null
  private status: ChatRealtimeStatus = 'closed'
  private stopped = false
  private hasOpened = false
  private reconnectAttempt = 0
  private reconnectTimer: unknown = null
  private heartbeatTimer: unknown = null
  private pongTimer: unknown = null

  constructor(private readonly options: ChatRealtimeOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 10_000
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000
    this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? 30_000
    this.random = options.random ?? Math.random
    this.timers = options.timers ?? defaultTimers
  }

  start(): void {
    if (this.socket !== null) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearReconnectTimer()
    this.clearHeartbeat()
    const socket = this.socket
    this.socket = null
    socket?.close()
    this.setStatus('closed')
  }

  private connect(): void {
    if (this.stopped) return

    const createSocket =
      this.options.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as RealtimeSocket)
    const socket = createSocket(this.options.url ?? defaultRealtimeUrl())
    this.socket = socket
    this.setStatus(this.hasOpened ? 'reconnecting' : 'connecting')

    socket.onopen = () => this.handleOpen(socket)
    socket.onmessage = (event) => this.handleMessage(event.data)
    socket.onclose = () => this.handleClose(socket)
    socket.onerror = () => this.handleError(socket)
  }

  private handleOpen(socket: RealtimeSocket): void {
    if (this.socket !== socket || this.stopped) return

    this.hasOpened = true
    this.reconnectAttempt = 0
    this.setStatus('open')
    this.startHeartbeat()
    this.options.onOpen?.()
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

  private handleError(socket: RealtimeSocket): void {
    if (this.socket !== socket) return
    try {
      socket.close()
    } catch {
      // 某些实现已在 error 后关闭连接；下面仍按 close 处理以触发重连。
    }
    this.handleClose(socket)
  }

  private handleClose(socket: RealtimeSocket): void {
    if (this.socket !== socket) return
    this.socket = null
    this.clearHeartbeat()
    if (this.stopped) return
    this.scheduleReconnect()
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

      this.socket.send(JSON.stringify({ type: 'ping' }))
      this.pongTimer = this.timers.setTimeout(() => {
        this.pongTimer = null
        this.socket?.close()
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

  private setStatus(status: ChatRealtimeStatus): void {
    if (this.status === status) return
    this.status = status
    this.options.onStatusChange?.(status)
  }
}

export type ChatRealtimeHandlers = {
  onEvent: (event: RealtimeServerEvent) => void
  onOpen?: () => void
  onStatusChange?: (status: ChatRealtimeStatus) => void
}

/**
 * 页面级实时连接 hook。一个挂载实例只建一个 `/ws/chat`，不是每个会话一个连接。
 * 回调放 ref，避免父组件每次渲染都重建 WebSocket。
 */
export function useChatRealtime(
  ownerId: string | null,
  handlers: ChatRealtimeHandlers,
): ChatRealtimeStatus {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const [status, setStatus] = useState<ChatRealtimeStatus>('closed')

  useEffect(() => {
    if (ownerId === null) {
      setStatus('closed')
      return
    }

    const realtime = new ChatRealtime({
      onEvent: (event) => handlersRef.current.onEvent(event),
      onOpen: () => handlersRef.current.onOpen?.(),
      onStatusChange: (next) => {
        setStatus(next)
        handlersRef.current.onStatusChange?.(next)
      },
    })
    realtime.start()
    return () => realtime.stop()
  }, [ownerId])

  return status
}
