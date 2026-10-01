import { describe, expect, test } from 'bun:test'
import type { UserPresence } from '@fish/contracts/users/schema'
import { createPresenceRegistry } from './presence'

/**
 * 在线态登记表（#359 第五点）的判据：活动 + TTL。
 *
 * 时钟注入让「TTL 到期」成为可确定复现的事件，不需要真的等 60 秒。
 */
function clock(start = 1_700_000_000_000) {
  let current = start
  return {
    now: () => current,
    advance(ms: number) {
      current += ms
    },
  }
}

const TTL = 60_000

describe('presenceOf —— 在线判定', () => {
  test('从未活动过：离线，且 lastActiveAt 为 null（不编造「最后活跃」）', () => {
    const registry = createPresenceRegistry({ ttlMs: TTL, now: clock().now })
    expect(registry.presenceOf('u1')).toEqual({ online: false, lastActiveAt: null })
  })

  test('活动后在线；TTL 边界上是「还在线」，越过即离线', () => {
    const time = clock()
    const registry = createPresenceRegistry({ ttlMs: TTL, now: time.now })
    registry.touch('u1')

    expect(registry.presenceOf('u1').online).toBe(true)

    time.advance(TTL - 1)
    expect(registry.presenceOf('u1').online).toBe(true)

    time.advance(1)
    expect(registry.presenceOf('u1').online).toBe(false)
  })

  test('离线后 lastActiveAt 保留最后一次活动时刻（客户端据此算「多久没上线」）', () => {
    const time = clock()
    const registry = createPresenceRegistry({ ttlMs: TTL, now: time.now })
    registry.touch('u1')
    time.advance(TTL + 5_000)

    const presence = registry.presenceOf('u1')
    expect(presence.online).toBe(false)
    expect(presence.lastActiveAt).toBe(new Date(1_700_000_000_000).toISOString())
  })

  test('再次活动把时刻推进（离线→在线的判据看的是新时刻）', () => {
    const time = clock()
    const registry = createPresenceRegistry({ ttlMs: TTL, now: time.now })
    registry.touch('u1')
    time.advance(TTL + 1)
    registry.touch('u1')

    expect(registry.presenceOf('u1').online).toBe(true)
    expect(registry.presenceOf('u1').lastActiveAt).toBe(
      new Date(1_700_000_000_000 + TTL + 1).toISOString(),
    )
  })
})

describe('touch —— 只在离线→在线时回调一次', () => {
  test('第一次活动回调一次；窗口内继续活动不重复回调', () => {
    const time = clock()
    const seen: { userId: string; presence: UserPresence }[] = []
    const registry = createPresenceRegistry({
      ttlMs: TTL,
      now: time.now,
      onChange: (userId, presence) => seen.push({ userId, presence }),
    })

    registry.touch('u1')
    expect(seen).toEqual([
      {
        userId: 'u1',
        presence: { online: true, lastActiveAt: new Date(1_700_000_000_000).toISOString() },
      },
    ])

    time.advance(1_000)
    registry.touch('u1')
    registry.touch('u1')
    expect(seen).toHaveLength(1)
  })

  test('TTL 过期后再次活动：再回调一次（这就是「变在线」的推送来源）', () => {
    const time = clock()
    const seen: string[] = []
    const registry = createPresenceRegistry({
      ttlMs: TTL,
      now: time.now,
      onChange: (userId) => seen.push(userId),
    })

    registry.touch('u1')
    time.advance(TTL + 1)
    registry.touch('u1')
    expect(seen).toEqual(['u1', 'u1'])
  })

  test('不同用户互不影响', () => {
    const seen: string[] = []
    const registry = createPresenceRegistry({
      ttlMs: TTL,
      now: clock().now,
      onChange: (userId) => seen.push(userId),
    })
    registry.touch('u1')
    registry.touch('u2')
    registry.touch('u1')
    expect(seen).toEqual(['u1', 'u2'])
    expect(registry.trackedCount()).toBe(2)
  })
})
