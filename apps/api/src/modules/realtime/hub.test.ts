import { describe, expect, test } from 'bun:test'
import { createConnectionHub, type WsSender } from './hub'

class FakeSocket implements WsSender {
  frames: string[] = []
  send(data: string) {
    this.frames.push(data)
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
})
