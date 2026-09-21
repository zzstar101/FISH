import type { WishHitList } from '@/features/fetchers'
import type { MockWish } from '@/mock/types'

/**
 * 「我的愿望」卡片上命中入口的形态。
 *
 * 为什么抽成纯函数：这段门禁被独立审查反复抓到「数字对不上 / 该有反馈却静默」的问题
 * （终态给了死链接、命中请求失败时静默、0 命中时丢掉提示）。组件层没有测试基建
 * （见 `pages/home/list-state.ts` 的同一取舍），判定放这里锁住。
 *
 * - `linked`：许愿中且拿到了权威命中列表（`/matches` 的 `total > 0`）→ 可点进结果页
 * - `empty`：许愿中且**确定**当前没有命中（拿到的 `total = 0`，或契约 `matchCount = 0`
 *   因此没发请求）→ 可点出「还没命中」提示
 * - `unavailable`：许愿中但命中列表没取到、且 `matchCount > 0` → 计数只是回退值，
 *   既不跳转（数字可能对不上）、也不误报「没命中」
 * - `none`：终态愿望 —— `/matches` 对非 ACTIVE 愿望恒为空，不给入口
 */
export type WishHitLink = 'linked' | 'empty' | 'unavailable' | 'none'

export function wishHitLink(
  wish: Pick<MockWish, 'status' | 'matchCount'>,
  hitList: WishHitList | undefined,
): WishHitLink {
  if (wish.status !== 'ACTIVE') return 'none'
  if (hitList === undefined) return wish.matchCount === 0 ? 'empty' : 'unavailable'
  return hitList.total > 0 ? 'linked' : 'empty'
}
