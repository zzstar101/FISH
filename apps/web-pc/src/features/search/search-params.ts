import {
  type ListingCategory,
  ListingCategorySchema,
  type ListingSort,
  ListingSortSchema,
} from '@fish/contracts/listings/schema'

export type PcSearchParams = {
  q?: string
  category?: ListingCategory
  sort?: ListingSort
  /**
   * 「免费送」筛选（#451）。单档开关：`true` = 只看免费送，`undefined` = 不过滤。
   * 没有「只看非免费送」那一档——契约支持 `free=false`，但 web-pc 不提供该选项。
   */
  free?: boolean
}

/** URL 是筛选条件的恢复源；非法值和超长关键词回退，而不是把错误留给请求层。 */
export function parseSearchParams(search: Record<string, unknown>): PcSearchParams {
  const rawQ = typeof search.q === 'string' ? search.q.trim() : ''
  const category = ListingCategorySchema.safeParse(search.category)
  const sort = ListingSortSchema.safeParse(search.sort)
  /**
   * 只有 `true` 打开筛选；其余（含 `false` 与任意垃圾值）一律回退成「不过滤」。
   * 不把 `false` 解成 `free = false`：那样会出现「chip 未选中、列表却在筛非免费送」
   * 的自相矛盾界面——而 web-pc 根本没有那一档入口。
   *
   * **为什么同时收 `true` 和 `'true'`**：本函数的入参不是 URL 字符串，而是
   * TanStack Router 已经解析过的对象。默认 `parseSearch`（`defaultParseSearch =
   * parseSearchWith(JSON.parse)`，见 `router-core/dist/esm/searchParams.js`）会经 qss 的
   * `toValue()` 把 `"true"` / `"false"` 转成**布尔**——实测 `defaultParseSearch('?free=true')`
   * 返回 `{ free: true }`（boolean）。只判 `=== 'true'` 会永远不成立，chip 点不动、
   * URL 直开也不生效（#451 审查轮 1 抓到的 P0）。字符串分支保留给裸字符串调用方
   * （测试 / 将来的非路由调用），不依赖路由行为。
   */
  const free = search.free === true || search.free === 'true'

  return {
    q: rawQ.length > 0 ? rawQ.slice(0, 50) : undefined,
    category: category.success ? category.data : undefined,
    sort: sort.success ? sort.data : undefined,
    free: free ? true : undefined,
  }
}
