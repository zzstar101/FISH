import { describe, expect, test } from 'bun:test'
import { collectWishPages } from '../src/features/wish/paging'

/**
 * 愿望列表翻页收集的边界（#89 接线时独立审查的 F1）。
 *
 * 契约把 `pageSize` 卡在 50，而愿望数没有上限（ACTIVE 限 10，终态会累积）。
 * 修复前只取第一页：55 条愿望里最老的 5 条静默消失，而页面上的 tab / 筛选计数
 * 是从这份列表现算的 —— 计数也跟着说小。这里锁住「按 total 取全」以及三种收工条件。
 */

/** 造一个分页数据源：按 50 一页切分，并记录请求过的页码 */
function pager(total: number, pageSize = 50) {
  const pages: number[] = []
  const all = Array.from({ length: total }, (_, index) => index + 1)
  return {
    pages,
    fetchPage: (page: number) => {
      pages.push(page)
      const start = (page - 1) * pageSize
      return Promise.resolve({
        items: all.slice(start, start + pageSize),
        total,
      })
    },
  }
}

describe('collectWishPages —— 按 total 取全', () => {
  test('55 条 → 取两页，返回全部 55 条', async () => {
    const { pages, fetchPage } = pager(55)

    expect(await collectWishPages(fetchPage, 20)).toHaveLength(55)
    expect(pages).toEqual([1, 2])
  })

  test('刚好 50 条 → 只取一页，不多发一次空请求', async () => {
    const { pages, fetchPage } = pager(50)

    expect(await collectWishPages(fetchPage, 20)).toHaveLength(50)
    expect(pages).toEqual([1])
  })

  test('空列表 → 取一页就收工', async () => {
    const { pages, fetchPage } = pager(0)

    expect(await collectWishPages(fetchPage, 20)).toEqual([])
    expect(pages).toEqual([1])
  })

  test('total 与分页不一致（空页）→ 立刻收工，不死循环', async () => {
    let calls = 0
    const items = await collectWishPages<number>((page) => {
      calls += 1
      return Promise.resolve({ items: page === 1 ? [1, 2] : [], total: 99 })
    }, 20)

    expect(items).toEqual([1, 2])
    expect(calls).toBe(2)
  })

  test('超过 maxPages → 停下来并返回已取到的部分（防御上限）', async () => {
    const { pages, fetchPage } = pager(1000)

    // 1000 条按 50/页 = 20 页，上限设 3 页 → 只取 150 条
    expect(await collectWishPages(fetchPage, 3)).toHaveLength(150)
    expect(pages).toEqual([1, 2, 3])
  })
})
