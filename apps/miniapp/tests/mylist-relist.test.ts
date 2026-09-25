import { describe, expect, test } from 'bun:test'

/**
 * 「再次上架」/「重新上架」的接线（#74 我的发布改版 × #208 账号作用域）。
 *
 * 本页的组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建），
 * 所以这里走 `sell-lifecycle.test.ts` 同款的**源码断言**：只读 `index.tsx` 文本，
 * 断言那几行关键语句确实在链上。边界与那边一样 —— 不证明运行时时序。
 *
 * 锁的是两条：
 *
 * 1. **这条链按代次收口**（#208 的不变量在 #74 新增链路上的漏守）。账号在
 *    `fetchListingDetail` 在飞期间切换（去 profile 页退出再登录成另一个人），detail 回来后
 *    仍会 `requestSellPrefill` —— 而交接是模块级变量、不带账号标记，出物页的渲染期清场救不了
 *    它（`useDidShow` 在清场之后才 `takeSellHandoff()`）。于是 A 的商品文案会出现在 B 的
 *    发布表单里。判据与商品列表 / 待确认索引同一把尺子：链内铸 `epoch`，await 之后校验。
 * 2. **预填字段取自详情而不是列表卡**。列表卡的投影（`toMockListing`）里没有 `description`
 *    （商品读模型不带描述），拿列表卡预填等于把描述悄悄丢掉。
 */

const page = (): Promise<string> =>
  Bun.file(new URL('../src/pages/mylist/index.tsx', import.meta.url)).text()

describe('mylist 「再次上架 / 重新上架」链的接线', () => {
  test('fetchListingDetail 在飞期间换了号：文案不得灌进新账号的表单', async () => {
    const code = await page()
    const relist = code.slice(code.indexOf('const relist = (row: Row) => {'))
    expect(relist).toContain('const epoch = loadEpoch.current')
    const awaitAt = relist.indexOf('await fetchListingDetail(')
    expect(awaitAt).toBeGreaterThan(relist.indexOf('const epoch = loadEpoch.current'))
    const guard = relist.indexOf('if (epoch !== loadEpoch.current) return')
    expect(guard).toBeGreaterThan(awaitAt)
    expect(guard).toBeLessThan(relist.indexOf('requestSellPrefill('))
    expect(guard).toBeLessThan(relist.indexOf('switchTab'))
  })

  test('预填的字段来自详情响应，不来自列表卡', async () => {
    const code = await page()
    const relist = code.slice(code.indexOf('const relist = (row: Row) => {'))
    expect(relist).toContain('const detail = await fetchListingDetail(row.listing.id)')
    expect(relist).toContain('title: detail.title')
    expect(relist).toContain('description: detail.description')
    expect(relist).toContain('priceCents: detail.priceCents')
    // 列表卡对象名（`card` / `toMockListing`）一个都不该出现在这条链里
    expect(relist.slice(0, relist.indexOf('requestSellPrefill('))).not.toContain('toMockListing')
  })

  test('两条路径合成一个函数：已售出的「再次上架」与已下架的「重新上架」都调它', async () => {
    const code = await page()
    const calls = code.match(/onClick=\{\(\) => relist\(item\)\}/g) ?? []
    expect(calls.length).toBe(2)
  })
})
