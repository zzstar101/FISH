import { describe, expect, mock, test } from 'bun:test'
import type { MediaRealtimeEvent, RealtimeServerEvent } from '@fish/contracts/chat/schema'
import type {
  ChatRealtimeEvent,
  RealtimeSocket,
  RealtimeTimers,
} from '../src/features/chat/realtime'

/**
 * 会话实时通道客户端（`features/chat/realtime`）。
 *
 * 手法与 `chat-media-api.test.ts` 一致：`mock.module` 掉平台依赖（Taro / 会话 cookie）
 * 之后再 `await import` 被测模块；socket 与定时器全部注入假件，驱动「建链 → 心跳 →
 * pong 超时 → 断线退避重连」的完整时序，不依赖网络。被测的类本身不 import Taro
 * 之外的任何运行时（默认工厂除外，测试不经过它）。
 */

mock.module('@tarojs/taro', () => ({ default: {} }))
mock.module('@/lib/session', () => ({ sessionCookieHeader: () => 'fish_session=test' }))

const { ChatRealtime, parseRealtimeEvent, realtimeUrl, reconnectDelay } = await import(
  '../src/features/chat/realtime'
)

/** 按 Taro `SocketTask` 的注册式回调形状做的假 socket */
class FakeSocket implements RealtimeSocket {
  private readonly openHandlers: (() => void)[] = []
  private readonly messageHandlers: ((data: unknown) => void)[] = []
  private readonly closeHandlers: (() => void)[] = []
  private readonly errorHandlers: (() => void)[] = []
  readonly sent: string[] = []
  closed = false

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    for (const handler of this.closeHandlers) handler()
  }

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler)
  }

  onMessage(handler: (data: unknown) => void): void {
    this.messageHandlers.push(handler)
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler)
  }

  onError(handler: () => void): void {
    this.errorHandlers.push(handler)
  }

  open(): void {
    for (const handler of this.openHandlers) handler()
  }

  message(data: unknown): void {
    for (const handler of this.messageHandlers) handler(data)
  }

  fail(): void {
    for (const handler of this.errorHandlers) handler()
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
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
} satisfies RealtimeServerEvent

/** #67 媒体事件是独立 schema，不并入 realtimeServerEventSchema。 */
const validMediaEvent = {
  type: 'media.new',
  conversationId: 'cnv_01jc000000e00800000000001a',
  media: {
    id: 'msg_01jc000000e00800000000001s',
    conversationId: 'cnv_01jc000000e00800000000001a',
    senderId: 'usr_01jc000000e00800000000000b',
    kind: 'IMAGE',
    mediaId: 'med_01jc000000e00800000000002b',
    url: '/api/conversations/cnv_01jc000000e00800000000001a/media/med_01jc000000e00800000000002b',
    mimeType: 'image/png',
    sizeBytes: 2_048,
    width: 800,
    height: 600,
    durationMs: null,
    recalledAt: null,
    replyTo: null,
    createdAt: '2026-01-01T00:00:01.000Z',
  },
} satisfies MediaRealtimeEvent

describe('realtimeUrl —— 从 API 基地址推导 WS 地址', () => {
  test('http → ws、https → wss，路径用契约常量，不加 /api 前缀', () => {
    expect(realtimeUrl('http://localhost:3000')).toBe('ws://localhost:3000/ws/chat')
    expect(realtimeUrl('https://api.example.com')).toBe('wss://api.example.com/ws/chat')
  })

  test('基地址带尾斜杠时归一，不拼出 //ws/chat', () => {
    expect(realtimeUrl('http://localhost:3000/')).toBe('ws://localhost:3000/ws/chat')
    expect(realtimeUrl('https://api.example.com///')).toBe('wss://api.example.com/ws/chat')
  })
})

describe('realtime 帧解析', () => {
  test('契约事件放行，畸形帧丢弃', () => {
    expect(parseRealtimeEvent(JSON.stringify({ type: 'pong' }))).toEqual({ type: 'pong' })
    expect(parseRealtimeEvent(JSON.stringify(validMessageEvent))).toEqual(validMessageEvent)
    expect(parseRealtimeEvent('not-json')).toBeNull()
    expect(parseRealtimeEvent(JSON.stringify({ type: 'unknown' }))).toBeNull()
    expect(parseRealtimeEvent(new ArrayBuffer(0))).toBeNull()
  })

  test('独立的 media.new 要能解析，不能被旧版 schema 挡掉', () => {
    expect(parseRealtimeEvent(JSON.stringify(validMediaEvent))).toEqual(validMediaEvent)
    // 形状不合契约的媒体帧丢弃，不把半截 DTO 塞进消息流
    expect(
      parseRealtimeEvent(
        JSON.stringify({ ...validMediaEvent, media: { ...validMediaEvent.media, kind: 'FILE' } }),
      ),
    ).toBeNull()
  })
})

