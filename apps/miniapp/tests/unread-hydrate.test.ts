import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 未读快照 store 的冷启动行为 —— 锁住 #129 review 的第二条 P1，以及 #89 对
 * 「会话未读那一分量必须一并收口」的要求。
 *
 * 底栏在每个 Tab 页都渲染，用户可能一次都不进消息页。修复前底栏会退回
 * 「mock 会话 + mock 通知计数」，而 fixture 的未读与真实账号无关，于是出现
 * 「真实有未读却不亮」或「没有未读却亮着幽灵红点」。
 *
 * 现在冷启动两项都走真实接口：`GET /notifications/unread-count` 与
 * `GET /conversations` 求和（`fetchConversationUnreadCount`，这里被顶替）。
 * **真实构建下接口失败就发「不知道」，绝不回退 fixture**。
 *
 * 用 `mock.module` 顶替 API 层（与 `signature.test.ts` 顶替 Taro 同一手法）。
 */

let notifResult: () => Promise<number> = () => Promise.resolve(0)
let convResult: () => Promise<number> = () => Promise.resolve(0)

mock.module('@/features/chat/api', () => ({
  fetchUnreadNotificationCount: () => notifResult(),
  fetchConversationUnreadCount: () => convResult(),
}))

const { clearUnread, hydrateUnread, publishUnread, unreadSnapshot } = await import(
  '../src/features/chat/unread'
)

/** store 是模块级单例：每个用例前把内部快照清掉，避免互相污染 */
beforeEach(() => {
  clearUnread()
})

/**
 * 等 hydrateUnread 的整条 promise 链跑完（含调用方注入的兜底函数）。
 * 放行几轮宏任务，而不是只让微任务队列空转。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('未读快照 · 冷启动补数', () => {
  test('真实构建：会话未读与通知未读都来自真实接口', async () => {
    notifResult = () => Promise.resolve(3)
    convResult = () => Promise.resolve(4)

    hydrateUnread('u-alan')
    await flush()

    expect(unreadSnapshot()?.ownerId).toBe('u-alan')
    expect(unreadSnapshot()?.notifications).toBe(3)
    // #89：底栏的会话未读分量此前无论哪条路径都来自 fixture，现在必须是真的
    expect(unreadSnapshot()?.conversations).toBe(4)
  })

  test('真实构建：两个接口都失败 → 两项都记「不知道」（null），不拿 fixture 顶替', async () => {
    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.reject(new Error('network down'))

    hydrateUnread('u-alan')
    await flush()

    // 关键：不是 fixture 的数字，也不是 0。两者都是「不知道」→ 底栏按「无已知未读」算，
    // 不会亮幽灵红点，也不会把 fixture 的数字冒充成真实未读。
    // 会话那一项尤其不能用 0：0 是「确定没有未读」这个具体结论，会把上一份正确的
    // 快照覆盖掉，用户明明还有未读、红点却熄了。
    expect(unreadSnapshot()?.notifications).toBeNull()
    expect(unreadSnapshot()?.conversations).toBeNull()
  })

  test('演示 / 开发构建：失败的那一项用调用方注入的兜底，成功的那一项仍用真值', async () => {
    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.resolve(2)

    hydrateUnread('u-alan', () => ({ conversations: 9, notifications: 99 }))
    await flush()

    // 演示环境必须还能看到红点，否则端上演示等于没有这条特性
    expect(unreadSnapshot()?.notifications).toBe(99)
    // 但拿到真值的那一项不能被 fixture 覆盖成 9
    expect(unreadSnapshot()?.conversations).toBe(2)
  })

  test('演示 / 开发构建：两个接口都失败 → 两项都用兜底', async () => {
    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.reject(new Error('network down'))

    hydrateUnread('u-alan', () => ({ conversations: 9, notifications: 99 }))
    await flush()

    expect(unreadSnapshot()?.conversations).toBe(9)
    expect(unreadSnapshot()?.notifications).toBe(99)
  })

  test('已有本次账号的快照时不再补（消息页的权威值不被覆盖）', async () => {
    notifResult = () => Promise.resolve(3)
    convResult = () => Promise.resolve(4)

    publishUnread({ ownerId: 'u-alan', conversations: 5, notifications: 0 })

    hydrateUnread('u-alan', () => ({ conversations: 9, notifications: 99 }))
    await flush()

    // 会话数仍来自消息页那份（5），没被补请求盖成 4 / 9
    expect(unreadSnapshot()?.conversations).toBe(5)
    expect(unreadSnapshot()?.notifications).toBe(0)
  })

  test('换账号后旧账号的迟到结果不覆盖新账号快照', async () => {
    let resolveOld: (value: number) => void = () => {}
    notifResult = () =>
      new Promise<number>((resolve) => {
        resolveOld = resolve
      })
    convResult = () => Promise.resolve(4)

    // A 的补请求在途（通知那一路挂着，Promise.all 不会结算）
    hydrateUnread('u-a')
    await flush()

    // 期间切到 B 并有了 B 的快照
    publishUnread({ ownerId: 'u-b', conversations: 1, notifications: 1 })

    // A 的响应迟到
    resolveOld(7)
    await flush()

    // 快照仍是 B 的，A 的结果被丢弃
    expect(unreadSnapshot()?.ownerId).toBe('u-b')
    expect(unreadSnapshot()?.notifications).toBe(1)
    expect(unreadSnapshot()?.conversations).toBe(1)
  })

  test('上一个账号的残留快照不影响新账号：B 自己的结果必须落地', async () => {
    notifResult = () => Promise.resolve(5)
    convResult = () => Promise.resolve(2)

    /*
      真实场景：A 冷启动补过数（快照 ownerId=u-a），A 登出时**没人清快照**
      （Chat 页实例本次从未挂载，`clearUnread` 不会被调用），随后 B 登录。
      若判陈旧的条件写成「快照属于别人就不发布」，B 的结果会被一并丢掉 →
      B 整场都不亮红点（正是要消除的「真实有未读却不亮」）。
    */
    publishUnread({ ownerId: 'u-a', conversations: 3, notifications: 0 })

    hydrateUnread('u-b')
    await flush()

    // B 的真实结果覆盖了 A 的残留快照
    expect(unreadSnapshot()?.ownerId).toBe('u-b')
    expect(unreadSnapshot()?.notifications).toBe(5)
    expect(unreadSnapshot()?.conversations).toBe(2)
  })
})
