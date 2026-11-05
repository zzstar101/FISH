import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

let show: () => void = () => {}
let hide: () => void = () => {}
let unmount: () => void = () => {}
let contentClass = ''
let updates = 0
mock.module('@tarojs/taro', () => ({
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
const { useTabTransition } = await import('../src/lib/use-tab-transition')

beforeEach(() => {
  contentClass = ''
  updates = 0
  show = hide = unmount = () => {}
  useTabTransition()
})
afterEach(() => unmount())

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
