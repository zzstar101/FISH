import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 小程序实时客户端（#67 第三步）的行为判据。
 *
 * 为什么要 mock `@tarojs/taro`：Bun 下加载真 Taro 会抛 `ENABLE_INNER_HTML is not defined`
 * （同 `signature.test.ts` 的说明）。这里用它顶替 `connectSocket` / `onAppShow`，
 * 换成一个可手工触发 open / message / close 的假 SocketTask，从而把三条**验收点**锁住：
 *
 * 1. 握手带上当前会话 cookie 且路径是契约的 WS 端点（小程序没有 cookie jar，
 *    不带就是一条永远 401 的连接）；
 * 2. **切号不接收旧账号事件**：换身份时旧连接被关掉、它的迟到帧与 close 回调
 *    都随 `generation` 失效（否则旧账号的消息会推进新账号的界面，且旧连接会一直重连）；
 * 3. 断线后按退避重连、回到前台立刻补连。
 */

type ConnectOption = { url: string; header?: Record<string, string> }

class FakeSocket {
  sent: string[] = []
  closed = false
  private openHandlers: Array<() => void> = []
  private messageHandlers: Array<(event: { data: unknown }) => void> = []
  private closeHandlers: Array<() => void> = []
  private errorHandlers: Array<() => void> = []

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler)
  }

  onMessage(handler: (event: { data: unknown }) => void): void {
    this.messageHandlers.push(handler)
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler)
  }

  onError(handler: () => void): void {
    this.errorHandlers.push(handler)
  }

  send(option: { data: string }): void {
    this.sent.push(option.data)
  }

  close(_option?: unknown): void {
    this.closed = true
  }

  emitOpen(): void {
    for (const handler of this.openHandlers) handler()
  }

  emitMessage(data: unknown): void {
    for (const handler of this.messageHandlers) handler({ data })
  }

  emitClose(): void {
    for (const handler of this.closeHandlers) handler()
  }

  emitError(): void {
    for (const handler of this.errorHandlers) handler()
  }
}

const sockets: FakeSocket[] = []
const connectCalls: ConnectOption[] = []
let cookie: string | undefined = 'fish_session=test-session'

