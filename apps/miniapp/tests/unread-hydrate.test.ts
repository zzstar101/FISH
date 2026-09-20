import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 未读快照 store 的冷启动行为 —— 锁住 #129 review 的第二条 P1：
 *
 * 底栏在每个 Tab 页都渲染，用户可能一次都不进消息页。修复前底栏会退回
 * 「mock 会话 + mock 通知计数」，而 fixture 的未读与真实账号无关，于是出现
 * 「真实有未读却不亮」或「没有未读却亮着幽灵红点」。
 *
 * 修复后冷启动用真实 `GET /notifications/unread-count` 补快照；
 * **真实构建下接口失败就发 `null`（不知道），绝不回退 fixture**。
 *
 * 用 `mock.module` 顶替 API 层与构建开关（与 `signature.test.ts` 顶替 Taro 同一手法）。
 */

let fetchResult: () => Promise<number> = () => Promise.resolve(0)

mock.module('@/features/chat/api', () => ({
  fetchUnreadNotificationCount: () => fetchResult(),
}))

mock.module('@/mock/api', () => ({
  // fixture 通知未读：只要它被读到，就说明真实构建退回了 mock（本测试要禁止的行为）
  unreadNotificationCount: () => 99,
}))

const { clearUnread, hydrateUnread, publishUnread, unreadSnapshot } = await import(
  '../src/features/chat/unread'
)

/** store 是模块级单例：每个用例前把内部快照清掉，避免互相污染 */
beforeEach(() => {
  clearUnread()
})

/**
 * 等 hydrateUnread 的整条 promise 链跑完。catch 分支里有**动态 import**（fixture 兜底），
 * 那是真正的模块加载，只让微任务队列空转不够 —— 要放行几轮宏任务。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('未读快照 · 冷启动补数', () => {
  test('真实构建：用接口结果填通知未读（不回退 fixture）', async () => {
    fetchResult = () => Promise.resolve(3)

    hydrateUnread('u-alan', 0)
    await flush()

    expect(unreadSnapshot()?.notifications).toBe(3)
    expect(unreadSnapshot()?.ownerId).toBe('u-alan')
  })

  test('真实构建：接口失败 → 通知未读为 null（不知道），不拿 fixture 顶替', async () => {
    fetchResult = () => Promise.reject(new Error('network down'))

    hydrateUnread('u-alan', 0)
    await flush()

    // 关键：不是 99（fixture）。`null` = 不知道 → 底栏按「无已知未读」算，
    // 不会亮幽灵红点，也不会把 fixture 的数字冒充成真实未读
    expect(unreadSnapshot()?.notifications).toBeNull()
  })

  test('演示 / 开发构建（调用方注入 fixture 兜底）：接口失败时仍能拿到计数', async () => {
    fetchResult = () => Promise.reject(new Error('network down'))

    hydrateUnread('u-alan', 0, () => 99)
    await flush()

    // 演示环境必须还能看到红点，否则端上演示等于没有这条特性
    expect(unreadSnapshot()?.notifications).toBe(99)
  })

  test('已有本次账号的快照时不再补（消息页的权威值不被覆盖）', async () => {
    fetchResult = () => Promise.resolve(3)

    publishUnread({ ownerId: 'u-alan', conversations: 5, notifications: 0 })

    hydrateUnread('u-alan', 0)
    await flush()

    // 会话数仍来自消息页那份（5），没被「只含通知」的补请求盖成 0
    expect(unreadSnapshot()?.conversations).toBe(5)
  })

  test('换账号后旧账号的迟到结果不覆盖新账号快照', async () => {
    let resolveOld: (value: number) => void = () => {}
    fetchResult = () =>
      new Promise<number>((resolve) => {
        resolveOld = resolve
      })

    // A 的补请求在途
    hydrateUnread('u-a', 0)
    await flush()

    // 期间切到 B 并有了 B 的快照
    publishUnread({ ownerId: 'u-b', conversations: 1, notifications: 1 })

    // A 的响应迟到
    resolveOld(7)
    await flush()

    // 快照仍是 B 的，A 的结果被丢弃
    expect(unreadSnapshot()?.ownerId).toBe('u-b')
    expect(unreadSnapshot()?.notifications).toBe(1)
  })
})
