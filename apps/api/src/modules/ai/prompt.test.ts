import { describe, expect, test } from 'bun:test'
import { ListingCategorySchema } from '@fish/contracts/listings/schema'
import { buildPolishPrompt, categoryLabelFor, PROMPT_VERSION } from './prompt'

describe('润色 prompt', () => {
  test('每条硬约束都在系统提示词里（实测过的泄露与回填前提）', () => {
    const { system } = buildPolishPrompt({
      title: '罗技 K380',
      description: '全新未拆',
      category: 'DIGITAL',
    })

    expect(system).toContain('只输出描述正文本身')
    expect(system).toContain('不要复述"标题""分类""描述"这类字段名')
    expect(system).toContain('单独一行')
    expect(system).toContain('500 字')
    expect(system).toContain('不得新增或改动原文没有的事实')
    expect(system).toContain('必须原样保留')
    // 实测：原文带"加微信"而模型照抄时，每条候选都会命中 EXTERNAL_CONTACT → REVIEW → 整条丢弃，
    // 用户在发布页只会拿到"没有可用文案"。这条约束把这种情况压下去（服务端过滤仍然照常兜底）。
    expect(system).toContain('加微信')
    expect(system).toContain('有意者私聊')
  })

  test('八个分类都有中文标签，且提示词里不出现英文枚举值', () => {
    for (const category of ListingCategorySchema.options) {
      expect(categoryLabelFor(category)).toBeTruthy()
    }

    const { user } = buildPolishPrompt({ title: '教材', description: '九成新', category: 'BOOKS' })
    expect(user).toContain('商品分类：图书教材')
    expect(user).not.toContain('BOOKS')
  })

  test('标题与（已脱敏的）描述原样进提示词，标记不丢', () => {
    const { user } = buildPolishPrompt({
      title: '罗技 K380',
      description: '九成新，联系 [fish-phone-1]',
      category: 'DIGITAL',
    })

    expect(user).toContain('商品标题：罗技 K380')
    expect(user).toContain('九成新，联系 [fish-phone-1]')
  })

  test('版本号是常量，供 ai_polish_requests.prompt_version 落表', () => {
    expect(PROMPT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-v\d+$/)
  })
})
