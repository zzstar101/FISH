import { describe, expect, test } from 'bun:test'
import type { ListingCard } from '@fish/contracts/listings/schema'
import { VISUAL_SEARCH_SORTS, VISUAL_SOLD_AVG_MIN_SAMPLES } from '@fish/contracts/visual/schema'
import {
  activeVisualSort,
  DEFAULT_VISUAL_SORT,
  queryCardCopy,
  resultStats,
  soldAvgText,
  VISUAL_SORT_OPTIONS,
  visualSortQuery,
} from '@/pkg-vision/pages/vision-result/view'

/**
 * 识图结果页的派生判据（设计稿 01–05 的状态覆盖）。
 *
 * 三块各有「看起来对、实际错」的写法，都必须钉住：
 * 1. **查询图卡文案**：`interpretation` 可能为 `null`（稿 05），也可能只有 `text`
 *    没有型号 / 品牌 —— 后者若直接渲染 `text` 会挤成一行，也不该编造「型号」；
 * 2. **两段统计**：识别中 / 空结果时价格区间必须是 `null`（页面渲染 `—`），
 *    把空结果写成「¥0–¥0」是把「没找到」说成「免费」；
 * 3. **排序与行情都不在客户端算**：五档标签必须与契约 `VISUAL_SEARCH_SORTS` 逐项对齐
 *    （这里是整套映射唯一的「期望值」副本，源码里不许再有第二份数组），
 *    成交均价则必须在样本不足时退化成 `—`（把 2 件样本的均价当行情展示是错的口径）。
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
    // 想要数（已建会话的买家数）：卡片契约的必填字段，夹具给 0（本用例不关心它）。
    wants: 0,
    views: 0,
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

describe('VISUAL_SORT_OPTIONS', () => {
  test('与契约 VISUAL_SEARCH_SORTS 同源同序（契约加档时这里必须动）', () => {
    expect(VISUAL_SORT_OPTIONS.map((option) => option.sort)).toEqual([...VISUAL_SEARCH_SORTS])
  })

  test('五档中文标签逐项对齐（错位 / 漏档都会失败）', () => {
    const labels = Object.fromEntries(VISUAL_SORT_OPTIONS.map((o) => [o.sort, o.label]))
    expect(labels).toEqual({
      relevance: '综合',
      popular: '热销',
      newest: '最新',
      price_asc: '价格',
      condition: '成色',
    })
  })

  test('标签两两不同（避免两档抄成同一个词）', () => {
    const labels = VISUAL_SORT_OPTIONS.map((option) => option.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.every((label) => label.length > 0)).toBe(true)
  })
})

describe('visualSortQuery / activeVisualSort', () => {
  test('一档都没点过（null）：请求体里整个 sort 键都不出现', () => {
    const body = visualSortQuery(null)
    expect('sort' in body).toBe(false)
    expect(Object.keys(body)).toHaveLength(0)
    // 序列化后的形状就是老客户端 / M9 回放脚本的形状
    expect(JSON.stringify(body)).toBe('{}')
  })

  test('点过档：原样带上契约 sort 码', () => {
    for (const sort of VISUAL_SEARCH_SORTS) {
      expect(visualSortQuery(sort)).toEqual({ sort })
    }
  })

  test('生效档：没点过时 = 契约缺省档，胶囊因此仍有一项是亮的', () => {
    const optionSorts = VISUAL_SORT_OPTIONS.map((option) => option.sort)
    expect(optionSorts).toContain(DEFAULT_VISUAL_SORT)
    expect(activeVisualSort(null)).toBe(DEFAULT_VISUAL_SORT)
    for (const sort of VISUAL_SEARCH_SORTS) {
      expect(activeVisualSort(sort)).toBe(sort)
    }
  })

  test('「没点过」与「显式点了缺省档」是两种请求形状', () => {
    expect(visualSortQuery(null)).not.toEqual(visualSortQuery(DEFAULT_VISUAL_SORT))
    expect(activeVisualSort(null)).toBe(activeVisualSort(DEFAULT_VISUAL_SORT))
  })
})

describe('soldAvgText', () => {
  test(`样本少于 ${VISUAL_SOLD_AVG_MIN_SAMPLES} 件：给 null（页面显示 —）`, () => {
    expect(soldAvgText({ soldAvgPriceCents: 4500, soldSampleCount: 2 })).toBeNull()
    expect(soldAvgText({ soldAvgPriceCents: 4500, soldSampleCount: 0 })).toBeNull()
  })

  test(`恰好 ${VISUAL_SOLD_AVG_MIN_SAMPLES} 件：开始展示`, () => {
    expect(soldAvgText({ soldAvgPriceCents: 4500, soldSampleCount: 3 })).toBe('¥45 · 3 件')
  })

  test('样本够但服务端没给均价（null）：仍然给 null，不兜底成 ¥0', () => {
    expect(soldAvgText({ soldAvgPriceCents: null, soldSampleCount: 9 })).toBeNull()
  })

  test('文案口径：千分位 + 币种 + 样本数', () => {
    expect(soldAvgText({ soldAvgPriceCents: 123456, soldSampleCount: 12 })).toBe(
      '¥1,234.56 · 12 件',
    )
  })

  test('阈值取自契约常量（不抄字面量 3）', () => {
    expect(
      soldAvgText({ soldAvgPriceCents: 100, soldSampleCount: VISUAL_SOLD_AVG_MIN_SAMPLES - 1 }),
    ).toBeNull()
    expect(
      soldAvgText({ soldAvgPriceCents: 100, soldSampleCount: VISUAL_SOLD_AVG_MIN_SAMPLES }),
    ).toBe(`¥1 · ${VISUAL_SOLD_AVG_MIN_SAMPLES} 件`)
  })
})
