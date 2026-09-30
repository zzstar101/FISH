import { describe, expect, test } from 'bun:test'
import type { RealtimeServerEvent } from '@fish/contracts/chat/schema'
import {
  ChatRealtime,
  type ChatRealtimeStatus,
  parseRealtimeEvent,
  type RealtimeSocket,
  type RealtimeTimers,
  reconnectDelay,
} from './realtime'

class FakeSocket implements RealtimeSocket {
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly sent: string[] = []
  closed = false

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.onclose?.({})
  }

  open(): void {
    this.onopen?.({})
  }

  message(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const validMessageEvent = {
  type: 'message.new',
  conversationId: 'cnv_01jc000000e00800000000001a',
  message: {
    id: 'msg_01jc000000e00800000000001t',
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: 'usr_01jc000000e00800000000000b',
    sender: { id: 'usr_01jc000000e00800000000000b', nickname: '小林', avatarUrl: null },
    type: 'TEXT',
    content: '在吗',
    listing: null,
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
} satisfies RealtimeServerEvent

describe('realtime frame parsing', () => {
  test('accepts contract events and ignores malformed frames', () => {
    expect(parseRealtimeEvent(JSON.stringify({ type: 'pong' }))).toEqual({ type: 'pong' })
    expect(parseRealtimeEvent(JSON.stringify(validMessageEvent))).toEqual(validMessageEvent)
    expect(parseRealtimeEvent('not-json')).toBeNull()
    expect(parseRealtimeEvent(JSON.stringify({ type: 'unknown' }))).toBeNull()
    expect(parseRealtimeEvent(new ArrayBuffer(0))).toBeNull()
  })
})

describe('reconnectDelay', () => {
  test('uses capped exponential backoff with jitter', () => {
    const random = () => 1
    expect(reconnectDelay(0, { baseMs: 1_000, maxMs: 30_000, random })).toBe(1_000)
    expect(reconnectDelay(3, { baseMs: 1_000, maxMs: 30_000, random })).toBe(8_000)
    expect(reconnectDelay(10, { baseMs: 1_000, maxMs: 30_000, random })).toBe(30_000)
    expect(
      reconnectDelay(0, {
        baseMs: 1_000,
        maxMs: 30_000,
        random: () => 0.5,
      }),
    ).toBe(750)
  })
})

describe('ChatRealtime', () => {
  test('forwards parsed events, ignores pong/invalid frames, and stops cleanly', () => {
    const sockets: FakeSocket[] = []
    const events: RealtimeServerEvent[] = []
    const statuses: ChatRealtimeStatus[] = []
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: (event) => events.push(event),
      onStatusChange: (status) => statuses.push(status),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    })

    realtime.start()
    expect(sockets).toHaveLength(1)
    expect(statuses).toEqual(['connecting'])

    sockets[0]?.open()
    expect(statuses).toEqual(['connecting', 'open'])

    sockets[0]?.message(JSON.stringify({ type: 'pong' }))
    sockets[0]?.message('not-json')
    expect(events).toEqual([])

    sockets[0]?.message(JSON.stringify(validMessageEvent))
    expect(events).toEqual([validMessageEvent])

    realtime.stop()
    expect(sockets[0]?.closed).toBe(true)
    expect(statuses.at(-1)).toBe('closed')

    sockets[0]?.message(JSON.stringify(validMessageEvent))
    expect(events).toEqual([validMessageEvent])
  })

  test('reconnects after a close with the injected timer', () => {
    const scheduled: Array<{ handler: () => void; timeout: number }> = []
    const timers: RealtimeTimers = {
      setTimeout: (handler, timeout) => {
        scheduled.push({ handler, timeout })
        return scheduled.length
      },
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    }
    const sockets: FakeSocket[] = []
    let opens = 0
    let disconnects = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      onEvent: () => {},
      onOpen: () => {
        opens += 1
      },
      onDisconnected: () => {
        disconnects += 1
      },
      timers,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
      random: () => 1,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    })

    realtime.start()
    sockets[0]?.open()
    expect(opens).toBe(1)

    sockets[0]?.close()
    expect(disconnects).toBe(1)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.timeout).toBe(100)

    scheduled[0]?.handler()
    expect(sockets).toHaveLength(2)
    sockets[1]?.open()
    expect(opens).toBe(2)

    realtime.stop()
    expect(disconnects).toBe(1)
  })
})
