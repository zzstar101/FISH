/**
 * 「我的关注」的统计口径（纯函数）。
 *
 * 稿的统计行是 `关注 5 人 · 互粉 2 人`，**两个数字都必须从正在渲染的那份列表现算**：
 * 旁路读一份「汇总」会在列表与统计之间造出不一致（`pages/watchers` 的 #139 review
 * 就是这条 —— 列表 8 行 / 共 7 人想要）。这里只做一件事：给同一份数组，返回它的两个计数。
 */
import type { FollowingPerson } from './demo'

export type FollowingStats = {
  /** 关注人数（= 列表行数） */
  count: number
  /** 其中互相关注（双向）的人数 */
  mutual: number
}

export function followingStatsOf(people: FollowingPerson[]): FollowingStats {
  return {
    count: people.length,
    mutual: people.filter((person) => person.mutual).length,
  }
}
