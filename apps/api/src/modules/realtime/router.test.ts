import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { createConnectionHub } from './hub'
import { createRealtimeRouter } from './router'

/**
 * 起真实 Bun.serve 的端到端 WS 测试：upgradeWebSocket 与 Bun.serve 的 websocket
 * 处理器必须来自同一 createBunWebSocket 实例（生产环境由 apps/api/src/ws.ts 保证，
 * 测试里用独立实例避免与全局配对冲突）。
 */
async function startServer(resolveUserId: (req: Request) => Promise<string | null>) {
  const { upgradeWebSocket, websocket } = createBunWebSocket()
  const hub = createConnectionHub()

  const app = new Hono<{ Variables: { userId: string } }>()
  app.get(
    '/ws/chat',
    createRealtimeRouter({
      hub,
      resolveUserId: (c) => resolveUserId(c.req.raw),
      upgradeWebSocket: upgradeWebSocket as never,
    }),
  )

  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    websocket: websocket as never,
  })
  return { server, hub, url: `ws://localhost:${server.port}/ws/chat` }
}

describe('realtime router (integration)', () => {
  test('unauthenticated upgrade is rejected with HTTP 401 before the connection opens', async () => {
    const { server, url } = await startServer(async () => null)
    try {
      const ws = new WebSocket(url)
      const outcome = await new Promise<'error' | 'open'>((resolve) => {
        ws.onerror = () => resolve('error')
        ws.onopen = () => resolve('open')
      })
      expect(outcome).toBe('error') // 契约语义②：不会出现"连上后再收错误帧"
    } finally {
      server.stop(true)
    }
  })

  test('authenticated client gets pong for ping; hub push reaches both participants', async () => {
    const { server, hub, url } = await startServer(async (req) => {
      return req.headers.get('x-test-user')
    })
    try {
      const alice = new WebSocket(url, { headers: { 'x-test-user': 'alice' } } as never)
      await new Promise<void>((resolve, reject) => {
        alice.onopen = () => resolve()
        alice.onerror = reject
      })
      expect(hub.connectionCount()).toBe(1)

      alice.send(JSON.stringify({ type: 'ping' }))
      const pong = await new Promise<string>((resolve, reject) => {
        alice.onmessage = (event) => resolve(String(event.data))
        setTimeout(() => reject(new Error('pong timeout')), 2000)
      })
      expect(JSON.parse(pong)).toEqual({ type: 'pong' })

      // bob 也在另一个连接上；消息服务推送（hub.pushToUsers）双方都能收到
      const bob = new WebSocket(url, { headers: { 'x-test-user': 'bob' } } as never)
      await new Promise<void>((resolve, reject) => {
        bob.onopen = () => resolve()
        bob.onerror = reject
      })

      const aliceGot = new Promise<string>((resolve) => {
        alice.onmessage = (event) => resolve(String(event.data))
      })
      const bobGot = new Promise<string>((resolve) => {
        bob.onmessage = (event) => resolve(String(event.data))
      })
      hub.pushToUsers(['alice', 'bob'], {
        type: 'message.new',
        conversationId: 'conv-1',
        message: {
          id: '00000000-0000-4000-8000-0000000000d1',
          conversationId: 'conv-1',
          senderId: null,
          sender: null,
          type: 'SYSTEM',
          content: 'hi',
          createdAt: '2026-09-12T10:00:00.000Z',
        },
      })
      expect(JSON.parse(await aliceGot).type).toBe('message.new')
      expect(JSON.parse(await bobGot).type).toBe('message.new')

      alice.close()
      bob.close()
    } finally {
      server.stop(true)
    }
  })

  test('unknown client frames are silently ignored (connection stays open)', async () => {
    const { server, url } = await startServer(async (req) => req.headers.get('x-test-user'))
    try {
      const ws = new WebSocket(url, { headers: { 'x-test-user': 'alice' } } as never)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = reject
      })

      ws.send('not-json')
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'conv-1' }))

      // 连接仍然活着：ping 还能拿到 pong
      ws.send(JSON.stringify({ type: 'ping' }))
      const pong = await new Promise<string>((resolve, reject) => {
        ws.onmessage = (event) => resolve(String(event.data))
        setTimeout(() => reject(new Error('pong timeout')), 2000)
      })
      expect(JSON.parse(pong)).toEqual({ type: 'pong' })
      ws.close()
    } finally {
      server.stop(true)
    }
  })
})
