import { expect, test } from 'bun:test'
import {
  INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES,
  INDEPENDENT_HOLDOUT_O_SAMPLES,
} from './independent-holdout-o-fixture'

// 验证的是审批输入转写，不运行算法，不提前暴露独立组分数。
test('O fixture逐字段等于Owner批准的表格，元转整数分且所有标签保留', async () => {
  const doc = await Bun.file(
    new URL('../../../../../docs/design/issue-322-matching-v2-holdout-3.md', import.meta.url),
  ).text()
  const inputTable = doc.split('## 输入与建议标签')[1]?.split('建议标签13是/11否')[0]
  if (!inputTable) throw new Error('缺少批准输入表')
  const approved = inputTable
    .split('\n')
    .filter((line) => /^\| O\d\d \|/u.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
      const [id, wishText, wishSettings, listingText, listingSettings, label] = cells
      if (!id || !wishText || !wishSettings || !listingText || !listingSettings || !label)
        throw new Error('表格字段缺失')
      const [keyword, wishDescription] = wishText.split(' / ')
      const [category, budget, acceptSimilar] = wishSettings.split(' / ')
      const [title, description] = listingText.split(' / ')
      const [listingCategory, price] = listingSettings.split(' / ')
      return {
        id,
        wish: {
          keyword,
          description: wishDescription === '—' ? null : wishDescription,
          category: category === '不限' ? null : category,
          budgetMaxCents: Math.round(Number(budget) * 100),
          acceptSimilar: acceptSimilar === 'true',
        },
        listing: {
          title,
          description,
          category: listingCategory,
          priceCents: Math.round(Number(price) * 100),
        },
        expectMatch: label === '是',
      }
    })
  expect(approved).toHaveLength(24)
  // 文档解析结果是外部形状；比较完整运行时结构，不把它断言成生产事实类型。
  expect<unknown>(INDEPENDENT_HOLDOUT_O_SAMPLES).toEqual(approved)
})

// Owner 裁决的披露不得悄悄消失：已知口径分歧必须同时存在于文档与常量里，且只列 O16。
test('O16 已知口径分歧在文档里显式披露，且常量与之一致', async () => {
  const doc = await Bun.file(
    new URL('../../../../../docs/design/issue-322-matching-v2-holdout-3.md', import.meta.url),
  ).text()
  expect(doc).toContain('O16 是 Owner 裁决显式披露的已知口径分歧')
  expect(doc).toContain('summary.knownDivergenceIds')
  expect([...INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES]).toEqual(['O16'])
})
