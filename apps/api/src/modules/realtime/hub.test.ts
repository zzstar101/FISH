import { describe, expect, test } from 'bun:test'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createConnectionHub, type WsSender } from './hub'

class FakeSocket implements WsSender {
  frames: string[] = []
  send(data: string) {
    this.frames.push(data)
  }
}

/** 带 `close()` 的假连接：#464 的 `closeUser` 要断言「真的调了 close」。 */
class ClosableSocket extends FakeSocket {
  closed = false
  close() {
    this.closed = true
  }
}

describe('connection hub', () => {
  test('pushes to all connections of all target users', () => {
    const hub = createConnectionHub()
    const aliceA = new FakeSocket()
    const aliceB = new FakeSocket()
    const bob = new FakeSocket()
    hub.attach('alice', aliceA)
    hub.attach('alice', aliceB)
    hub.attach('bob', bob)
    expect(hub.connectionCount()).toBe(3)

    hub.pushToUsers(['alice', 'bob'], {
      type: 'message.new',
      conversationId: encodePublicId(
        PUBLIC_ID_PREFIX.conversation,
        '01930000-0000-7000-8000-0000000000c1',
      ),
      message: {
        id: encodePublicId(PUBLIC_ID_PREFIX.message, '01930000-0000-7000-8000-0000000000d1'),
        conversationId: encodePublicId(
          PUBLIC_ID_PREFIX.conversation,
          '01930000-0000-7000-8000-0000000000c1',
        ),
        senderId: null,
        sender: null,
        type: 'SYSTEM',
        content: 'hi',
        recalledAt: null,
        replyTo: null,
        createdAt: '2026-09-12T10:00:00.000Z',
      },
    })

    // 同一用户的多个连接（多设备/多标签页）全部收到
    expect(aliceA.frames).toHaveLength(1)
    expect(aliceB.frames).toHaveLength(1)
    expect(bob.frames).toHaveLength(1)
    expect(JSON.parse(aliceA.frames[0] ?? '{}')).toMatchObject({ type: 'message.new' })
  })

  test('detach stops further delivery and re-attach works', () => {
    const hub = createConnectionHub()
    const socket = new FakeSocket()
    const detach = hub.attach('alice', socket)
    detach()
    expect(hub.connectionCount()).toBe(0)

    hub.attach('alice', socket)
    hub.pushToUsers(['alice'], { type: 'pong' })
    expect(socket.frames).toHaveLength(1)
  })

  test('a throwing sender does not break delivery to other recipients', () => {
    const hub = createConnectionHub()
    const broken = new FakeSocket()
    broken.send = () => {
      throw new Error('socket gone')
    }
    const healthy = new FakeSocket()
    hub.attach('alice', broken)
    hub.attach('bob', healthy)

    hub.pushToUsers(['alice', 'bob'], { type: 'pong' })
    expect(healthy.frames).toHaveLength(1)
  })

  test('events are serialized through the contract schema (violations throw)', () => {
    const hub = createConnectionHub()
    const socket = new FakeSocket()
    hub.attach('alice', socket)

    expect(() => hub.pushToUsers(['alice'], { type: 'message.new' } as never)).toThrow()
    expect(socket.frames).toHaveLength(0) // 违规事件不出服务端
  })

  // #464：申请注销后服务端要主动断开该用户的全部连接（含当前设备）。
  test('closeUser 断开该用户的全部连接，不影响别人，并回报断开的条数', () => {
    const hub = createConnectionHub()
    const aliceA = new ClosableSocket()
    const aliceB = new ClosableSocket()
    const bob = new ClosableSocket()
    hub.attach('alice', aliceA)
    hub.attach('alice', aliceB)
    hub.attach('bob', bob)

    expect(hub.closeUser('alice')).toBe(2)
    expect(aliceA.closed).toBe(true)
    expect(aliceB.closed).toBe(true)
    expect(bob.closed).toBe(false)
    // 没有连接的用户（或重复调用）是幂等的 0，不是抛错。
    expect(hub.closeUser('alice')).toBe(0)
    expect(hub.connectionCount()).toBe(1)
  })

  test('closeUser 之后重连：旧连接的 onClose 不会把新连接从登记里摘掉', () => {
    const hub = createConnectionHub()
    const first = new ClosableSocket()
    const detachFirst = hub.attach('alice', first)
    hub.closeUser('alice')

    const second = new ClosableSocket()
    hub.attach('alice', second)
    // 真实 WS 场景：closeUser 触发的关闭回调晚于重连到达。没有身份判断时这里会把
    // 新连接的 Set 一起摘掉，之后 alice 再也收不到推送（且不报错）。
    detachFirst()

    hub.pushToUsers(['alice'], { type: 'pong' })
    expect(second.frames).toHaveLength(1)
  })
})
