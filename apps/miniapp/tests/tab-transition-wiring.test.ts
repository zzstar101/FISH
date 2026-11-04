import { beforeEach, expect, mock, test } from 'bun:test'

let route = 'pages/home/index'
const calls: string[] = []
let failNavigation = false
mock.module('@tarojs/taro', () => ({
  default: {
    getCurrentPages: () => [{ route }],
    eventCenter: { trigger: (event: string) => calls.push(event) },
    switchTab: ({ url }: { url: string }) => {
      calls.push(url)
      return failNavigation ? Promise.reject(new Error('navigation failed')) : Promise.resolve()
    },
  },
}))
const sync = await import('../src/lib/tabbar-sync')

beforeEach(() => {
  calls.length = 0
  route = 'pages/home/index'
  failNavigation = false
  sync.resetTabTransition?.()
})

test('点击同步调用原生导航，不抢改高光；目标显示才广播并启动动效', () => {
  expect(typeof sync.switchTabWithTransition).toBe('function')
  sync.switchTabWithTransition('/pages/wish/index')
  expect(calls).toEqual(['/pages/wish/index'])
  expect(sync.readTabTransition()).toBeNull()
  route = 'pages/wish/index'
  expect(sync.notifyTabbarRoute()).toMatchObject({ from: 0, to: 130.8 })
  expect(calls).toEqual(['/pages/wish/index', sync.TABBAR_ROUTE_EVENT])
  expect(sync.readTabTransition()?.route).toBe(route)
})

test('平台拒绝导航后，后续程序化进入不重播已失败意图', async () => {
  expect(typeof sync.switchTabWithTransition).toBe('function')
  failNavigation = true
  sync.switchTabWithTransition('/pages/wish/index')
  await Promise.resolve()
  route = 'pages/wish/index'
  expect(sync.notifyTabbarRoute()).toBeNull()
})

test('出物仍走相同 switchTab，且不触发动效', () => {
  expect(typeof sync.switchTabWithTransition).toBe('function')
  sync.switchTabWithTransition('/pages/sell/index')
  expect(calls).toEqual(['/pages/sell/index'])
  route = 'pages/sell/index'
  expect(sync.notifyTabbarRoute()).toBeNull()
})

test('动效仅改变内容 opacity 和胶囊 transform，减少动态效果时直接落位', async () => {
  const app = await Bun.file(new URL('../src/app.scss', import.meta.url)).text()
  const bar = await Bun.file(new URL('../src/custom-tab-bar/index.scss', import.meta.url)).text()
  expect(app).toContain('@keyframes tab-content-enter-a')
  expect(app).toContain('opacity: 0.96')
  expect(app).toContain('prefers-reduced-motion: reduce')
  expect(bar).toContain('var(--tab-capsule-from)')
  expect(bar).toContain('cubic-bezier(0.333333, 1, 0.666667, 1)')
  expect(bar).toContain('prefers-reduced-motion: reduce')
})

// 仓库没有 React 挂载测试基建：生命周期/样式接线以源码契约补充，实际渲染另在开发者工具验证。
test('四页共用显示/卸载接线，内容不靠 key 卸载重建；App 后台使意图失效', async () => {
  const hook = Bun.file(new URL('../src/lib/use-tab-transition.ts', import.meta.url))
  expect(await hook.exists()).toBe(true)
  const source = await hook.text()
  expect(source).toContain('useDidShow(')
  expect(source).toContain('notifyTabbarRoute()')
  expect(source).toContain('useUnload(resetTabTransition)')
  for (const page of ['home', 'wish', 'chat', 'profile']) {
    const content = await Bun.file(
      new URL(`../src/pages/${page}/index.tsx`, import.meta.url),
    ).text()
    expect(content).toContain('useTabTransition()')
    expect(content).toContain('tabContentClass')
    expect(content).not.toContain('key={tabContentClass}')
  }
  const app = await Bun.file(new URL('../src/app.ts', import.meta.url)).text()
  expect(app).toContain('useDidHide(resetTabTransition)')
})
