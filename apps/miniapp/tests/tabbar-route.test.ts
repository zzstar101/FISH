import { describe, expect, test } from 'bun:test'
import { isTabbarHiddenRoute, TABBAR_HIDDEN_ROUTE } from '../src/lib/tabbar-route'

/**
 * 底栏显隐判据（#562）。
 *
 * 需求：出物页不渲染底栏；其余 Tab 页与二级页正常渲染。
 *
 * 为什么值得单独钉住：显隐以前是在**渲染期**现读 `getCurrentPages()`（`currentRoute()`），
 * 而底栏实例在被别的页面压住期间仍会因未读 / 身份等异步源重渲染 —— 那时栈顶已不是自己，
 * 现读会命中「不隐藏」，把底栏画进一个看不见的页面；回到本页时 `setActive` 与离开前同值
 * → React bail out → 没人再求值 → 上一次画出来的底栏被原样显示（票里的「概率性卡出底栏」）。
 * 现在显隐跟着页面 onShow 广播进来的 `route` 状态走，本文件钉住的是那段判据本身。
 */

describe('isTabbarHiddenRoute —— 出物页不渲染底栏', () => {
  test('出物页：隐藏', () => {
    expect(isTabbarHiddenRoute('pages/sell/index')).toBe(true)
    // 真机上 route 可能带查询串（编辑态 `?id=`），口径与选中态匹配 TAB_ITEMS 一致
    expect(isTabbarHiddenRoute('pages/sell/index?id=abc')).toBe(true)
  })

  test('其余 Tab 页：都渲染底栏', () => {
    for (const route of [
      'pages/home/index',
      'pages/wish/index',
      'pages/chat/index',
      'pages/profile/index',
    ]) {
      expect(isTabbarHiddenRoute(route), route).toBe(false)
    }
  })

  test('二级页 / 非 Tab 页：都渲染底栏', () => {
    for (const route of [
      'pkg-browse/pages/listing-detail/index',
      'pkg-browse/pages/search/index',
      'pkg-browse/pages/history/index',
      'pkg-browse/pages/favorites/index',
      'pkg-browse/pages/mylist/index',
      'pkg-auth/pages/login/index',
    ]) {
      expect(isTabbarHiddenRoute(route), route).toBe(false)
    }
  })

  test('栈还没就绪（空路由）：不隐藏，先画出来让 onShow 广播纠正', () => {
    expect(isTabbarHiddenRoute('')).toBe(false)
  })

  test('判据只认一个路由真源常量', () => {
    expect(TABBAR_HIDDEN_ROUTE).toBe('pages/sell/index')
  })
})

/**
 * 接线层：底栏组件的早退必须读 `route` **状态**，而不是渲染期现读页面栈。
 *
 * 只证明源码形状（插件/工具链无法在 `tests/` 里渲染 WXSS 组件），运行时时序按
 * `docs/miniapp-dev-workflow.md` 的端上门禁验。
 */
async function tabbarSource(): Promise<string> {
  return await Bun.file(new URL('../src/custom-tab-bar/index.tsx', import.meta.url)).text()
}

describe('custom-tab-bar 显隐接线（#562）', () => {
  test('早退判据吃的是 route 状态，不是 currentRoute() 现读', async () => {
    const source = await tabbarSource()
    expect(source).toContain('if (isTabbarHiddenRoute(route)) return null')
    expect(source).not.toContain('currentRoute().includes')
  })

  test('route 状态只由 onShow 广播的 sync 更新，且与 active 同步设置', async () => {
    const source = await tabbarSource()
    const start = source.indexOf('const sync = () => {')
    const end = source.indexOf('Taro.eventCenter.on(TABBAR_ROUTE_EVENT, sync)')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const sync = source.slice(start, end)
    expect(sync).toContain('setRoute(currentRoute())')
    expect(sync).toContain('setActive(currentTabKey())')
    // 状态初值取挂载时的栈顶（首帧有可用的判据，不必等广播）
    expect(source).toContain('useState<string>(() => currentRoute())')
  })
})
