import { expect, mock, test } from 'bun:test'

/**
 * 「本地身份变了」这条通知（#652 扩展）的**行为**用例。
 *
 * 首页要在身份变化时重建列表（`tests/home-session-reset-wiring.test.ts`），而身份变化的
 * 全部入口都收在 `apps/miniapp/src/lib/session.ts`：`saveSession()` 只在**身份建立**时被调用
 * （`apps/api/src/modules/auth/router.ts` 只有 `/wechat/session`、`/wechat/scan/ticket/:ticket/exchange`、
 * `/register`、`/login` 四处下发 cookie），`clearSession()` 覆盖主动退出与 401 撤销。
 *
 * 这条通知的口径必须卡得很死，宽一格就是「白重拉一次」，窄一格就是「串号」：
 * - **同一个会话再落盘一次不该通知**：`request.ts` 对每条带 `Set-Cookie` 的响应都会调
 *   `saveSession()`，而「同一个人改了昵称/头像」只走 store 的 `emit()`、从不动会话 —— 通知口径
 *   一旦松掉，改个资料就会把首页打回骨架屏重拉一次。
 * - **写存储失败不该通知**：本地身份还是原来那个，没有任何东西变了。
 * - **`saveSession()` 绝不能触发 `onSessionCleared`**：store 那个监听器会把状态机拉回
 *   `anonymous`（`apps/miniapp/src/features/auth/store.ts`），登录当场被自己撤销。
 */

const disk = new Map<string, unknown>()

/** 模拟微信存储写失败（配额满）—— 只影响写入 */
let writeFails = false

/** 模拟微信存储删失败 */
let removeFails = false

mock.module('@tarojs/taro', () => ({
  default: {
    getStorageSync: (key: string) => disk.get(key) ?? '',
    setStorageSync: (key: string, value: unknown) => {
      if (writeFails) throw new Error('storage write failed')
      disk.set(key, value)
    },
    removeStorageSync: (key: string) => {
      if (removeFails) throw new Error('storage remove failed')
      disk.delete(key)
    },
  },
}))

const { clearSession, onSessionChanged, onSessionCleared, readSession, saveSession } = await import(
  '../src/lib/session'
)

/** 订阅一次「身份变了」，返回计数与退订函数（每个用例自己退订，别让计数串到下一个用例） */
function watchChanged(): { hits: () => number; off: () => void } {
  let count = 0
  const off = onSessionChanged(() => {
    count += 1
  })
  return { hits: () => count, off }
}

test('写入一段新会话 → 通知一次（登录、匿名→已登录、A→B 都走这条路）', () => {
  disk.clear()
  const watch = watchChanged()
  try {
    saveSession('fish_session=alice')
    expect(watch.hits()).toBe(1)
    expect(readSession()).toBe('fish_session=alice')

    // 换号：A 的会话换成 B 的
    saveSession('fish_session=bob')
    expect(watch.hits()).toBe(2)
  } finally {
    watch.off()
  }
})

test('同一个会话再落盘一次 → 不通知（同一身份的资料更新不该让首页重拉）', () => {
  disk.clear()
  saveSession('fish_session=alice')
  const watch = watchChanged()
  try {
    saveSession('fish_session=alice')
    expect(watch.hits()).toBe(0)
  } finally {
    watch.off()
  }
})

test('清掉一段真实存在的会话 → 通知一次（主动退出、401 会话被撤销）', () => {
  disk.clear()
  saveSession('fish_session=alice')
  const watch = watchChanged()
  try {
    clearSession()
    expect(watch.hits()).toBe(1)
    expect(readSession()).toBeNull()
  } finally {
    watch.off()
  }
})

test('本来就没有会话时清会话 → 不通知（没有身份变化，别让首页白重建一次）', () => {
  disk.clear()
  const watch = watchChanged()
  try {
    clearSession()
    expect(watch.hits()).toBe(0)
  } finally {
    watch.off()
  }
})

test('存储写失败 → 不通知（本地身份没真正换过来，屏幕上的数据也就不作废）', () => {
  disk.clear()
  saveSession('fish_session=alice')
  const watch = watchChanged()
  writeFails = true
  try {
    saveSession('fish_session=bob')
    expect(watch.hits()).toBe(0)
    expect(readSession()).toBe('fish_session=alice')
  } finally {
    writeFails = false
    watch.off()
  }
})

test('存储删失败 → 不通知（会话还读得出来，本地身份没变）', () => {
  disk.clear()
  saveSession('fish_session=alice')
  const watch = watchChanged()
  removeFails = true
  try {
    clearSession()
    expect(watch.hits()).toBe(0)
    expect(readSession()).toBe('fish_session=alice')
  } finally {
    removeFails = false
    watch.off()
  }
})

test('退订之后不再收到通知（页面卸载后的迟到变化不该写已销毁的页面）', () => {
  disk.clear()
  const watch = watchChanged()
  watch.off()
  saveSession('fish_session=alice')
  expect(watch.hits()).toBe(0)
})

test('既有契约不回归：清会话仍然通知 `onSessionCleared`，而登录不触发它', () => {
  disk.clear()
  let cleared = 0
  const off = onSessionCleared(() => {
    cleared += 1
  })
  try {
    // 登录方向绝不能走到 `onSessionCleared`：store 的监听器会把状态机拉回未登录
    saveSession('fish_session=alice')
    expect(cleared).toBe(0)

    clearSession()
    expect(cleared).toBe(1)
  } finally {
    off()
  }
})
