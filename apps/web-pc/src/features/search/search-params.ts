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
}

/** URL 是筛选条件的恢复源；非法值和超长关键词回退，而不是把错误留给请求层。 */
export function parseSearchParams(search: Record<string, unknown>): PcSearchParams {
  const rawQ = typeof search.q === 'string' ? search.q.trim() : ''
  const category = ListingCategorySchema.safeParse(search.category)
  const sort = ListingSortSchema.safeParse(search.sort)

  return {
    q: rawQ.length > 0 ? rawQ.slice(0, 50) : undefined,
    category: category.success ? category.data : undefined,
    sort: sort.success ? sort.data : undefined,
  }
}
