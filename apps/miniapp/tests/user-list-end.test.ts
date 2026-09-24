import { describe, expect, test } from 'bun:test'
import { userListEnd } from '../src/pages/user/list-end'

/**
 * 他人主页「列表终点提示」的判定（#178 审查收口）。
 *
 * 上一轮审查点名的缺陷：页面在 `items.length > 0` 时无条件渲染「已经到底了」，
 * 而在售列表有**单页上限**（`fetchPublicUserListings` 的 `PAGE_SIZE = 50`）。
 * `activeCount > items.length` 时还有商品没展示，那句提示就是错的。
 *
 * 这里锁的是「什么时候不许说已经到底」：只要服务端游标说还有下一页、或真总数大于
 * 已展示条数，就必须退到 `partial`（页面渲染「仅显示最近 N 件」）。
 */
describe('userListEnd —— 列表终点判定', () => {
  test('一件都没有：不给终点提示（空态由页面自己承担）', () => {
    expect(userListEnd(0, 0, false)).toBe('none')
  })

  test('全部加载完（游标没有下一页、条数等于真总数）：可以说「已经到底了」', () => {
    expect(userListEnd(7, 7, false)).toBe('end')
  })

  test('超过单页上限：真总数大于已展示条数 —— 不得宣称到底', () => {
    // 审查点名的组合：50 条已展示，服务端说 TA 有 63 件在售
    expect(userListEnd(50, 63, true)).toBe('partial')
  })

  test('游标说还有下一页：即便条数与真总数相等也不能说到底', () => {
    // 两次查询之间的竞态（这期间又上架了几件），游标是唯一权威信号
    expect(userListEnd(20, 20, true)).toBe('partial')
  })

  test('展示条数多于真总数：两次查询之间的下架竞态，按已到底处理', () => {
    // 不谎报「还有更多」—— 手上这份列表已经覆盖了服务端当时报的总数
    expect(userListEnd(30, 28, false)).toBe('end')
  })

  test('边界：恰好一条且就是全部', () => {
    expect(userListEnd(1, 1, false)).toBe('end')
  })
})

/**
 * 页面接线（读源码，先例 `apps/web/src/profile-verification.test.ts`）。
 *
 * 纯函数用例锁不住「页面是不是真的用它」：实测把页面改回无条件的
 * `loadState === 'ok' && items.length > 0 → 已经到底了`（正是上一轮审查点名的写法），
 * 上面的用例照样全绿。本仓 `tests/` 没有 Taro 组件渲染基建，只能读源码断言。
 */
describe('user 页面接线', () => {
  const source = Bun.file(new URL('../src/pages/user/index.tsx', import.meta.url)).text()

  test('终点提示由 userListEnd 判定，两个信号都传进判定', async () => {
    const code = await source
    expect(code).toContain('userListEnd(items.length')
    expect(code).toContain('hasMore')
  })

  test('「已经到底了」只挂在 end 分支上，partial 说的是「仅显示最近 N 件」', async () => {
    const code = await source
    expect(code).toContain("end === 'end'")
    expect(code).toContain("end === 'partial'")
    expect(code).toContain('仅显示最近')
    // 上一轮审查点名的写法是「条数大于 0 就宣称到底」。那句提示在 JSX 文本节点里只能
    // 出现**一次**（end 分支）；只数裸字符串会被本文件/页面自己的注释骗过，所以按
    // `>已经到底了<` 这个文本节点形状数。
    expect((code.match(/>\s*已经到底了\s*</g) ?? []).length).toBe(1)
  })

  test('列表是否有下一页取自读取层的游标结果，不靠条数猜', async () => {
    const code = await source
    expect(code).toContain('result.hasMore')
  })
})
