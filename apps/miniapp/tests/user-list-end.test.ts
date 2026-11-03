import { describe, expect, test } from 'bun:test'
import { userListEnd } from '../src/pkg-browse/pages/user/list-end'
import { mergeSegmentPage } from '../src/pkg-browse/pages/user/segment-page'

/**
 * 他人主页「列表终点提示」的判定（#178 审查收口）。
 *
 * 上一轮审查点名的缺陷：页面在 `items.length > 0` 时无条件渲染「已经到底了」，
 * 而列表是**分页**读取的（`fetchPublicUserListings` 的 `PAGE_SIZE = 50`；#565 起滚到底
 * 还会按游标续拉，所以「已展示条数」只是手上这一份，随时可能少于真总数）。
 * `total > items.length` 时还有商品没展示，那句提示就是错的。
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
 * 页面接线（读源码，同目录先例 `tests/mylist-relist.test.ts`、`tests/back-top-scroll-source.test.ts`）。
 *
 * 纯函数用例锁不住「页面是不是真的用它」：实测把页面改回无条件的
 * `loadState === 'ok' && items.length > 0 → 已经到底了`（正是上一轮审查点名的写法），
 * 上面的用例照样全绿。本仓 `tests/` 没有 Taro 组件渲染基建，只能读源码断言。
 */
/**
 * 分段列表的合并（#565 复核 M1）：早先这条判定只写在页面里，用例读源码字符串断言，
 * 结果是「闩立即放开」「去重写坏」两个变异全都能绿 —— 钉不住行为。合并规则抽成
 * `pkg-browse/pages/user/segment-page.ts` 的纯函数后，用样本直接钉两种翻页语义与去重。
 */
describe('mergeSegmentPage —— 分段列表的合并与去重', () => {
  type Item = { id: string }
  const page = (ids: string[], nextCursor: string | null) => ({
    listings: ids.map((id) => ({ id })),
    nextCursor,
  })
  const ids = (items: Item[]) => items.map((item) => item.id)

  test('首屏（cursor === null）覆盖已展示内容，并取新游标', () => {
    const merged = mergeSegmentPage({ items: [{ id: 'a' }] }, page(['b', 'c'], 'c2'), null)
    expect(ids(merged.items)).toEqual(['b', 'c'])
    expect(merged.nextCursor).toBe('c2')
  })

  test('续页（cursor !== null）追尾，不吃掉已展示的旧页', () => {
    const merged = mergeSegmentPage({ items: [{ id: 'a' }, { id: 'b' }] }, page(['c'], 'c3'), 'c2')
    expect(ids(merged.items)).toEqual(['a', 'b', 'c'])
    expect(merged.nextCursor).toBe('c3')
  })

  test('同一条游标被并发打两次：迟到的同页响应不追加第二遍', () => {
    const first = mergeSegmentPage({ items: [{ id: 'a' }] }, page(['b'], 'b2'), 'a1')
    const late = mergeSegmentPage(first, page(['b'], 'b2'), 'a1')
    expect(ids(late.items)).toEqual(['a', 'b'])
  })

  test('迟到的响应里混着新条目：按 id 去重后追加，不重复、不丢旧页', () => {
    const first = mergeSegmentPage({ items: [] }, page(['a', 'b'], 'b2'), 'a1')
    const late = mergeSegmentPage(first, page(['b', 'c'], 'b2'), 'a1')
    expect(ids(late.items)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * 把源码里的换行与缩进压成单空格，便于对大括号块的**形状**做断言。
 *
 * 只看「`mergeSegmentPage(...)` 出现过」是不够的：在它后面接一句 `.items` 取值、
 * 或把 `loaded: true` 删掉，字符串都还在，而页面已经坏掉（前者丢掉游标 → `hasMore`
 * 恒真、滚到底反复拉同一页；后者让分段永远停在骨架屏）。
 */
function flatten(code: string): string {
  return code.replace(/\s+/g, ' ')
}

describe('user 页面接线', () => {
  const source = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()

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
    // #565：`PublicUserResult` 的下一页信号就是契约游标本身（`nextCursor`），
    // 页面把它原样存进分段状态，不再有「hasMore 布尔」这一层转手
    expect(code).toContain('result.nextCursor')
  })

  test('滚到底的重入靠同步 ref 闩互斥，合并交给纯函数（#565 复核 M2）', async () => {
    const code = await source
    // `pages[seg].loading` 是渲染快照：同一帧里连点两次滚到底（或切段与滚底撞在同一帧），
    // 两次回调读到的都是上一次渲染的 `loading: false`，会拿同一条游标并发打两次接口。
    // 互斥必须**先同步置位**（compare-and-set），不能靠读 state 决定要不要发。
    expect(code).toContain('if (inFlight.current[which]) return')
    expect(code).toContain('inFlight.current[which] = true')
    expect(code).toContain('inFlight.current[which] = false')
    // 合并（覆盖 / 追尾 / 按 id 去重）由 `mergeSegmentPage` 承担，行为在纯函数用例里钉住。
    expect(code).toContain('mergeSegmentPage(prev[which], page, cursor)')
  })

  test('合并结果整体展开进分段状态：游标与三态是同一次写回（#565 复核 M1）', async () => {
    const code = flatten(await source)
    // 只取 `.items`（`items: mergeSegmentPage(...).items`）会丢掉 `nextCursor`：
    // `hasMore` 恒真 → 滚到底拿同一游标反复请求，去重又把条目全滤掉 → 列表静止、网络空转。
    // 删掉 `loaded: true` 则分段永远停在骨架屏。整块形状一次钉住两条写回。
    expect(code).toContain(
      '[which]: { ...mergeSegmentPage(prev[which], page, cursor), loaded: true, loading: false, failed: false, }',
    )
  })
})
