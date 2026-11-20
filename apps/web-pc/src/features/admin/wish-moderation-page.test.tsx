import { describe, expect, test } from 'bun:test'
import type { WishModerationQueueItem } from '@fish/contracts/wishes/moderation'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WishModerationItemCard } from './wish-moderation-page'

function item(overrides: Partial<WishModerationQueueItem>): WishModerationQueueItem {
  return {
    id: 'wmr_00000000-0000-4000-8000-000000000001',
    wishId: 'wsh_00000000-0000-4000-8000-000000000002',
    contentVersion: 1,
    keyword: '静音机械键盘',
    description: '九成新即可',
    currentKeyword: '静音机械键盘',
    currentDescription: '九成新即可',
    author: { id: 'usr_00000000-0000-4000-8000-000000000003', nickname: '小明' },
    machineDecision: 'REVIEW',
    provider: 'LOCAL',
    policyVersion: 'test',
    suggestion: 'Review',
    score: null,
    matchedRules: ['EXTERNAL_CONTACT'],
    matchedTermsMasked: ['加*信'],
    status: 'PENDING',
    decision: null,
    version: 0,
    createdAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  }
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, '')

describe('WishModerationItemCard（许愿待审队列）', () => {
  test('新建待审展示关键词、描述与命中词', () => {
    const html = renderToStaticMarkup(
      createElement(WishModerationItemCard, { item: item({}), onSelect: () => {} }),
    )
    const text = textOf(html)
    expect(text).toContain('小明')
    expect(text).toContain('静音机械键盘')
    expect(text).toContain('九成新即可')
    expect(text).toContain('加*信')
  })

  test('编辑待审同时展示线上旧值，避免管理员误以为新文案已生效', () => {
    const html = renderToStaticMarkup(
      createElement(WishModerationItemCard, {
        item: item({
          contentVersion: 2,
          keyword: '待审新关键词',
          description: null,
          currentKeyword: '线上旧关键词',
          currentDescription: null,
        }),
        onSelect: () => {},
      }),
    )
    const text = textOf(html)
    expect(text).toContain('待审新关键词')
    expect(text).toContain('线上仍为：线上旧关键词')
  })
})
