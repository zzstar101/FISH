import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

let show: () => void = () => {}
let hide: () => void = () => {}
let unmount: () => void = () => {}
let contentClass = ''
let updates = 0
let preloadCalls = 0
let preloadApi: (() => unknown) | undefined
let platform = 'devtools'
mock.module('@tarojs/taro', () => ({
  default: {
    get preloadWebview() {
      return preloadApi
    },
    getSystemInfoSync: () => ({ platform }),
  },
  useDidShow: (callback: () => void) => {
    show = callback
  },
  useDidHide: (callback: () => void) => {
    hide = callback
  },
  useUnload: () => {},
}))
mock.module('react', () => ({
  useRef: (current: unknown) => ({ current }),
  useState: (initial: string) => [
    initial,
    (next: string) => {
      contentClass = next
      updates++
    },
  ],
  useEffect: (effect: () => () => void) => {
    unmount = effect()
  },
}))
mock.module('../src/lib/tabbar-sync', () => ({
  notifyTabbarRoute: () => ({
    id: 1,
    route: 'pages/wish/index',
    from: 0,
    to: 130.8,
    startedAt: Date.now(),
  }),
  resetTabTransition: () => {},
}))
const { PRELOAD_DELAY_MS, useTabTransition } = await import('../src/lib/use-tab-transition')

beforeEach(() => {
  contentClass = ''
  updates = 0
  preloadCalls = 0
  platform = 'devtools'
  preloadApi = () => {
    preloadCalls++
    return Promise.resolve()
  }
  show = hide = unmount = () => {}
  useTabTransition()
})
afterEach(() => unmount())

test('非安卓平台：延迟预热下一次切 Tab，返回本页会补预热（#662）', async () => {
  // 审查意见「过短的延迟也能通过时序检查」：下面的 sleep 都按常量推算，
  // 把常量本身改小（例如 200 → 80）时相对时序仍然成立、测试会假绿 ——
  // 所以这里直接钉住常量的下限，让「延迟被改短」在断言处就红。
  expect(PRELOAD_DELAY_MS).toBeGreaterThanOrEqual(200)
  show()
  // 让开首屏渲染/取数：不足 200ms 时不应调用
  await Bun.sleep(PRELOAD_DELAY_MS - 50)
  expect(preloadCalls).toBe(0)
  await Bun.sleep(100)
  expect(preloadCalls).toBe(1)
  hide()
  show()
  await Bun.sleep(PRELOAD_DELAY_MS + 50)
  expect(preloadCalls).toBe(2)
})

test('安卓保留框架默认预加载，hook 不重复建 WebView（#662）', async () => {
  platform = 'android'
  show()
  await Bun.sleep(PRELOAD_DELAY_MS + 50)
  expect(preloadCalls).toBe(0)
})

test('预热还没到 200ms 就切走：隐藏时立即补一次（#662）', () => {
  show()
  expect(preloadCalls).toBe(0)
  hide()
  expect(preloadCalls).toBe(1)
})

test('预热 API 不存在 / 同步抛错 / 异步失败都不影响页面（#662）', async () => {
  preloadApi = undefined
  expect(() => show()).not.toThrow()
  await Bun.sleep(PRELOAD_DELAY_MS + 50)
  expect(preloadCalls).toBe(0)

  preloadApi = () => {
    throw new Error('unsupported')
  }
  expect(() => show()).not.toThrow()
  await Bun.sleep(PRELOAD_DELAY_MS + 50)

  preloadApi = () => {
    preloadCalls++
    return Promise.reject(new Error('preload failed'))
  }
  show()
  await Bun.sleep(PRELOAD_DELAY_MS + 50)
  expect(preloadCalls).toBe(1)
})

test('鉴权恢复晚于切页动画窗口，首次挂载内容时不补播旧 class', async () => {
  show()
  expect(contentClass).toMatch(/^tab-content-enter-/)
  // 此期间页面只显示恢复占位；鉴权完成后，列表才首次读取最近提交的 class。
  await Bun.sleep(200)
  expect(contentClass).toBe('')
})

test('隐藏立即清除内容动效；卸载取消尚未到期的回调', async () => {
  show()
  hide()
  expect(contentClass).toBe('')
  show()
  unmount()
  const updatesAtUnmount = updates
  await Bun.sleep(200)
  expect(updates).toBe(updatesAtUnmount)
})
