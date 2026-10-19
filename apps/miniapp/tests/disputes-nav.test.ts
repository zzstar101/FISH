import { describe, expect, test } from 'bun:test'

/**
 * 「我的争议」的**入站入口**（#497 审查 B1）。
 *
 * 页面注册在 `app.config.ts` 里不等于用户能到达 —— 首版就是「路由已声明、磁盘有目录、
 * 但没有任何地方跳过去」，静态检查全绿而功能不可达。`tests/route-literals.test.ts`
 * 只守「字面量已声明 / 目录存在」，守不住「有没有入口」，所以这里按源码断言补一条。
 *
 * 入口落在订单列表组件（`orders-buy` 与 `orders-sell` 共用）：个人中心 → 买到的 / 卖出的
 * → 争议，两步可达；个人中心的交易格是 5 列栅格，塞第 6 格会折行破版。
 */

const MY_DISPUTES = '/pkg-trade/pages/my-disputes/index'

async function source(path: string): Promise<string> {
  return await Bun.file(new URL(`../src/${path}`, import.meta.url)).text()
}

describe('争议页面的入站入口', () => {
  test('订单列表里有「交易争议」入口（两页共用组件）', async () => {
    const text = await source('components/order-list/index.tsx')
    expect(text).toContain(MY_DISPUTES)
    expect(text).toContain('交易争议')
  })

  test('订单详情页既能进详情（已有争议）也能进发起页', async () => {
    const text = await source('pkg-trade/pages/transaction-meetup/index.tsx')
    expect(text).toContain('/pkg-trade/pages/dispute-detail/index')
    expect(text).toContain('/pkg-trade/pages/dispute-create/index')
  })

  test('列表卡点开的是争议详情；通知 target 也落同一条详情', async () => {
    const list = await source('pkg-trade/pages/my-disputes/index.tsx')
    expect(list).toContain('/pkg-trade/pages/dispute-detail/index')
    const chat = await source('pages/chat/index.tsx')
    expect(chat).toContain('/pkg-trade/pages/dispute-detail/index')
  })
})
