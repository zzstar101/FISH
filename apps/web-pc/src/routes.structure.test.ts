import { describe, expect, test } from 'bun:test'

/**
 * 订单区路由结构守卫。
 *
 * `/orders` 同时是列表与 `/orders/$transactionId` 的父路径。父路由若直接渲染列表页，
 * 不带 `<Outlet />`，点击订单后 URL 会变化但详情永远不会挂载。
 */
async function routeTreeSource(): Promise<string> {
  return Bun.file(new URL('./routeTree.gen.ts', import.meta.url)).text()
}

function parentOf(source: string, routeName: string): string | undefined {
  const block = source.slice(source.indexOf(`const ${routeName} = `))
  if (block === '') return undefined
  return block.match(/getParentRoute: \(\) => (\w+)/)?.[1]
}

describe('订单区路由结构', () => {
  test('列表是 index 路由，详情与列表都挂在订单布局下', async () => {
    const source = await routeTreeSource()
    expect(parentOf(source, 'OrdersIndexRoute')).toBe('OrdersRoute')
    expect(parentOf(source, 'OrdersTransactionIdRoute')).toBe('OrdersRoute')
  })

  test('订单父路由只渲染子路由，不占用列表页', async () => {
    const source = await Bun.file(new URL('./routes/orders.tsx', import.meta.url)).text()
    expect(source).toContain('<Outlet />')
    expect(source).not.toContain('OrdersPage')
  })
})
