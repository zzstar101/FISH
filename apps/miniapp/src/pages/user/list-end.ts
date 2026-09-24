/**
 * 他人主页「列表终点提示」的判定（#178 审查收口）。
 *
 * 在售列表是**单页**读取（`fetchPublicUserListings` 取满一页 50 条就停，本页没有
 * 无限滚动），所以「已经到底了」成立需要**两个独立信号都点头**：
 *
 * 1. 服务端游标说没有下一页（`hasMore === false`）—— 列表本身就是完整的；
 * 2. 这份列表的条数不少于服务端报的在售真总数 `activeCount`（与页头「在售」同一口径）。
 *
 * 任一条不成立就不能宣称「TA 就这些」：只按条数判断会在超过单页上限时把「还有 13 件
 * 没展示」说成「已经到底了」（上一轮审查点名的那条）。
 *
 * 抽成纯函数只为可测：本仓 `tests/` 没有 Taro 组件渲染基建，页面组件锁不住
 * （先例 `pages/home/list-state.ts`、`pages/mylist/list.ts`）。
 */
export type UserListEnd = 'none' | 'end' | 'partial'

/**
 * @param shown 当前已展示的条数（`items.length`）
 * @param activeCount 服务端给的在售总数（`profile.activeCount`）
 * @param hasMore 服务端游标说还有下一页（`PublicUserResult.hasMore`）
 *
 * 边界：`shown > activeCount` 是两次查询之间的竞态（这期间有商品被下架/售出），
 * 只要没有下一页就按「已到底」处理 —— 手上这份列表已经覆盖了服务端当时报的总数，
 * 不谎报「还有更多」。
 */
export function userListEnd(shown: number, activeCount: number, hasMore: boolean): UserListEnd {
  if (shown === 0) return 'none'
  return hasMore || activeCount > shown ? 'partial' : 'end'
}
