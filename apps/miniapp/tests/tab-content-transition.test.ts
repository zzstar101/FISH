import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

let show: () => void = () => {}
let hide: () => void = () => {}
let ready: () => void = () => {}
let unmount: () => void = () => {}
let contentClass = ''
let updates = 0
let preloadCalls = 0
let preloadApi: (() => unknown) | undefined
mock.module('@tarojs/taro', () => ({
  default: {
    get preloadWebview() {
      return preloadApi
    },
  },
  useDidShow: (callback: () => void) => {
    show = callback
  },
  useDidHide: (callback: () => void) => {
    hide = callback
  },
  useReady: (callback: () => void) => {
    ready = callback
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
const { useTabTransition } = await import('../src/lib/use-tab-transition')

beforeEach(() => {
  contentClass = ''
  updates = 0
  preloadCalls = 0
  preloadApi = () => {
    preloadCalls++
    return Promise.resolve()
  }
  show = hide = ready = unmount = () => {}
  useTabTransition()
})
afterEach(() => unmount())

test('onShow / onReady 延迟预热下一次切 Tab；返回本页会补预热（#662）', async () => {
  expect(preloadCalls).toBe(0)
  show()
  ready()
  // 让开首屏渲染/取数：200ms 内不调用
  expect(preloadCalls).toBe(0)
  await Bun.sleep(250)
  expect(preloadCalls).toBe(1)
  hide()
  show()
  await Bun.sleep(250)
  expect(preloadCalls).toBe(2)
})

test('预热 API 不存在 / 同步抛错 / 异步失败都不影响页面（#662）', async () => {
  preloadApi = undefined
  expect(() => show()).not.toThrow()
  await Bun.sleep(250)
  expect(preloadCalls).toBe(0)

  preloadApi = () => {
    throw new Error('unsupported')
  }
  expect(() => show()).not.toThrow()
  await Bun.sleep(250)

  preloadApi = () => {
    preloadCalls++
    return Promise.reject(new Error('preload failed'))
  }
  show()
  await Bun.sleep(250)
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
