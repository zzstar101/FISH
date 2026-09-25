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

const {
  badgeShouldLight,
  clearUnread,
  hydrateUnread,
  publishUnread,
  refreshUnread,
  unreadSnapshot,
} = await import('../src/features/chat/unread')

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

describe('未读快照 · 底栏红点判定', () => {
  test('任何一项已知未读 > 0 → 亮', () => {
    expect(badgeShouldLight({ conversations: 1, notifications: 0, previous: false })).toBe(true)
    expect(badgeShouldLight({ conversations: 0, notifications: 3, previous: false })).toBe(true)
    expect(badgeShouldLight({ conversations: null, notifications: 2, previous: false })).toBe(true)
  })

  test('两项都已知且都是 0 → 熄', () => {
    expect(badgeShouldLight({ conversations: 0, notifications: 0, previous: true })).toBe(false)
  })

  test('有分量「不知道」且没有已知未读 → 保持上一帧，不熄掉已知的红点', () => {
    // 这是 `null` 存在的意义：接口失败时按 0 算，会把用户真实存在的未读红点熄掉
    expect(badgeShouldLight({ conversations: null, notifications: 0, previous: true })).toBe(true)
    expect(badgeShouldLight({ conversations: 0, notifications: null, previous: true })).toBe(true)
    expect(badgeShouldLight({ conversations: null, notifications: null, previous: true })).toBe(
      true,
    )
    // 上一帧本来就是熄的，也不该因为「不知道」而无中生有
    expect(badgeShouldLight({ conversations: null, notifications: null, previous: false })).toBe(
      false,
    )
  })
})

/**
 * 显示时刷新（#170 D：底栏每次显示都重取一次真实未读）。
 *
 * 冷启动补数只在「本账号还没有快照」时发请求；底栏实例跨「切 Tab / 后台回前台」
 * 存活，别处产生的未读（新消息、另一台设备已读）必须能在重新显示时被取回来。
 * 同时不能反过来把已有的正确值弄坏：拿不到的分量沿用旧值（不下调成「不知道」），
 * 期间出现更权威的快照（消息页发布 / 登出清场）则丢弃这份迟到结果。
 */
