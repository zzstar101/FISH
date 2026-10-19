import { describe, expect, test } from 'bun:test'
import {
  acceptDraft,
  FEEDBACK_DRAFT_KEY,
  parseFeedbackDraft,
} from '../src/pkg-legal/pages/feedback/draft'

/**
 * 意见反馈本机暂存的解析。
 *
 * 只测纯函数：`Taro.getStorageSync` 只能在端上跑，所以页面里剩下的那一步
 * （取值 + try/catch + 清掉不属于当前账号的存储）不在单测范围内；归属判定本身
 * 已抽成纯函数 `acceptDraft`，覆盖在下面。
 */

describe('parseFeedbackDraft —— 本机暂存 → 草稿', () => {
  const ownerId = 'usr_01jc000000e008000000001qg0'
  const submitId = '6f1c2a10-3b4d-4e5f-8a9b-0c1d2e3f4a5b'

  test('weapp 形态：getStorageSync 直接给对象（含上次提交的幂等键）', () => {
    expect(
      parseFeedbackDraft({
        ownerId,
        submitId,
        type: 'DISPUTE',
        desc: '一直转圈',
        contact: '微信 abc',
      }),
    ).toEqual({ ownerId, submitId, type: 'DISPUTE', desc: '一直转圈', contact: '微信 abc' })
  })

  test('H5 形态：getStorageSync 给的是 JSON 字符串', () => {
    const raw = JSON.stringify({ ownerId, submitId, type: 'BUG', desc: '点不动', contact: '' })
    expect(parseFeedbackDraft(raw)).toEqual({
      ownerId,
      submitId,
      type: 'BUG',
      desc: '点不动',
      contact: '',
    })
  })

  test('空草稿返回 null —— 三个字段都空时不该弹「已恢复上次未提交的内容」', () => {
    expect(parseFeedbackDraft({ ownerId, type: '', desc: '', contact: '' })).toBeNull()
    expect(parseFeedbackDraft({ ownerId })).toBeNull()
    expect(parseFeedbackDraft({})).toBeNull()
  })

  test('旧格式（没有 ownerId / submitId）解析出 null 字段，由 acceptDraft 拒绝恢复', () => {
    expect(parseFeedbackDraft({ type: 'bug', desc: '旧草稿', contact: '' })).toEqual({
      ownerId: null,
      submitId: null,
      type: '',
      desc: '旧草稿',
      contact: '',
    })
  })

  test('形状不对的 submitId 当没有：不能拿坏值当 clientRequestId 发请求', () => {
    expect(parseFeedbackDraft({ ownerId, submitId: 'not-a-uuid', desc: '正文' })?.submitId).toBe(
      null,
    )
    expect(parseFeedbackDraft({ ownerId, submitId: 42, desc: '正文' })?.submitId).toBe(null)
  })

  test('单个字段坏掉只丢那一个，不整份丢掉（用户写下的正文比类型选择值钱）', () => {
    expect(
      parseFeedbackDraft({ ownerId, type: '不存在的类型', desc: '正文还在', contact: 42 }),
    ).toEqual({ ownerId, submitId: null, type: '', desc: '正文还在', contact: '' })
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

describe('acceptDraft —— 只恢复属于当前账号的草稿', () => {
  const ownerId = 'usr_01jc000000e008000000001qg0'
  const draft = {
    ownerId,
    submitId: null,
    type: 'UX' as const,
    desc: '正文',
    contact: '',
  }

  test('归属当前账号 → 恢复（含上次提交的幂等键）', () => {
    expect(acceptDraft(draft, ownerId)).toEqual(draft)
  })

  test('别的账号的草稿 → 拒绝（内容与联系方式不跨账号展示）', () => {
    expect(acceptDraft(draft, 'usr_01jc000000e008000000009zzz')).toBeNull()
  })

  test('旧格式（ownerId=null）→ 拒绝：无法判断归属，宁可让用户重打', () => {
    expect(acceptDraft({ ...draft, ownerId: null }, ownerId)).toBeNull()
  })

  test('没有解析出草稿 → null', () => {
    expect(acceptDraft(null, ownerId)).toBeNull()
  })
})

describe('FEEDBACK_DRAFT_KEY', () => {
  test('存储 key 与隐私政策数据清单里写的一致', () => {
    expect(FEEDBACK_DRAFT_KEY).toBe('fish:feedback:draft')
  })
})
