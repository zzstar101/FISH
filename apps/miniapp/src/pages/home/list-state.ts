import type { ListingCategory } from '@fish/contracts/listings/schema'

/**
 * 首页商品区的状态机（#137：分类在首页页内切换）。
 *
 * 为什么抽成纯函数：这个状态机已经连续三次被独立审查抓到同族缺陷 ——
 * 旧商品冒充新分类（2ff5de4）、失败假空态（c7ec13d）、失败后 `loadedFor`
 * 未失效导致重试期间又显示假空态（#137 rebase 后审查）。组件里的 inline
 * 判断没法单测，每次只能靠人眼复审；抽出来后每种组合都有用例锁住。
 */
export type HomeListState = 'error' | 'skeleton' | 'empty' | 'list'

/**
 * 当前该渲染哪一种形态。入参就是组件的四个事实，函数只做判定、不碰状态。
 *
 * 优先级（与组件 render 分支一致）：
 * 1. `failed` → 错误态。「加载不出来」不是「恰好没有商品」，必须先于一切。
 * 2. `loadedFor !== category` → 骨架屏。屏幕上的列表还没对上用户选的分类：
 *    既不能继续展示上一个分类的商品（旧数据冒充新分类），也不能显示空态
 *    （「没货」是**成功之后**才能说的结论）。首次进页 `loadedFor` 为 `null`
 *    也走这支，否则会先闪一下空态再出商品。
 * 3. 商品数为 0 → 空态。只有成功拿到空列表才能说「这个分类还没有闲置」。
 */
export function homeListState(input: {
  /** 已成功上屏的列表属于哪个分类；`null` = 从没成功加载过，或上一次失败已作废 */
  loadedFor: ListingCategory | 'ALL' | null
  /** 用户当前选中的分类（`ALL` = 首页「推荐」） */
  category: ListingCategory | 'ALL'
  /** 当前这次加载是否失败（生产口径：真实接口挂且没有 mock 回退） */
  failed: boolean
  /** 已成功上屏的商品数 */
  itemCount: number
}): HomeListState {
  if (input.failed) return 'error'
  if (input.loadedFor !== input.category) return 'skeleton'
  return input.itemCount === 0 ? 'empty' : 'list'
}

/**
 * 一次加载结束后的三件套结转（组件 `load()` 的 await 尾巴）。
 *
 * 组件在过期检查之后调用它，把三个 setState 变成一次纯计算：
 * - `items` 永远是这批结果（失败时是空数组 —— 失败即清屏，与修复前一致）；
 * - `failed` 透传；
 * - `loadedFor` 由 `resolveLoadedFor` 决定（修复点：失败作废，见下）。
 *
 * 「失败后重试在途 → 骨架屏」这条链只有整个函数都在测试里才能锁住：
 * 单测 `homeListState` 锁不住它（`loadedFor: null` 的形状在修复前后都说得通），
 * 单测 `resolveLoadedFor` 锁不住组件接线。三者放在一起跑，才是用户可见的那条路径。
 */
export function applyLoadResult<T>(result: {
  /** 这次加载请求的分类 */
  requested: ListingCategory | 'ALL'
  /** 这批结果；失败时是空数组 */
  items: T[]
  /** 这次加载是否失败（生产口径） */
  failed: boolean
}): {
  items: T[]
  failed: boolean
  loadedFor: ListingCategory | 'ALL' | null
} {
  return {
    items: result.items,
    failed: result.failed,
    loadedFor: resolveLoadedFor(result.requested, result.failed),
  }
}

/**
 * `loadedFor` 的结转规则（#137 rebase 审查 P1 的修复点）。
 *
 * 成功 → 记住这批商品属于 `requested`；**失败 → 作废为 `null`**：失败时
 * `items` 已被清成空数组，屏幕上没有属于任何分类的有效数据。若失败时保留
 * 旧值，当失败的目标分类恰是上次成功过的那个时（失败后点「重试」、下拉刷新
 * 失败后重试、失败后切回该分类），`loadedFor === category` 成立，请求在途期间
 * `failed` 已清、`items` 仍为空 → 渲染空态「这个分类还没有闲置」，
 * 把「没读到」说成「这个分类没货」。
 */
export function resolveLoadedFor(
  requested: ListingCategory | 'ALL',
  failed: boolean,
): ListingCategory | 'ALL' | null {
  return failed ? null : requested
}
