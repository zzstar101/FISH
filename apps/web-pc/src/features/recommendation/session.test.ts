import { beforeEach, describe, expect, test } from 'bun:test'
import {
  adoptAnonymousSessionId,
  ensureAnonymousSessionId,
  readAnonymousSessionId,
} from './session'

const SESSION_STORAGE_KEY = 'fish.recommendation.sessionId'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function createStorage() {
  const entries = new Map<string, string>()
  return {
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value)
    },
  }
}

const localStorageStub = createStorage()
// 会话只依赖 `window.localStorage`；给一个最小 window 即可，不必拉起完整 DOM。
Object.assign(globalThis, { window: { localStorage: localStorageStub } })

beforeEach(() => {
  localStorageStub.clear()
})

function storedSession(): { id: string; expiresAt: number } | null {
  const raw = localStorageStub.getItem(SESSION_STORAGE_KEY)
  if (raw === null) return null
  return JSON.parse(raw) as { id: string; expiresAt: number }
}

describe('ensureAnonymousSessionId', () => {
  test('首次生成 UUIDv4 并带 TTL 持久化', () => {
    const id = ensureAnonymousSessionId()

    expect(id).toMatch(UUID_V4)
    expect(storedSession()?.id).toBe(id)
    expect(storedSession()?.expiresAt).toBeGreaterThan(Date.now())
  })

  test('已有未过期会话时复用，不重新生成', () => {
    const first = ensureAnonymousSessionId()

    expect(ensureAnonymousSessionId()).toBe(first)
    expect(readAnonymousSessionId()).toBe(first)
  })

  test('会话过期后重新生成', () => {
    localStorageStub.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ id: 'expired-session', expiresAt: Date.now() - 1 }),
    )

    const id = ensureAnonymousSessionId()

    expect(id).not.toBe('expired-session')
    expect(id).toMatch(UUID_V4)
    expect(storedSession()?.id).toBe(id)
  })
})

describe('adoptAnonymousSessionId', () => {
  test('采纳服务端补发的会话并覆盖本地值', () => {
    ensureAnonymousSessionId()
    const issued = crypto.randomUUID()

    adoptAnonymousSessionId(issued)

    expect(readAnonymousSessionId()).toBe(issued)
    expect(storedSession()?.id).toBe(issued)
  })
})
