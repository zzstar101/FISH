import { describe, expect, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { queryCardCopy, resultStats, sortResults } from '@/pages/vision-result/view'

/**
 * 识图结果页的派生判据（设计稿 01–05 的状态覆盖）。
 *
 * 三块各有「看起来对、实际错」的写法，都必须钉住：
 * 1. **查询图卡文案**：`interpretation` 可能为 `null`（稿 05），也可能只有 `text`
 *    没有型号 / 品牌 —— 后者若直接渲染 `text` 会挤成一行，也不该编造「型号」；
 * 2. **两段统计**：识别中 / 空结果时价格区间必须是 `null`（页面渲染 `—`），
 *    把空结果写成「¥0–¥0」是把「没找到」说成「免费」；
 * 3. **排序**：「综合」必须原样返回**同一个数组实例**（那是服务端的混合排序结果），
 *    本地再排一次就是降级；其余三档不能改动入参数组。
 */
function card(overrides: Partial<ListingCard> = {}): ListingCard {
  return {
    id: 'l-1',
    title: '高等数学 同济第七版',
    priceCents: 3800,
    category: 'BOOKS',
    condition: 'LIKE_NEW',
    status: 'ACTIVE',
    urgent: false,
    negotiable: false,
    free: false,
    coverUrl: null,
    createdAt: '2026-09-20T00:00:00.000Z',
    moderationStatus: null,
    ...overrides,
  } as ListingCard
}

describe('queryCardCopy', () => {
  test('型号优先于品牌与原文', () => {
    expect(
      queryCardCopy({
        text: 'AirPods Pro 2 降噪耳机',
        brand: 'Apple',
        model: 'AirPods Pro 2',
        category: 'DIGITAL',
        keywords: ['airpods', '降噪耳机'],
      }),
    ).toEqual({
      category: '数码电子',
      title: 'AirPods Pro 2',
      subtitle: '关键词 airpods · 降噪耳机',
    })
  })

  test('没有型号时用品牌，没有品牌时用原文', () => {
    expect(queryCardCopy({ brand: 'Apple', category: 'DIGITAL' }).title).toBe('Apple')
    expect(queryCardCopy({ text: '高等数学 同济第七版' }).title).toBe('高等数学 同济第七版')
  })

  test('interpretation 为 null：退化成「只看图找同款」，不编造结论', () => {
    expect(queryCardCopy(null)).toEqual({
      category: null,
      title: '只看图找同款',
      subtitle: '没读出图里的文字，按图片相似度匹配',
    })
  })

  test('只有分类 / 关键词（没有型号品牌原文）：给说明句，不留空标题', () => {
    expect(queryCardCopy({ category: 'BOOKS', keywords: ['考研'] })).toEqual({
      category: '教材书籍',
      title: '只看图找同款',
      subtitle: '关键词 考研',
    })
  })

  test('关键词为空数组时不渲染「关键词 」空壳', () => {
    expect(queryCardCopy({ text: '键盘', keywords: [] }).subtitle).toBe('键盘')
  })
})

describe('resultStats', () => {
  test('计数与价格区间', () => {
    expect(resultStats([card({ priceCents: 2200 }), card({ priceCents: 4500 })])).toEqual({
      count: 2,
      priceMinCents: 2200,
      priceMaxCents: 4500,
    })
  })

  test('空结果：价格区间为 null（不写成 ¥0–¥0）', () => {
    expect(resultStats([])).toEqual({ count: 0, priceMinCents: null, priceMaxCents: null })
  })

  test('单件：上下限同值', () => {
    expect(resultStats([card({ priceCents: 100 })])).toEqual({
      count: 1,
      priceMinCents: 100,
      priceMaxCents: 100,
    })
  })
})

describe('sortResults', () => {
  test('综合：原样返回同一个数组实例（服务端顺序，不本地重排）', () => {
    const items = [card({ id: 'a' }), card({ id: 'b' })]
    expect(sortResults(items, '综合')).toBe(items)
  })

  test('最新：按发布时间倒序，且不改动入参', () => {
    const older = card({ id: 'old', createdAt: '2026-09-01T00:00:00.000Z' })
    const newer = card({ id: 'new', createdAt: '2026-09-20T00:00:00.000Z' })
    const items = [older, newer]
    expect(sortResults(items, '最新').map((item) => item.id)).toEqual(['new', 'old'])
    expect(items.map((item) => item.id)).toEqual(['old', 'new'])
  })

  test('价格：从低到高', () => {
    const items = [card({ id: 'hi', priceCents: 9000 }), card({ id: 'lo', priceCents: 100 })]
    expect(sortResults(items, '价格').map((item) => item.id)).toEqual(['lo', 'hi'])
  })

  test('成色：全新 → 九成新 → 八成新 → 七成新', () => {
    const items = [
      card({ id: 'fair', condition: 'FAIR' }),
      card({ id: 'new', condition: 'NEW' }),
      card({ id: 'good', condition: 'GOOD' }),
      card({ id: 'like', condition: 'LIKE_NEW' }),
    ]
    expect(sortResults(items, '成色').map((item) => item.id)).toEqual([
      'new',
      'like',
      'good',
      'fair',
    ])
  })
})