describe('未读快照 · 显示时刷新', () => {
  test('已有本次账号的快照时，刷新仍会重新取一次并落地新值', async () => {
    notifResult = () => Promise.resolve(3)
    convResult = () => Promise.resolve(4)
    publishUnread({ ownerId: 'u-alan', conversations: 5, notifications: 0 })

    // 别处产生了新的未读：下一次显示必须能取回来（冷启动补数在这里会直接 return）
    notifResult = () => Promise.resolve(7)
    convResult = () => Promise.resolve(8)
    refreshUnread('u-alan')
    await flush()

    expect(unreadSnapshot()?.ownerId).toBe('u-alan')
    expect(unreadSnapshot()?.notifications).toBe(7)
    expect(unreadSnapshot()?.conversations).toBe(8)
  })

  test('刷新期间消息页发布了权威快照 → 这份迟到结果被丢弃', async () => {
    let resolveNotif: (value: number) => void = () => {}
    notifResult = () =>
      new Promise<number>((resolve) => {
        resolveNotif = resolve
      })
    convResult = () => Promise.resolve(4)

    refreshUnread('u-alan')
    await flush()

    // 期间消息页算出了更权威的值（含页内已读回写）
    publishUnread({ ownerId: 'u-alan', conversations: 5, notifications: 0 })

    resolveNotif(7)
    await flush()

    // 不能被这次刷新的旧值盖回去
    expect(unreadSnapshot()?.notifications).toBe(0)
    expect(unreadSnapshot()?.conversations).toBe(5)
  })

  test('刷新两路都没拿到（真实构建）→ 保留旧快照，不把「知道」写成「不知道」', async () => {
    publishUnread({ ownerId: 'u-alan', conversations: 2, notifications: 1 })

    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.reject(new Error('network down'))
    refreshUnread('u-alan')
    await flush()

    expect(unreadSnapshot()?.notifications).toBe(1)
    expect(unreadSnapshot()?.conversations).toBe(2)
  })

  test('刷新只拿到一项 → 已知项更新，没拿到的那项沿用旧值', async () => {
    publishUnread({ ownerId: 'u-alan', conversations: 2, notifications: 5 })

    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.resolve(9)
    refreshUnread('u-alan')
    await flush()

    expect(unreadSnapshot()?.conversations).toBe(9)
    // 通知那一路失败：沿用旧值 5，而不是变成「不知道」
    expect(unreadSnapshot()?.notifications).toBe(5)
  })

  test('换账号后 A 的迟到刷新结果不覆盖 B 的快照', async () => {
    let resolveNotif: (value: number) => void = () => {}
    notifResult = () =>
      new Promise<number>((resolve) => {
        resolveNotif = resolve
      })
    convResult = () => Promise.resolve(4)

    refreshUnread('u-a')
    await flush()

    publishUnread({ ownerId: 'u-b', conversations: 1, notifications: 1 })
    resolveNotif(7)
    await flush()

    expect(unreadSnapshot()?.ownerId).toBe('u-b')
    expect(unreadSnapshot()?.notifications).toBe(1)
    expect(unreadSnapshot()?.conversations).toBe(1)
  })

  test('登出清场后同一账号的迟到刷新结果不落地（latestOwner 会变回同一个 id）', async () => {
    let resolveNotif: (value: number) => void = () => {}
    notifResult = () =>
      new Promise<number>((resolve) => {
        resolveNotif = resolve
      })
    convResult = () => Promise.resolve(4)

    publishUnread({ ownerId: 'u-a', conversations: 2, notifications: 2 })
    refreshUnread('u-a')
    await flush()

    clearUnread()
    resolveNotif(7)
    await flush()

    // 登出后不能有任何快照被写回（同一账号再登录时也不该被旧结果顶掉）
    expect(unreadSnapshot()).toBeNull()
  })

  test('登出后同一账号马上重新登录：登出前发出的结果不落地，新一轮补数照常生效', async () => {
    const notifResolvers: Array<(value: number) => void> = []
    notifResult = () =>
      new Promise<number>((resolve) => {
        notifResolvers.push(resolve)
      })
    convResult = () => Promise.resolve(4)

    publishUnread({ ownerId: 'u-a', conversations: 2, notifications: 2 })
    refreshUnread('u-a')
    await flush()

    clearUnread()
    // 同一账号重新登录：底栏的补数会把这个账号重新记成「当前该为谁取数」，于是光比
    // latestOwner 已经挡不住登出前发出的那份结果，只能靠登出时推进的版本号
    hydrateUnread('u-a')
    await flush()

    // 登出必须把在途去重表一并清掉：否则这一轮补数会被「还在途」的旧请求吞掉，
    // 而旧请求的结果又已被版本号作废 —— 这一次登录就没人再取数了
    expect(notifResolvers).toHaveLength(2)

    notifResolvers[0](7)
    await flush()
    expect(unreadSnapshot()).toBeNull()

    // 新一轮登录自己的结果照常落地
    notifResolvers[1](9)
    await flush()
    expect(unreadSnapshot()?.ownerId).toBe('u-a')
    expect(unreadSnapshot()?.notifications).toBe(9)
    expect(unreadSnapshot()?.conversations).toBe(4)
  })

  test('换账号（新账号的补数还没回来）后 A 的迟到结果不落地', async () => {
    const notifResolvers: Array<(value: number) => void> = []
    notifResult = () =>
      new Promise<number>((resolve) => {
        notifResolvers.push(resolve)
      })
    const convResolvers: Array<(value: number) => void> = []
    convResult = () =>
      new Promise<number>((resolve) => {
        convResolvers.push(resolve)
      })

    refreshUnread('u-a')
    await flush()
    // B 登录：底栏为 B 补数。这一步只把「当前该为谁取数」改成 B，B 的快照还没回来，
    // 所以此刻没有任何更权威的快照 —— 挡住 A 那份结果的只能是账号比对
    hydrateUnread('u-b')
    await flush()

    notifResolvers[0](7)
    convResolvers[0](7)
    await flush()

    expect(unreadSnapshot()).toBeNull()

    notifResolvers[1](1)
    convResolvers[1](1)
    await flush()

    expect(unreadSnapshot()?.ownerId).toBe('u-b')
    expect(unreadSnapshot()?.notifications).toBe(1)
  })

  test('同账号刷新在途时再调只发一次请求（多 Tab 实例并发去重）', async () => {
    let notifCalls = 0
    notifResult = () => {
      notifCalls += 1
      return Promise.resolve(1)
    }
    convResult = () => Promise.resolve(0)

    refreshUnread('u-a')
    refreshUnread('u-a')
    await flush()

    expect(notifCalls).toBe(1)
  })

  test('演示 / 开发构建：刷新两路都失败 → 用注入的兜底，红点不消失', async () => {
    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.reject(new Error('network down'))

    refreshUnread('u-alan', () => ({ conversations: 9, notifications: 99 }))
    await flush()

    expect(unreadSnapshot()?.conversations).toBe(9)
    expect(unreadSnapshot()?.notifications).toBe(99)
  })

  test('没有旧快照时刷新两路都失败 → 不发布空快照', async () => {
    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.reject(new Error('network down'))

    refreshUnread('u-alan')
    await flush()

    // 两项都是「不知道」且没有旧值可沿用：没有新信息，不广播（底栏按上一帧处理）
    expect(unreadSnapshot()).toBeNull()
  })

  test('刷新只沿用「本次账号」的旧值：上一个账号的残留快照不算数', async () => {
    // A 登出时没人清场（用户从没进过消息页），快照还是 A 的
    publishUnread({ ownerId: 'u-a', conversations: 2, notifications: 5 })

    // B 的刷新两路都失败
    notifResult = () => Promise.reject(new Error('network down'))
    convResult = () => Promise.reject(new Error('network down'))
    refreshUnread('u-b')
    await flush()

    // 不能把 A 的计数当成 B 的旧值沿用（那会让 B 亮起 A 的未读）
    expect(unreadSnapshot()?.ownerId).toBe('u-a')
    expect(unreadSnapshot()?.conversations).toBe(2)
    expect(unreadSnapshot()?.notifications).toBe(5)
  })

  test('刷新结果被更权威的快照作废后，下一次刷新仍然真的发请求（在途去重项必须释放）', async () => {
    const notifResolvers: Array<(value: number) => void> = []
    notifResult = () =>
      new Promise<number>((resolve) => {
        notifResolvers.push(resolve)
      })
    convResult = () => Promise.resolve(4)

    refreshUnread('u-a')
    await flush()
    expect(notifResolvers).toHaveLength(1)

    // 期间消息页发布了更权威的快照 → 这份在途刷新的结果会被作废（早退路径）
    publishUnread({ ownerId: 'u-a', conversations: 5, notifications: 0 })
    notifResolvers[0](7)
    await flush()
    expect(unreadSnapshot()?.notifications).toBe(0)

    /*
      作废的只能是「这份结果」，不能连「这个账号正在取数」这个标记也留下：否则之后
      每一次显示时刷新都被在途去重吞掉，红点永远停在旧值上 —— 判据 D 静默失效，
      而且直到下一次登出清场才恢复。
    */
    refreshUnread('u-a')
    await flush()
    expect(notifResolvers).toHaveLength(2)

    notifResolvers[1](9)
    await flush()
    expect(unreadSnapshot()?.notifications).toBe(9)
    expect(unreadSnapshot()?.conversations).toBe(4)
  })
})
