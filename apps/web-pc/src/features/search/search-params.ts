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
   * 只有字面量 `"true"` 打开筛选；其余（含 `"false"` 与任意垃圾值）一律回退成「不过滤」。
   * 不把 `"false"` 解成 `free = false`：那样会出现「chip 未选中、列表却在筛非免费送」
   * 的自相矛盾界面——而 web-pc 根本没有那一档入口。
   */
  const free = search.free === 'true'

  return {
    q: rawQ.length > 0 ? rawQ.slice(0, 50) : undefined,
    category: category.success ? category.data : undefined,
    sort: sort.success ? sort.data : undefined,
    free: free ? true : undefined,
  }
}
