import { REALTIME_WS_PATH } from '@fish/contracts/chat/routes'
import type { MessageDto, RealtimeServerEvent } from '@fish/contracts/chat/schema'
import { realtimeServerEventSchema } from '@fish/contracts/chat/schema'
import { useEffect } from 'react'
import { queryClient } from '../../lib/query-client'

/**
 * 业务实时通道（#9 契约冻结的三条连接语义）：
 * ① 鉴权走 session cookie（浏览器同源 WS 自动携带），不需要额外的握手帧；
 * ② 未认证时服务端在 upgrade 前拒绝（onerror/onclose），不存在「连上后再收错误帧」；
 * ③ 服务端把当前用户全部会话的新消息推给本连接，没有 subscribe 帧。
 *
 * 客户端职责：心跳保活（ping → pong）、断线指数退避重连、重连成功后失效
 * 聊天缓存让历史接口补齐（推送不保证不重不漏，契约明确以历史端点为准）。
 */

const PING_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 30_000

type RealtimeState = {
  socket: WebSocket | null
  retry: number
  timer: ReturnType<typeof setTimeout> | null
  pingTimer: ReturnType<typeof setInterval> | null
}

const state: RealtimeState = { socket: null, retry: 0, timer: null, pingTimer: null }

const REALTIME_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${
  window.location.host
}${REALTIME_WS_PATH}`

function stopPing(): void {
  if (state.pingTimer) clearInterval(state.pingTimer)
  state.pingTimer = null
}

function startPing(socket: WebSocket): void {
  stopPing()
  state.pingTimer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ping' }))
    }
  }, PING_INTERVAL_MS)
}

/** 消息进缓存：先落 query 缓存再由 UI 渲染，与「服务端先落库再推送」同构。 */
function handleEvent(event: RealtimeServerEvent): void {
  if (event.type === 'pong') return

  const message: MessageDto = event.message
  queryClient.setQueryData<MessageDto[]>(['chat', 'messages', event.conversationId], (old) => {
    if (!old) return old
    // 推送不保证不重：HTTP 发送成功后本地已插入同 id 消息，按 id 去重。
    if (old.some((item) => item.id === message.id)) return old
    // 历史接口升序返回；推送按服务端顺序到达，直接追加到尾部。
    return [...old, message]
  })
  // 会话列表的 lastMessage / unread / 排序都由服务端字段决定，直接失效重拉。
  void queryClient.invalidateQueries({ queryKey: ['chat', 'conversations'] })
}

function scheduleReconnect(): void {
  if (state.timer) return
  const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** state.retry)
  state.retry += 1
  state.timer = setTimeout(() => {
    state.timer = null
    connect()
  }, delay)
}

function connect(): void {
  if (state.socket && state.socket.readyState <= WebSocket.OPEN) return

  const socket = new WebSocket(REALTIME_URL)
  state.socket = socket

  socket.onopen = () => {
    state.retry = 0
    startPing(socket)
    // 重连恢复（#41 工作项）：离线期间错过的消息以历史接口为准。
    void queryClient.invalidateQueries({ queryKey: ['chat'] })
  }
  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return
    try {
      const parsed: unknown = JSON.parse(event.data)
      const result = realtimeServerEventSchema.safeParse(parsed)
      if (result.success) handleEvent(result.data)
    } catch {
      // 坏帧静默忽略（与服务端「不因坏帧断连」对称）。
    }
  }
  socket.onclose = () => {
    stopPing()
    if (state.socket === socket) state.socket = null
    scheduleReconnect()
  }
  socket.onerror = () => {
    socket.close()
  }
}

function disconnect(): void {
  if (state.timer) clearTimeout(state.timer)
  state.timer = null
  state.retry = 0
  stopPing()
  state.socket?.close()
  state.socket = null
}

/** 登录后建立连接，登出后关闭。重复渲染只保持一条连接。 */
export function useRealtime(enabled: boolean): void {
  useEffect(() => {
    if (enabled) connect()
    else disconnect()
  }, [enabled])
}