describe('reconnectDelay —— 封顶指数退避 + 抖动', () => {
  test('与 web-pc 同一套口径', () => {
    const random = () => 1
    expect(reconnectDelay(0, { baseMs: 1_000, maxMs: 30_000, random })).toBe(1_000)
    expect(reconnectDelay(3, { baseMs: 1_000, maxMs: 30_000, random })).toBe(8_000)
    expect(reconnectDelay(10, { baseMs: 1_000, maxMs: 30_000, random })).toBe(30_000)
    expect(reconnectDelay(0, { baseMs: 1_000, maxMs: 30_000, random: () => 0.5 })).toBe(750)
  })
})

describe('ChatRealtime —— 连接 / 事件 / 心跳 / 重连', () => {
  /**
   * 假定时器：`clearTimeout` 真的把条目标成失效、触发过的也标成已用（真定时器就是这个
   * 语义）。建链超时（`connectTimeoutMs`）会在每次 `connect()` 开头排一个、心跳每跳也
   * 排一个 pong 超时，若只记不摘，「还剩几个待触发」的断言就会被这些已结束的条目带偏。
   */
  const makeTimers = () => {
    const entries: Array<{ handler: () => void; timeout: number; done: boolean }> = []
    const intervals: Array<{ handler: () => void }> = []
    const cleared: unknown[] = []
    const timers: RealtimeTimers = {
      setTimeout: (handler, timeout) => {
        entries.push({ handler, timeout, done: false })
        return entries.length
      },
      clearTimeout: (handle) => {
        cleared.push(handle)
        if (typeof handle !== 'number') return
        const entry = entries[handle - 1]
        if (entry) entry.done = true
      },
      setInterval: (handler) => {
        intervals.push({ handler })
        return intervals.length
      },
      clearInterval: (handle) => cleared.push(handle),
    }
    /** 还没触发、也没被取消的定时器（触发过的会自动出列） */
    const pending = () =>
      entries
        .filter((entry) => !entry.done)
        .map((entry) => ({
          timeout: entry.timeout,
          handler: () => {
            entry.done = true
            entry.handler()
          },
        }))
    return { timers, pending, intervals, cleared }
  }

  /** 建链是异步的（Taro.connectSocket 返回 Promise）：把微任务冲刷掉再断言 */
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  test('建链带上 cookie，事件转发，pong 与坏帧不打扰调用方，stop 干净收场', async () => {
    const sockets: FakeSocket[] = []
    const factories: Array<{ url: string; cookie: string | undefined }> = []
    const events: ChatRealtimeEvent[] = []
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: (url, cookie) => {
        factories.push({ url, cookie })
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      },
      getCookie: () => 'fish_session=abc',
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    })

    realtime.start()
    await flush()
    expect(factories).toEqual([{ url: 'ws://test/ws/chat', cookie: 'fish_session=abc' }])
    expect(sockets).toHaveLength(1)

    sockets[0]?.open()
    sockets[0]?.message(JSON.stringify({ type: 'pong' }))
    sockets[0]?.message('not-json')
    expect(events).toEqual([])

    sockets[0]?.message(JSON.stringify(validMessageEvent))
    sockets[0]?.message(JSON.stringify(validMediaEvent))
    expect(events).toEqual([validMessageEvent, validMediaEvent])

    realtime.stop()
    expect(sockets[0]?.closed).toBe(true)

    // stop 之后迟到的帧不再进调用方
    sockets[0]?.message(JSON.stringify(validMessageEvent))
    expect(events).toEqual([validMessageEvent, validMediaEvent])
  })

  test('重复 start() 不建第二条连接：建链在飞与已连上两条路径都挡住', async () => {
    const sockets: FakeSocket[] = []
    let factoryCalls = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        factoryCalls += 1
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      },
      onEvent: () => {},
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    })

    // 建链在飞（connectSocket 的 Promise 还没 settle）时再 start()：挡板必须挡住
    realtime.start()
    realtime.start()
    await flush()
    expect(factoryCalls).toBe(1)

    // 已连上之后再 start() 也不该建新链
    sockets[0]?.open()
    realtime.start()
    await flush()
    expect(factoryCalls).toBe(1)
    expect(sockets).toHaveLength(1)

    realtime.stop()
    expect(sockets[0]?.closed).toBe(true)
  })

  test('断开后按退避重连，重连时重读 cookie；stop 取消在途的重连', async () => {
    const { timers, pending } = makeTimers()
    const sockets: FakeSocket[] = []
    const cookies: Array<string | undefined> = []
    const cookiesGiven = ['fish_session=first', 'fish_session=second']
    let cookieCalls = 0
    let opens = 0
    let disconnects = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: (_url, cookie) => {
        cookies.push(cookie)
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      },
      // getCookie 在每次建链前调用（先于工厂）：第一次给 first，第二次给 second
      getCookie: () => {
        const value = cookiesGiven[Math.min(cookieCalls, cookiesGiven.length - 1)]
        cookieCalls += 1
        return value
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
    await flush()
    sockets[0]?.open()
    expect(opens).toBe(1)

    sockets[0]?.close()
    expect(disconnects).toBe(1)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    pending()[0]?.handler()
    await flush()
    expect(sockets).toHaveLength(2)
    // 重连是重新建链：cookie 重读（拿到第二份）
    expect(cookies[1]).toBe('fish_session=second')
    sockets[1]?.open()
    expect(opens).toBe(2)

    sockets[1]?.close()
    // 先拿住在途的重连，再 stop：stop 之后那个 handler 不许再建链
    const inFlight = pending()[0]
    realtime.stop()
    expect(pending()).toHaveLength(0)
    inFlight?.handler()
    await flush()
    expect(sockets).toHaveLength(2)
    expect(disconnects).toBe(2)
  })

  test('建链失败（网络不通 / 401 拒绝）与断开同一处理：退避重连', async () => {
    const { timers, pending } = makeTimers()
    let attempts = 0
    let disconnects = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        attempts += 1
        return Promise.reject(new Error('upgrade rejected'))
      },
      onEvent: () => {},
      onDisconnected: () => {
        disconnects += 1
      },
      timers,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
      random: () => 1,
    })

    realtime.start()
    await flush()
    expect(attempts).toBe(1)
    expect(disconnects).toBe(1)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    realtime.stop()
  })

  test('建链 Promise 迟迟不 settle 时按超时处理：不卡死在 connecting，退避重连', async () => {
    const { timers, pending } = makeTimers()
    let disconnects = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      // 永不 settle：模拟平台没让 connectSocket 的 Promise 收口
      createSocket: () => new Promise<never>(() => {}),
      onEvent: () => {},
      onDisconnected: () => {
        disconnects += 1
      },
      timers,
      connectTimeoutMs: 5_000,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
      random: () => 1,
    })

    realtime.start()
    await flush()
    // 建链超时排在待触发表里
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(5_000)

    pending()[0]?.handler()
    expect(disconnects).toBe(1)
    // 超时后按「连不上」处理，排一次退避重连
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    realtime.stop()
    expect(pending()).toHaveLength(0)
  })

  test('心跳：到点发 ping；pong 清掉超时；pong 不到期就断开重连', async () => {
    const { timers, pending, intervals } = makeTimers()
    const sockets: FakeSocket[] = []
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      },
      onEvent: () => {},
      timers,
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 10_000,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
      random: () => 1,
    })

    realtime.start()
    await flush()
    expect(intervals).toHaveLength(0)
    sockets[0]?.open()
    expect(intervals).toHaveLength(1)

    const tick = intervals[0]?.handler
    // 第一跳：发出 ping，排定 pong 超时
    tick?.()
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: 'ping' })])
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(10_000)

    // pong 到了：超时被清，下一跳继续发 ping
    sockets[0]?.message(JSON.stringify({ type: 'pong' }))
    tick?.()
    expect(sockets[0]?.sent).toEqual([
      JSON.stringify({ type: 'ping' }),
      JSON.stringify({ type: 'ping' }),
    ])
    expect(pending()).toHaveLength(1)

    // pong 不到：超时触发 close → 断开重连
    pending()[0]?.handler()
    expect(sockets[0]?.closed).toBe(true)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    realtime.stop()
  })

  test('心跳 send 抛错时不当成致命：等下一跳（异常不冒泡）', async () => {
    const { timers, intervals } = makeTimers()
    const sockets: FakeSocket[] = []
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      },
      onEvent: () => {},
      timers,
      heartbeatIntervalMs: 20_000,
      heartbeatTimeoutMs: 10_000,
    })

    realtime.start()
    await flush()
    sockets[0]?.open()
    const broken = sockets[0]
    if (broken !== undefined) {
      broken.send = () => {
        throw new Error('socket closing')
      }
    }
    expect(() => intervals[0]?.handler()).not.toThrow()

    // 后续换回正常 send：连接没被这次异常弄死，照常发心跳
    if (broken !== undefined) broken.send = FakeSocket.prototype.send.bind(broken)
    intervals[0]?.handler()
    expect(broken?.sent).toEqual([JSON.stringify({ type: 'ping' })])

    realtime.stop()
  })

  test('建链超时后才 resolve 的旧 Promise 就地作废：立即 close、不 attach，只留重连那条', async () => {
    const { timers, pending, intervals } = makeTimers()
    const sockets: FakeSocket[] = []
    /** 手动控制 settle：模拟「超时先到、Promise 迟到才 resolve」 */
    const settle: Array<(socket: FakeSocket) => void> = []
    let opens = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () =>
        new Promise<FakeSocket>((resolve) => {
          const socket = new FakeSocket()
          sockets.push(socket)
          settle.push(resolve)
        }),
      onEvent: () => {},
      onOpen: () => {
        opens += 1
      },
      timers,
      connectTimeoutMs: 5_000,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
      random: () => 1,
    })

    realtime.start()
    await flush()
    const first = sockets[0]
    if (first === undefined) throw new Error('第一次建链没有发生')

    // 超时先到：这一代作废，排一次退避重连
    pending()[0]?.handler()
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    // 旧 Promise 赶在重连 timer 之前 resolve：必须立即关掉，不许 attach
    settle[0]?.(first)
    await flush()
    expect(first.closed).toBe(true)
    // 没 attach 过：open 不进任何回调路径，也不排心跳
    first.open()
    expect(opens).toBe(0)
    expect(intervals).toHaveLength(0)

    // 重连到点：只建这一条并正常接线
    pending()[0]?.handler()
    await flush()
    // 超时那一代不许再建第二条：整个场景只该有「迟到的」与「重连的」两条
    expect(sockets).toHaveLength(2)
    const second = sockets[1]
    if (second === undefined) throw new Error('重连没有建链')
    settle[1]?.(second)
    await flush()
    second.open()
    expect(opens).toBe(1)
    expect(intervals).toHaveLength(1)
    expect(second.closed).toBe(false)

    realtime.stop()
  })

  test('建链超时后才 reject 的旧 Promise 不重复报断开、不重复排重连', async () => {
    const { timers, pending } = makeTimers()
    const rejectors: Array<(error: Error) => void> = []
    let disconnects = 0
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () =>
        new Promise<RealtimeSocket>((_resolve, reject) => {
          rejectors.push(reject)
        }),
      onEvent: () => {},
      onDisconnected: () => {
        disconnects += 1
      },
      timers,
      connectTimeoutMs: 5_000,
      reconnectBaseDelayMs: 100,
      reconnectMaxDelayMs: 10_000,
      random: () => 1,
    })

    realtime.start()
    await flush()
    // 超时先到：报一次断开，排一次退避重连
    pending()[0]?.handler()
    expect(disconnects).toBe(1)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    // 旧 Promise 迟到 reject：这一代已作废，不许再走一遍 catch 分支
    rejectors[0]?.(new Error('upgrade rejected'))
    await flush()
    expect(disconnects).toBe(1)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]?.timeout).toBe(100)

    realtime.stop()
  })

  test('stop 与新一轮建链之间的迟到建链结果被作废，不接线不重复', async () => {
    const sockets: FakeSocket[] = []
    const realtime = new ChatRealtime({
      url: 'ws://test/ws/chat',
      createSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return Promise.resolve(socket)
      },
      onEvent: () => {},
    })

    realtime.start()
    realtime.stop()
    await flush()
    // 迟到的建链结果就地关掉，不产生任何可用的连接
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.closed).toBe(true)
    // open 也不该触发任何回调路径（没有 attach 过）
    expect(() => sockets[0]?.open()).not.toThrow()
  })
})
