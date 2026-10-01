import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 匿名识图会话的存储语义。
 *
 * 这个 id 决定查询图的对象键主体与匿名限流桶（见 `src/features/visual-search/session.ts`），
 * 所以「什么时候复用、什么时候换新、服务端回写的要不要采纳」都得钉住 —— 换错表现为
 * 「上传拿到的 objectKey 搜不了」（400）。
 *
 * 为什么用 `mock.module`：`./session` 必须 `import Taro`，Bun 下加载真 Taro 会抛
 * `ENABLE_INNER_HTML is not defined`（手法同 `tests/recommendation-module-init.test.ts`）。
 */
const SESSION_KEY = 'fish.visualSearch.sessionId'
const store = new Map<string, unknown>()

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => store.get(key) ?? '',
    setStorageSync: (key: string, data: unknown) => {
      store.set(key, data)
    },
    removeStorageSync: (key: string) => {
      store.delete(key)
    },
  },
}))

const { adoptVisualSearchSessionId, currentVisualSearchSessionId, ensureVisualSearchSessionId } =
  await import('../src/features/visual-search/session')

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXPIRED = '11111111-1111-4111-8111-111111111111'
const ISSUED = '22222222-2222-4222-8222-222222222222'

function stored(): { id: string; expiresAt: number } | undefined {
  return store.get(SESSION_KEY) as { id: string; expiresAt: number } | undefined
}

describe('匿名识图会话', () => {
  beforeEach(() => {
    store.clear()
  })

  test('没有会话时生成一个 uuid 并落盘（带过期时刻）', () => {
    expect(currentVisualSearchSessionId()).toBeNull()
    const id = ensureVisualSearchSessionId()
    expect(UUID_SHAPE.test(id)).toBe(true)
    expect(stored()?.id).toBe(id)
    expect(stored()?.expiresAt).toBeGreaterThan(Date.now())
  })

  test('已有会话时复用同一个 id，不轮换', () => {
    const first = ensureVisualSearchSessionId()
    expect(ensureVisualSearchSessionId()).toBe(first)
  })

  test('过期的会话当作不存在：换新而不是继续用', () => {
    store.set(SESSION_KEY, { id: EXPIRED, expiresAt: Date.now() - 1 })
    expect(currentVisualSearchSessionId()).toBeNull()
    expect(ensureVisualSearchSessionId()).not.toBe(EXPIRED)
  })

  test('脏数据（不是 uuid 形状）当作不存在', () => {
    store.set(SESSION_KEY, { id: 'not-a-uuid', expiresAt: Date.now() + 60_000 })
    expect(currentVisualSearchSessionId()).toBeNull()
  })

  test('采纳服务端回写的会话：覆盖本地', () => {
    ensureVisualSearchSessionId()
    adoptVisualSearchSessionId(ISSUED)
    expect(currentVisualSearchSessionId()).toBe(ISSUED)
  })

  test('服务端没回写、或回写的不是 uuid：保持本地不变', () => {
    const local = ensureVisualSearchSessionId()
    adoptVisualSearchSessionId(undefined)
    adoptVisualSearchSessionId('garbage')
    expect(currentVisualSearchSessionId()).toBe(local)
  })
})
