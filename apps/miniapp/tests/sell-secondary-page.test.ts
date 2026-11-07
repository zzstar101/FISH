import { describe, expect, test } from 'bun:test'

/**
 * 出物页是**二级页**（#629）的源码契约。
 *
 * 现象：出物页挂在 `tabBar.list` 上 → 栈深恒为 1 → 系统左滑没有手势、左上返回钮只能
 * 兜底回首页，从「我的发布」/ 商品详情进来编辑也回不到来处。
 * 定案（Owner）：把它从 Tab 身份里摘出来，改成普通二级页，返回 = 回上一页。
 *
 * 本仓 `tests/` 没有微信运行时基建，这类「路由身份」只能钉源码（先例
 * `tests/back-top-bottom-values.test.ts`）：写歪一处（例如有人把 sell 加回
 * `tabBar.list`、或某个入口又用 `switchTab` 打开它）就会在真机上退回栈深 1，
 * 而 typecheck / 普通单测都拦不住。
 */
async function source(relative: string): Promise<string> {
  return await Bun.file(new URL(`../src/${relative}`, import.meta.url)).text()
}

/**
 * 「打开出物页」的那次跳转。用正则而不是整串字面量：`navigateTo({ url: '…' })` 被格式化成
 * 多行、或后面接 `.catch(...)`，跳转语义都没变，断言不该跟着红。
 */
const OPEN_SELL_PUSH = /navigateTo\s*\(\s*\{[^}]*\/pages\/sell\/index/
const OPEN_SELL_TAB = /switchTab\s*\(\s*\{[^}]*\/pages\/sell\/index/

function tabBarPaths(config: string): string[] {
  const tabBar = config.slice(config.indexOf('tabBar: {'))
  return [...tabBar.matchAll(/pagePath: '([^']+)'/g)].map((m) => m[1])
}

describe('出物页的路由身份：TabBar 里没有它，pages 里还留着它', () => {
  test('tabBar.list 恰 4 项且不含出物页；主包 pages 仍声明出物页', async () => {
    const config = await source('app.config.ts')
    const tabPaths = tabBarPaths(config)

    expect(tabPaths).toEqual([
      'pages/home/index',
      'pages/wish/index',
      'pages/chat/index',
      'pages/profile/index',
    ])
    expect(tabPaths).not.toContain('pages/sell/index')

    // 摘的只是 Tab 身份：页面本身仍在主包 pages 里（挪去子包会让 navigateTo 的路径变）
    const pages = config.slice(config.indexOf('pages: ['), config.indexOf('tabBar: {'))
    expect(pages).toContain("'pages/sell/index'")
  })

  test('H5 预览的 TAB_ROUTES 与 tabBar.list 同源（它决定预览里渲不渲底栏）', async () => {
    const preview = await Bun.file(new URL('../preview/main.tsx', import.meta.url)).text()
    const block = preview.slice(preview.indexOf('const TAB_ROUTES = ['))
    const routes = [...block.slice(0, block.indexOf(']')).matchAll(/'([^']+)'/g)].map((m) => m[1])

    // 两边对不上时，预览会比真机多画/少画一层底栏，只有端上才看得见
    expect(routes).toEqual(tabBarPaths(await source('app.config.ts')))
    expect(routes).not.toContain('pages/sell/index')
  })
})

describe('进得出物页：入口压栈、返回靠 nav-back 兜底', () => {
  test('我的发布 / 商品详情用 navigateTo 打开出物页，不再 switchTab', async () => {
    for (const page of [
      'pkg-browse/pages/mylist/index.tsx',
      'pkg-browse/pages/listing-detail/index.tsx',
    ]) {
      const text = await source(page)
      expect(text).not.toMatch(OPEN_SELL_TAB)
      expect(text).toMatch(OPEN_SELL_PUSH)
    }

    // 我的发布三处入口（编辑 / 再次上架·重新上架 / 空态「去发布」）。
    // 这条是**变更探测器**：新增入口时把 3 改成新值即可，别删。
    const mylist = await source('pkg-browse/pages/mylist/index.tsx')
    expect([...mylist.matchAll(/navigateTo\s*\(\s*\{[^}]*\/pages\/sell\/index/g)]).toHaveLength(3)
  })

  test('出物页的返回走 lib/nav-back 兜底，且不再广播底栏可见性', async () => {
    const sell = await source('pages/sell/index.tsx')
    expect(sell).toContain("from '@/lib/nav-back'")
    // 二级页不再需要「隐藏底栏」那套广播
    expect(sell).not.toContain('notifyTabbarRoute')
    expect(sell).not.toContain('tabbar-route')
  })

  test('出物页的守卫按二级页口径：不再传 tab（那个形参只给真 Tab 页）', async () => {
    const sell = await source('pages/sell/index.tsx')
    expect(sell).toContain('useAuthGuard()')
    expect(sell).not.toContain('useAuthGuard({ tab: true })')
  })
})

describe('底栏中间那颗是「动作钮」而不是 Tab', () => {
  test('中间项 kind=action 且用 navigateTo 压栈，隐藏逻辑已删', async () => {
    const bar = await source('custom-tab-bar/index.tsx')
    expect(bar).not.toContain('isTabbarHiddenRoute')
    expect(bar).toContain("kind: 'action'")
    expect(bar).toMatch(/navigateTo\s*\(\s*\{\s*url:\s*item\.path\s*\}/)
  })
})
