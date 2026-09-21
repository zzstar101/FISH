/**
 * 愿望列表的翻页收集（不依赖网络 / Taro 的纯逻辑，便于直接测边界）。
 *
 * 为什么需要它：契约 `wishListQuerySchema` 把 `pageSize` 卡在 50，而愿望数没有上限
 * （同时 ACTIVE 限 10 条，CLOSED / FULFILLED 会一直累积）。只取第一页会让老愿望
 * 静默消失，而许愿页的 tab 与二级筛选计数都是从这份列表现算的 —— 截断会把计数一起说小。
 *
 * 收工条件：取满 `total`、或某页为空（`total` 与分页不一致时的兜底）。
 * `maxPages` 是防御性上限：`total` 异常时不至于死循环；真到上限会留一条 warn，
 * 不假装拿全了。
 */
export type WishPage<T> = { items: T[]; total: number }

export async function collectWishPages<T>(
  fetchPage: (page: number) => Promise<WishPage<T>>,
  maxPages: number,
): Promise<T[]> {
  const items: T[] = []
  let total = Number.POSITIVE_INFINITY
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await fetchPage(page)
    items.push(...payload.items)
    total = payload.total
    if (items.length >= total || payload.items.length === 0) return items
  }
  console.warn(`[miniapp] 愿望列表超过 ${maxPages} 页，只取到 ${items.length}/${total} 条`)
  return items
}
