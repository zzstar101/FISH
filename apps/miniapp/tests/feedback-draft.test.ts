import { describe, expect, test } from 'bun:test'
import { FEEDBACK_DRAFT_KEY, parseFeedbackDraft } from '../src/pkg-legal/pages/feedback/draft'

/**
 * 意见反馈本机暂存的解析。
 *
 * 只测纯函数：`Taro.getStorageSync` 只能在端上跑，所以页面里剩下的那一步
 * （取值 + 归属校验 + try/catch）不在单测范围内 —— 与 `sell-form.test.ts` 同一说明。
 */

describe('parseFeedbackDraft —— 本机暂存 → 草稿', () => {
  const ownerId = 'usr_01jc000000e008000000001qg0'

  test('weapp 形态：getStorageSync 直接给对象', () => {
    expect(
      parseFeedbackDraft({ ownerId, type: 'DISPUTE', desc: '一直转圈', contact: '微信 abc' }),
    ).toEqual({ ownerId, type: 'DISPUTE', desc: '一直转圈', contact: '微信 abc' })
  })

  test('H5 形态：getStorageSync 给的是 JSON 字符串', () => {
    const raw = JSON.stringify({ ownerId, type: 'BUG', desc: '点不动', contact: '' })
    expect(parseFeedbackDraft(raw)).toEqual({ ownerId, type: 'BUG', desc: '点不动', contact: '' })
  })

  test('空草稿返回 null —— 三个字段都空时不该弹「已恢复上次未提交的内容」', () => {
    expect(parseFeedbackDraft({ ownerId, type: '', desc: '', contact: '' })).toBeNull()
    expect(parseFeedbackDraft({ ownerId })).toBeNull()
    expect(parseFeedbackDraft({})).toBeNull()
  })

  test('旧格式（没有 ownerId）解析出 ownerId=null，由页面拒绝恢复', () => {
    expect(parseFeedbackDraft({ type: 'bug', desc: '旧草稿', contact: '' })).toEqual({
      ownerId: null,
      type: '',
      desc: '旧草稿',
      contact: '',
    })
  })

  test('单个字段坏掉只丢那一个，不整份丢掉（用户写下的正文比类型选择值钱）', () => {
    expect(
      parseFeedbackDraft({ ownerId, type: '不存在的类型', desc: '正文还在', contact: 42 }),
    ).toEqual({ ownerId, type: '', desc: '正文还在', contact: '' })
  })

  test('超长字段截断到存储上限', () => {
    const parsed = parseFeedbackDraft({ ownerId, type: 'UX', desc: 'x'.repeat(700), contact: '' })
    expect(parsed?.desc.length).toBe(600)
  })

  test('坏 JSON / 非对象 / 空值一律返回 null，不抛', () => {
    expect(parseFeedbackDraft('{不是 json')).toBeNull()
    expect(parseFeedbackDraft('null')).toBeNull()
    expect(parseFeedbackDraft('"字符串"')).toBeNull()
    expect(parseFeedbackDraft(['BUG'])).toBeNull()
    expect(parseFeedbackDraft(undefined)).toBeNull()
    expect(parseFeedbackDraft(null)).toBeNull()
  })
})

describe('FEEDBACK_DRAFT_KEY', () => {
  test('存储 key 与隐私政策数据清单里写的一致', () => {
    expect(FEEDBACK_DRAFT_KEY).toBe('fish:feedback:draft')
  })
})
