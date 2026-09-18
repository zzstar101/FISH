import { describe, expect, test } from 'bun:test'

/**
 * 后台路由结构守卫（#73）。
 *
 * 起因：`admin.users.tsx` / `admin.listings.tsx` 既是页面路由，又是
 * `admin.users.$userId.tsx` / `admin.listings.$listingId.tsx` 的**父路由**。父路由组件直接渲染列表页、
 * 不含 `<Outlet/>`，于是点「详情」只重渲染列表，两个详情页永远不会挂载。
 *
 * 约定：`/admin` 下只有布局 `admin.tsx`（渲染 `AdminShell` → `<Outlet/>`）可以当父路由；
 * 列表页一律用 index 路由（与 `category.index.tsx` / `category.$categoryId.tsx` 同型）。
 *
 * 为什么读生成文件文本而不是渲染：全仓没有 DOM 测试基建——`features/chat/realtime.ts` 在模块加载期
 * 就读 `window`，导入 app 图即报 `window is not defined`，而本仓不允许为此引入新依赖。
 * 这里检查的是「谁是父路由」这一唯一事实，文本断言足够且不依赖任何运行时环境。
 */
async function routeTreeSource(): Promise<string> {
  return Bun.file(new URL('./routeTree.gen.ts', import.meta.url)).text()
}

/** 取某条生成路由的 `getParentRoute` 目标。 */
function parentOf(source: string, routeName: string): string | undefined {
  const block = source.slice(source.indexOf(`const ${routeName} = `))
  if (block === '') return undefined
  return block.match(/getParentRoute: \(\) => (\w+)/)?.[1]
}

describe('后台路由结构', () => {
  test('详情路由挂在后台布局下', async () => {
    const source = await routeTreeSource()
    expect(parentOf(source, 'AdminUsersUserIdRoute')).toBe('AdminRoute')
    expect(parentOf(source, 'AdminListingsListingIdRoute')).toBe('AdminRoute')
  })

  test('列表页是 index 路由，且没有页面路由充当父路由', async () => {
    const source = await routeTreeSource()
    expect(parentOf(source, 'AdminUsersIndexRoute')).toBe('AdminRoute')
    expect(parentOf(source, 'AdminListingsIndexRoute')).toBe('AdminRoute')
    // 旧结构残留：列表页作为 layout 存在时，详情路由会被挂到它下面。
    expect(source).not.toContain('getParentRoute: () => AdminUsersRoute')
    expect(source).not.toContain('getParentRoute: () => AdminListingsRoute')
  })
})
