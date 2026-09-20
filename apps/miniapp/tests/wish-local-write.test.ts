import { beforeEach, describe, expect, test } from 'bun:test'
import {
  closeWishLocal,
  createWishLocal,
  myWishes,
  POOL_MIN_COUNT,
  wishPool,
} from '../src/mock/api'
import type { MockWish } from '../src/mock/types'
import { WISHES } from '../src/mock/wishes'

/**
 * 许愿页的本地写与愿望池聚合口径。
 *
 * 这一版给许愿页加了两个**没有后端**的本地写（发布 / 关闭，属 #89），并把愿望池
 * 从「前端常量榜单」改成按关键词聚合 —— 两处行为都要锁住：
 * 本地写之后列表与状态计数要跟着变；池子的 `wantCount` 数的是**不同用户**，
 * 且只输出 k-匿名达标（≥ `POOL_MIN_COUNT`）的条目。
 *
 * ⚠️ 本地写是**原地改模块级 fixture**（`mock/wishes.ts` 的 `WISHES`），所以每个用例
 * 前把 fixture 恢复成初始快照 —— 否则用例之间互相污染，单独跑某一条就会失败。
 * 注意 `myWishes()` 返回的是 `filter` 出来的**新数组**（元素仍是同一批对象），
 * 要还原必须直接改 `WISHES`。
 */

/** 初始快照（每条浅拷贝一份：本地写只改 `status`） */
const SNAPSHOT = WISHES.map((wish) => ({ ...wish }))

beforeEach(() => {
  // 原地还原：长度清零后逐条放回，保持数组身份不变（所有 importer 看到同一份）
  WISHES.length = 0
  for (const wish of SNAPSHOT) WISHES.push({ ...wish })
})

describe('愿望本地写', () => {
  test('关闭 ACTIVE 愿望：状态转 CLOSED，且不再算进「许愿中」', () => {
    const active = myWishes().filter((wish) => wish.status === 'ACTIVE')
    const target = active[0]
    expect(target).toBeDefined()
    if (!target) return

    expect(closeWishLocal(target.id)).toBe(true)
    expect(myWishes().find((wish) => wish.id === target.id)?.status).toBe('CLOSED')
    expect(myWishes().filter((wish) => wish.status === 'ACTIVE')).toHaveLength(active.length - 1)
  })

  test('终态愿望与不存在的 id 都关不掉，不误报成功', () => {
    const fulfilled = myWishes().find((wish) => wish.status === 'FULFILLED')
    expect(fulfilled).toBeDefined()
    if (!fulfilled) return

    expect(closeWishLocal(fulfilled.id)).toBe(false)
    expect(closeWishLocal('w-not-exist')).toBe(false)
  })

  test('发布愿望：进「我的愿望」，预算按分落库、状态 ACTIVE、匹配数 0', () => {
    const before = myWishes().length

    const created = createWishLocal({
      keyword: 'kindle paperwhite',
      category: 'DIGITAL',
      budgetMinCents: 30000,
      budgetMaxCents: 50000,
      description: undefined,
      acceptSimilar: true,
    })

    expect(myWishes()).toHaveLength(before + 1)
    expect(myWishes().some((wish) => wish.id === created.id)).toBe(true)
    expect(created.status).toBe('ACTIVE')
    expect(created.matchCount).toBe(0)
    expect(created.budgetMinCents).toBe(30000)
    expect(created.budgetMaxCents).toBe(50000)
    expect(created.description).toBeNull()
  })
})

describe('愿望池聚合口径', () => {
  test('只输出 k-匿名达标的条目（wantCount ≥ POOL_MIN_COUNT）', () => {
    const pool = wishPool()

    expect(pool.length).toBeGreaterThan(0)
    for (const item of pool) {
      expect(item.wantCount).toBeGreaterThanOrEqual(POOL_MIN_COUNT)
    }
  })

  test('按想要人数倒序，且人数有梯度（热度条才有意义）', () => {
    const counts = wishPool().map((item) => item.wantCount)

    expect(new Set(counts).size).toBeGreaterThan(1)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
  })

  test('常见预算是该关键词预算中位数（分）', () => {
    // fixture 里「考研数学」的预算是 40–60 元 → 中位 50 元 = 5000 分
    expect(wishPool().find((item) => item.keyword === '考研数学')?.medianBudgetCents).toBe(5000)
  })

  test('同一关键词的不同分类各自成组，不互相借人数', () => {
    // 「考研数学」在原 fixture 里是 6 人 / BOOKS；这里再补 1 人 / DIGITAL。
    // 只按 keyword 聚合的话两组会并成 7 人一条，且分类取决于谁先进 Map。
    WISHES.push({
      ...(WISHES[0] as MockWish),
      id: 'w-same-kw-other-cat',
      userId: 'u-same-kw-other-cat',
      keyword: '考研数学',
      category: 'DIGITAL',
      status: 'ACTIVE',
    })

    const pool = wishPool()
    const books = pool.find((item) => item.keyword === '考研数学' && item.category === 'BOOKS')
    const digital = pool.find((item) => item.keyword === '考研数学' && item.category === 'DIGITAL')

    // BOOKS 那条仍是自己的 6 人，没有被 DIGITAL 的人头撑大
    expect(books?.wantCount).toBe(6)
    // DIGITAL 只有 1 人 → k-匿名不达标，不出现；更不该借 BOOKS 的人数露出来
    expect(digital).toBeUndefined()
  })

  test('iPad / ipad 归一化后归入同一组（与服务端 keywordSchema 同口径）', () => {
    const before = wishPool().find((item) => item.keyword === 'iPad')
    expect(before?.wantCount).toBe(6)

    // 发布页入库前 `.trim().toLowerCase()`（契约 keywordSchema 同口径），所以小写输入
    // 必须落进已有的大写那组，而不是新开一条
    createWishLocal({
      keyword: 'ipad',
      category: before?.category ?? 'DIGITAL',
      budgetMinCents: 150000,
      budgetMaxCents: 170000,
      description: undefined,
      acceptSimilar: true,
    })

    const after = wishPool().filter((item) => item.keyword.toLowerCase() === 'ipad')
    // 仍只有一条（没有因大小写分裂成两条）
    expect(after).toHaveLength(1)
    // 原来 6 人 + 新 1 人 = 7 人（新用户是 `ME`，不在原池子里）
    expect(after[0]?.wantCount).toBe(7)
    /*
      展示写法必须仍是 fixture 的 `iPad`：本地发布走 `WISHES.unshift()`（新愿望在数组
      头部），展示词若取「谁先进 Map」就会被刚发的小写 `ipad` 改写。这里断言大小写，
      而不是只比 `.toLowerCase()` —— 后者会把这个问题遮住。
    */
    expect(after[0]?.keyword).toBe('iPad')
  })
})
