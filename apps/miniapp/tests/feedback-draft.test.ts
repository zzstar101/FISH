import { describe, expect, test } from 'bun:test'
import {
  FEEDBACK_TYPE_KEYS,
  isFeedbackTypeKey,
  parseFeedbackDraft,
} from '../src/pkg-legal/pages/feedback/draft'

/**
 * 意见反馈本机暂存的解析。
 *
 * 只测纯函数：`Taro.getStorageSync` 只能在端上跑，所以页面里剩下的那一步
 * （取值 + try/catch）不在单测范围内 —— 与 `sell-form.test.ts` 同一说明。
 */

describe('parseFeedbackDraft —— 本机暂存 → 草稿', () => {
  test('weapp 形态：getStorageSync 直接给对象', () => {
    expect(parseFeedbackDraft({ type: 'dispute', desc: '一直转圈', contact: '微信 abc' })).toEqual({
      type: 'dispute',
      desc: '一直转圈',
      contact: '微信 abc',
    })
  })

  test('H5 形态：getStorageSync 给的是 JSON 字符串', () => {
    const raw = JSON.stringify({ type: 'bug', desc: '点不动', contact: '' })
    expect(parseFeedbackDraft(raw)).toEqual({ type: 'bug', desc: '点不动', contact: '' })
  })

  test('空草稿返回 null —— 三个字段都空时不该弹「已恢复上次未提交的内容」', () => {
    expect(parseFeedbackDraft({ type: '', desc: '', contact: '' })).toBeNull()
    expect(parseFeedbackDraft({})).toBeNull()
  })

  test('单个字段坏掉只丢那一个，不整份丢掉（用户写下的正文比类型选择值钱）', () => {
    expect(parseFeedbackDraft({ type: '不存在的类型', desc: '正文还在', contact: 42 })).toEqual({
      type: '',
      desc: '正文还在',
      contact: '',
    })
  })

  test('坏 JSON / 非对象 / 空值一律返回 null，不抛', () => {
    expect(parseFeedbackDraft('{不是 json')).toBeNull()
    expect(parseFeedbackDraft('null')).toBeNull()
    expect(parseFeedbackDraft('"字符串"')).toBeNull()
    expect(parseFeedbackDraft(['bug'])).toBeNull()
    expect(parseFeedbackDraft(undefined)).toBeNull()
    expect(parseFeedbackDraft(null)).toBeNull()
  })
})

describe('isFeedbackTypeKey —— 类型键守卫', () => {
  test('只认清单里的键，其余（含非字符串）一律否', () => {
    for (const key of FEEDBACK_TYPE_KEYS) expect(isFeedbackTypeKey(key)).toBe(true)
    expect(isFeedbackTypeKey('feedback')).toBe(false)
    expect(isFeedbackTypeKey('')).toBe(false)
    expect(isFeedbackTypeKey(3)).toBe(false)
    expect(isFeedbackTypeKey(null)).toBe(false)
  })
})
