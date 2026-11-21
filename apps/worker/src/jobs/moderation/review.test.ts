import { describe, expect, test } from 'bun:test'
import { buildModerationReviewPrompt, MODERATION_REVIEW_PROMPT_VERSION } from './prompt'
import { errorReview, ModerationReviewParseError, parseModerationReview } from './review'

/** 解析层是「模型输出 → 平台动作」的窄口：这里判错一次，线上就是放行或误杀一条真实商品。 */
describe('parseModerationReview', () => {
  test('裸 JSON', () => {
    expect(
      parseModerationReview(
        '{"decision":"PASS","category":null,"reason":"正常教材","evidence":["封面为出版社信息"],"confidence":0.9}',
      ),
    ).toEqual({
      decision: 'PASS',
      category: null,
      reason: '正常教材',
      evidence: ['封面为出版社信息'],
      confidence: 0.9,
    })
  })

  test('```json 围栏 + 前后说明文字都剥掉', () => {
    const review = parseModerationReview(
      '好的，判断如下：\n```json\n{"decision":"BLOCK","reason":"描述里有微信号","evidence":"加微信 abc123","confidence":0.8}\n```\n以上。',
    )
    expect(review.decision).toBe('BLOCK')
    // evidence 允许单个字符串，统一收成数组。
    expect(review.evidence).toEqual(['加微信 abc123'])
  })

  test('decision 大小写与空白归一，但未知取值必须抛错（不能猜）', () => {
    expect(parseModerationReview('{"decision":" pass ","reason":"r"}').decision).toBe('PASS')
    expect(() => parseModerationReview('{"decision":"APPROVE","reason":"r"}')).toThrow(
      ModerationReviewParseError,
    )
  })

  test('置信度兼容 0–100 与 0–1，越界当没给', () => {
    expect(
      parseModerationReview('{"decision":"PASS","reason":"r","confidence":99}').confidence,
    ).toBe(0.99)
    expect(
      parseModerationReview('{"decision":"PASS","reason":"r","confidence":-1}').confidence,
    ).toBeNull()
    expect(
      parseModerationReview('{"decision":"PASS","reason":"r","confidence":"高"}').confidence,
    ).toBeNull()
  })

  test('没有 reason / 不是对象 / 没有大括号都抛错（→ ERROR → 人工）', () => {
    expect(() => parseModerationReview('{"decision":"PASS"}')).toThrow(ModerationReviewParseError)
    expect(() => parseModerationReview('["PASS"]')).toThrow(ModerationReviewParseError)
    expect(() => parseModerationReview('模型认为没问题')).toThrow(ModerationReviewParseError)
    expect(() => parseModerationReview('{not json}')).toThrow(ModerationReviewParseError)
  })

  test('超长理由与证据被截断，避免把上游原文整段写进库与后台页', () => {
    const review = parseModerationReview(
      JSON.stringify({
        decision: 'PASS',
        reason: 'x'.repeat(2000),
        evidence: Array.from({ length: 20 }, (_, i) => `${i}`.repeat(400)),
      }),
    )
    expect(review.reason.length).toBe(500)
    expect(review.evidence).toHaveLength(10)
    expect(review.evidence[0]?.length).toBe(300)
  })

  test('errorReview 一定是 ERROR 且没有置信度', () => {
    expect(errorReview('超时')).toEqual({
      decision: 'ERROR',
      category: null,
      reason: '超时',
      evidence: [],
      confidence: null,
    })
  })
})

describe('buildModerationReviewPrompt', () => {
  const prompt = buildModerationReviewPrompt({
    title: 'Python 编程基础及应用',
    description: '教育部规划教材，九成新',
    category: 'BOOKS',
    priceCents: 2500,
    providerLabel: 'Polity',
    providerSubLabel: 'NationalInstitution',
    imageCount: 3,
  })

  test('把商品上下文与上游标签一起交给模型', () => {
    expect(prompt.text).toContain('Python 编程基础及应用')
    expect(prompt.text).toContain('教育部规划教材')
    expect(prompt.text).toContain('BOOKS')
    expect(prompt.text).toContain('25.00 元')
    expect(prompt.text).toContain('Polity / NationalInstitution')
    expect(prompt.text).toContain('共 3 张')
  })

  test('提示词同时压住「误杀」与「变成放行后门」两个方向', () => {
    expect(prompt.system).toContain('教育部规划教材')
    expect(prompt.system).toContain('不得因为存在正常商品特征')
    expect(prompt.system).toContain('UNSURE')
    expect(MODERATION_REVIEW_PROMPT_VERSION).toBe('2026-11-21-v1')
  })
})
