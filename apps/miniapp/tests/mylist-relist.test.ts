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

/** 取两个标记之间的源码片段（按出现顺序），找不到就抛 —— 让断言失败指向「结构变了」 */
function sliceBetween(code: string, startMarker: string, endMarker: string): string {
  const start = code.indexOf(startMarker)
  expect(start).toBeGreaterThan(-1)
  const end = code.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return code.slice(start, end)
}

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

/**
 * 下架 / 删除两条动作链的接线（与上面 relist 同一套源码断言）。
 *
 * 两条链都会在 await 之后改界面（摘卡 / 切段 / 弹 toast）。换号发生在请求在飞期间时，
 * 那些改动与提示会落到**新账号**的界面上 —— B 会看到一句「已删除」，而他什么都没删。
 * 判据与商品列表 / 待确认索引 / relist 同一把尺子：await 之后校验代次。
 */
describe('mylist 下架 / 删除链的账号代次收口', () => {
  test('确认下架在 await 之后校验代次，迟到响应不落到新账号的界面', async () => {
    const code = await page()
    const chain = sliceBetween(
      code,
      'const confirmOffline = () => {',
      'const confirmDelete = () => {',
    )
    expect(chain).toContain('offlineListing(')
    // await 之后、改界面之前必须有代次校验
    const awaitAt = chain.indexOf('await offlineListing(')
    const guard = chain.indexOf('if (epoch !== loadEpoch.current) return')
    expect(guard).toBeGreaterThan(awaitAt)
    expect(guard).toBeLessThan(chain.indexOf('applyTransition(detail)'))
    expect(guard).toBeLessThan(chain.indexOf("toast('已下架')"))
  })

  test('确认删除在 await 之后校验代次，且失败与成功两条路都被守住', async () => {
    const code = await page()
    const chain = sliceBetween(code, 'const confirmDelete = () => {', 'const openConversation =')
    const awaitAt = chain.indexOf('await deleteListing(')
    const guard = chain.indexOf('if (epoch !== loadEpoch.current) return')
    expect(guard).toBeGreaterThan(awaitAt)
    expect(guard).toBeLessThan(chain.indexOf('setCards('))
    expect(guard).toBeLessThan(chain.indexOf("toast('已删除')"))
    // catch 分支（409 重拉 / 失败 toast）同样要先过代次：否则 B 会收到 A 的失败提示
    const catchAt = chain.indexOf('} catch (error) {')
    expect(chain.indexOf('if (epoch !== loadEpoch.current) return', catchAt)).toBeGreaterThan(
      catchAt,
    )
  })

  test('删除成功后本地摘卡，并把待确认索引里那一条一起清掉', async () => {
    const code = await page()
    const chain = sliceBetween(code, 'const confirmDelete = () => {', 'const openConversation =')
    expect(chain).toContain('prev.filter((card) => card.id !== target.listing.id)')
    // 索引是按商品 id 取的：留着已删商品的 id 就是幽灵数据（今天不影响渲染，明天会）
    expect(chain).toContain('proposals.delete(target.listing.id)')
    expect(chain).toContain('conversationIds.delete(target.listing.id)')
  })

  test('蒙层关闭与「取消」同义：submit 一并复位，失败态不串到下一次弹层', async () => {
    const code = await page()
    // 两种动作共用一个 submit；点蒙层只 setConfirming(null) 的话，
    // 上一次失败的「重试」会出现在下一次打开的另一个动作的弹层上
    const scrim = sliceBetween(code, 'className="ml__scrim"', '/>')
    expect(scrim).toContain('setConfirming(null)')
    expect(scrim).toContain("setSubmit('idle')")
  })

  test('三个动作的按钮判据来自 list.ts 的纯函数，不在 JSX 里各写一份状态条件', async () => {
    const code = await page()
    const acts = sliceBetween(code, 'className={`ml__acts', 'className="ml__fab"')
    expect(acts).toContain('item.canEdit')
    expect(acts).toContain('item.canOffline')
    expect(acts).toContain('item.canDelete')
    // 「不过审」这个子状态在渲染层只应作为**数据**出现（胶囊文案来自 list.ts），
    // 不该再写一遍 `segment === 'review' && moderation === 'BLOCKED'` 这类条件
    expect(acts).not.toContain("item.moderation === 'BLOCKED'")
  })
})