mock.module('@tarojs/taro', () => ({
  default: {
    // 真实现的类型是 `Promise<SocketTask>`，而有的平台同步返回 task；
    // 这里故意返回**同步**的 task，顺带证明调用处的 `await` 对两种形态都成立。
    connectSocket: (option: ConnectOption) => {
      connectCalls.push(option)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    onAppShow: () => undefined,
    offAppShow: () => undefined,
  },
}))

mock.module('@/lib/session', () => ({
  sessionCookieHeader: () => cookie,
}))

const {
  connectRealtime,
  disconnectRealtime,
  realtimeIdentity,
  subscribeRealtime,
  subscribeReconnect,
} = await import('../src/features/chat/realtime')

/** 建连是 `await` 出来的，等一个宏任务让 socket 挂上去 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const ALAN = 'user-alan'
const LIN = 'user-lin'

beforeEach(() => {
  sockets.length = 0
  connectCalls.length = 0
  cookie = 'fish_session=test-session'
  disconnectRealtime()
})

afterEach(() => {
  // 清掉心跳定时器，别让 25s 的 interval 拖住测试进程
  disconnectRealtime()
})

describe('connectRealtime —— 握手', () => {
  test('用当前会话 cookie 连契约的 WS 端点', async () => {
    connectRealtime(ALAN)
    await flush()

    expect(connectCalls).toHaveLength(1)
    expect(connectCalls[0]?.url).toBe('ws://localhost:3000/ws/chat')
    // 小程序不自动带 cookie：没这个头，服务端在 upgrade 前就会 401
    expect(connectCalls[0]?.header).toEqual({ Cookie: 'fish_session=test-session' })
    expect(realtimeIdentity()).toBe(ALAN)
  })

  test('本地没有会话时根本不建连', async () => {
    cookie = undefined

    connectRealtime(ALAN)
    await flush()

    expect(connectCalls).toHaveLength(0)
  })

  test('同一 tick 内的重复调用只开一条连接（useEffect 与 onAppShow 会同时触发）', async () => {
    connectRealtime(ALAN)
    connectRealtime(ALAN)
    await flush()

    expect(connectCalls).toHaveLength(1)
  })

  test('已连上后重复调用是空转（回前台补连不会开出第二条）', async () => {
    connectRealtime(ALAN)
    await flush()
    sockets[0]?.emitOpen()

    connectRealtime(ALAN)
    await flush()

    expect(connectCalls).toHaveLength(1)
  })
})

describe('事件派发', () => {
  test('建连成功派发一次重连信号（订阅方据此补齐断档）', async () => {
    let reconnects = 0
    const unsubscribe = subscribeReconnect(() => {
      reconnects += 1
    })

    connectRealtime(ALAN)
    await flush()
    sockets[0]?.emitOpen()

    expect(reconnects).toBe(1)
    unsubscribe()
  })

  test('契约内的帧按原样派发，pong 与 conversation.read 也在内（收窄是订阅方的事）', async () => {
    const events: string[] = []
    const unsubscribe = subscribeRealtime((event) => events.push(event.type))

    connectRealtime(ALAN)
    await flush()
    const socket = sockets[0]
    socket?.emitOpen()
    socket?.emitMessage(JSON.stringify({ type: 'pong' }))
    socket?.emitMessage(
      JSON.stringify({
        type: 'message.new',
        conversationId: 'conversation-1',
        message: {
          id: 'message-1',
          conversationId: 'conversation-1',
          senderId: LIN,
          sender: { id: LIN, nickname: '小林', avatarUrl: null },
          type: 'TEXT',
          content: '在吗',
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      }),
    )

    expect(events).toEqual(['pong', 'message.new'])
    unsubscribe()
  })

  test('坏帧与契约外的帧静默忽略（不因坏帧断连）', async () => {
    const events: string[] = []
    const unsubscribe = subscribeRealtime((event) => events.push(event.type))

    connectRealtime(ALAN)
    await flush()
    const socket = sockets[0]
    socket?.emitOpen()
    socket?.emitMessage('{"type":')
    socket?.emitMessage(JSON.stringify({ type: 'something.else' }))
    socket?.emitMessage(JSON.stringify({ type: 'message.new' }))
    socket?.emitMessage(new ArrayBuffer(4))

    expect(events).toEqual([])
    unsubscribe()
  })
})

describe('身份绑定', () => {
  test('换号关掉旧连接，旧连接的迟到帧与 close 都不再起作用', async () => {
    const events: string[] = []
    const unsubscribe = subscribeRealtime((event) => events.push(event.type))

    connectRealtime(ALAN)
    await flush()
    const previous = sockets[0]
    previous?.emitOpen()

    connectRealtime(LIN)
    await flush()

    expect(previous?.closed).toBe(true)
    expect(connectCalls).toHaveLength(2)
    expect(realtimeIdentity()).toBe(LIN)

    // 旧账号连接的帧必须被丢弃：否则 A 的会话消息会落进 B 的界面
    previous?.emitMessage(JSON.stringify({ type: 'pong' }))
    expect(events).toEqual([])

    // 旧连接的 close 也不能排重连：退避首次是 1s，等过去仍应只有两条连接
    previous?.emitClose()
    await Bun.sleep(1_300)
    expect(connectCalls).toHaveLength(2)

    unsubscribe()
  })

  test('退出登录关闭连接，且不再重连', async () => {
    connectRealtime(ALAN)
    await flush()
    const socket = sockets[0]
    socket?.emitOpen()

    disconnectRealtime()

    expect(socket?.closed).toBe(true)
    expect(realtimeIdentity()).toBeNull()

    socket?.emitClose()
    await Bun.sleep(1_300)
    expect(connectCalls).toHaveLength(1)
  })
})

describe('重连与补连', () => {
  test('断线后按退避自动重连', async () => {
    connectRealtime(ALAN)
    await flush()
    sockets[0]?.emitOpen()

    sockets[0]?.emitClose()
    await Bun.sleep(1_200)

    expect(connectCalls).toHaveLength(2)
  })

  test('回到前台立刻补连，不等退避', async () => {
    connectRealtime(ALAN)
    await flush()
    sockets[0]?.emitOpen()
    sockets[0]?.emitClose()

    connectRealtime(ALAN)
    await flush()

    expect(connectCalls).toHaveLength(2)
  })
})
