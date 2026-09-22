import { describe, expect, test } from 'bun:test'
import {
  nextPolishIndex,
  POLISH_QUOTA_COARSE_SECONDS,
  polishButtonText,
  polishCooldownFrom,
  polishFailureRoute,
  polishFailureView,
  polishPreconditionError,
  polishQuotaMessage,
  tickPolishCooldown,
} from '../src/pages/sell/polish'

/**
 * 发布页 AI 润色的纯判定（#74 / #142 / 设计 §10）。
 *
 * 组件接线（什么时候调哪个函数、把结果渲染到哪）没有单测 —— 本仓 tests/ 只有纯逻辑
 * 测试，没有 Taro 组件渲染基建（与 `sell-form.test.ts` 同一说明）。
 *
 * `AI_NOT_CONFIGURED`（503）与 `VALIDATION_FAILED`（422）在端上刻意不可达：前者要求
 * `baseUrl` 为空，而加载器在那种配置下启动即失败；后者被本地前置拦截先挡下。它们的
 * 文案与分流只在这里锁住，端上演示覆盖不到（见提交描述里的结论）。
 */

describe('polishPreconditionError —— 点润色之前的本地拦截', () => {
  const ok = {
    title: '罗技 K380 键盘',
    description: '九成新，宿舍自提',
    category: 'DIGITAL',
  } as const

  test('三样齐全时不拦，请求照发', () => {
    expect(polishPreconditionError(ok)).toBeNull()
  })

  test('描述为空排第一：按钮就在描述框里，用户正对着它', () => {
    expect(polishPreconditionError({ ...ok, description: '   ' })).toBe('先写一句描述再润色')
  })

  test('标题不足 2 字与未选分类都要拦（服务端契约同样要求，这里只是少打一次必 422 的请求）', () => {
    expect(polishPreconditionError({ ...ok, title: '键' })).toBe('标题至少 2 个字再润色')
    expect(polishPreconditionError({ ...ok, category: null })).toBe('先选好分类再润色')
  })
})

describe('nextPolishIndex —— 「换一条」的纯前端轮播', () => {
  test('按真实条数循环，不重新请求、不消耗配额', () => {
    expect(nextPolishIndex(0, 3)).toBe(1)
    expect(nextPolishIndex(2, 3)).toBe(0)
    expect(nextPolishIndex(0, 1)).toBe(0)
  })

  test('条数为 0 时返回 0，而不是 NaN（NaN 会渲染成「第 NaN / 0 条」）', () => {
    expect(nextPolishIndex(0, 0)).toBe(0)
  })
})

describe('polishFailureRoute —— 失败往哪条路走', () => {
  test('401 + UNAUTHENTICATED 静默交登录守卫，不弹失败提示', () => {
    expect(polishFailureRoute({ code: 'UNAUTHENTICATED', status: 401 })).toBe('unauthenticated')
  })

  test('裸 401（码不是 UNAUTHENTICATED）不算会话失效，照常进 sheet', () => {
    expect(polishFailureRoute({ code: 'INTERNAL_ERROR', status: 401 })).toBe('sheet')
  })

  test('VALIDATION_FAILED 走字段级错误，不在 sheet 里再说一遍', () => {
    expect(polishFailureRoute({ code: 'VALIDATION_FAILED', status: 422 })).toBe('field-errors')
  })

  test('其余六个码与枚举外的一切都进 sheet', () => {
    for (const code of [
      'AI_TIMEOUT',
      'AI_UPSTREAM_ERROR',
      'AI_RESULT_EMPTY',
      'AI_NOT_CONFIGURED',
      'AI_POLISH_QUOTA',
      'INTERNAL_ERROR',
      '',
    ])
      expect(polishFailureRoute({ code, status: 502 })).toBe('sheet')
  })
})

describe('polishFailureView —— 失败文案与是否给「重试」', () => {
  test('六种码各有文案，且都不复述内部码名', () => {
    const views = [
      polishFailureView('AI_TIMEOUT'),
      polishFailureView('AI_UPSTREAM_ERROR'),
      polishFailureView('AI_RESULT_EMPTY'),
      polishFailureView('AI_NOT_CONFIGURED'),
      polishFailureView('AI_POLISH_QUOTA', 30),
      polishFailureView('VALIDATION_FAILED'),
    ]
    expect(views.map((view) => view.message)).toEqual([
      '润色超时了，重试一下',
      '润色服务暂时不可用，稍后再试',
      '这次没生成可用的文案',
      '润色功能暂未开放',
      '操作太频繁，30 秒后再试',
      '有些内容没填对，请检查后再试',
    ])
  })

  test('422 的文案不指向具体字段、也不给重试：它只在字段级错误一个都认不出时才出现', () => {
    expect(polishFailureView('VALIDATION_FAILED').detail).toBeNull()
    expect(polishFailureView('VALIDATION_FAILED').canRetry).toBe(false)
  })

  test('「你的描述没有改动」只给四种失败：配额与未开放不是「没轮到调用」', () => {
    expect(polishFailureView('AI_TIMEOUT').detail).toBe('你的描述没有改动')
    expect(polishFailureView('AI_UPSTREAM_ERROR').detail).toBe('你的描述没有改动')
    expect(polishFailureView('AI_RESULT_EMPTY').detail).toBe('你的描述没有改动，可以自己再改改')
    expect(polishFailureView('AI_NOT_CONFIGURED').detail).toBeNull()
    expect(polishFailureView('AI_POLISH_QUOTA', 30).detail).toBeNull()
  })

  test('429 与「暂未开放」不给重试按钮：冷却中再点只会再吃一次拒绝', () => {
    expect(polishFailureView('AI_POLISH_QUOTA', 30).canRetry).toBe(false)
    expect(polishFailureView('AI_NOT_CONFIGURED').canRetry).toBe(false)
    expect(polishFailureView('AI_TIMEOUT').canRetry).toBe(true)
  })

  test('枚举外的码退到兜底文案，而不是什么都不显示', () => {
    expect(polishFailureView('SOMETHING_NEW')).toEqual(polishFailureView(''))
    expect(polishFailureView('').message).toBe('润色失败，稍后再试')
  })

  test('原型上的键不算命中：`code` 是服务端可控字符串，取到 Object.prototype 会渲染出空 sheet', () => {
    const fallback = polishFailureView('SOMETHING_NEW')
    for (const code of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])
      expect(polishFailureView(code)).toEqual(fallback)
  })
})

describe('polishQuotaMessage —— 429 的两档文案', () => {
  test('≤60s 给具体秒数，>60s 换粗粒度（真实等待可达上万秒，读秒没有意义）', () => {
    expect(polishQuotaMessage(1)).toBe('操作太频繁，1 秒后再试')
    expect(polishQuotaMessage(POLISH_QUOTA_COARSE_SECONDS)).toBe('操作太频繁，60 秒后再试')
    expect(polishQuotaMessage(POLISH_QUOTA_COARSE_SECONDS + 1)).toBe(
      '今天的润色次数用完了，明天再来',
    )
    expect(polishQuotaMessage(86_400)).toBe('今天的润色次数用完了，明天再来')
  })

  test('服务端没给秒数时不编数字', () => {
    expect(polishQuotaMessage(undefined)).toBe('操作太频繁，稍后再试')
  })

  test('粗粒度文案里一个数字都不出现：日配额数字不进面向用户的文案', () => {
    expect(polishQuotaMessage(86_400)).not.toMatch(/\d/)
    expect(polishQuotaMessage(undefined)).not.toMatch(/\d/)
  })
})

describe('polishCooldownFrom / tickPolishCooldown —— 入口按钮的冷却', () => {
  test('≤60s 进逐秒倒计时', () => {
    expect(polishCooldownFrom(5)).toEqual({ kind: 'short', secondsLeft: 5 })
    expect(polishCooldownFrom(POLISH_QUOTA_COARSE_SECONDS)).toEqual({
      kind: 'short',
      secondsLeft: 60,
    })
  })

  test('>60s 进 coarse：不逐秒，也不在页面内自动解禁', () => {
    const coarse = polishCooldownFrom(POLISH_QUOTA_COARSE_SECONDS + 1)
    expect(coarse).toEqual({ kind: 'coarse' })
    expect(tickPolishCooldown({ kind: 'coarse' })).toEqual({ kind: 'coarse' })
  })

  test('秒数缺失或非正数时退到 unknown：不编数字，但按钮照样变灰', () => {
    expect(polishCooldownFrom(undefined)).toEqual({ kind: 'unknown' })
    expect(polishCooldownFrom(0)).toEqual({ kind: 'unknown' })
    expect(polishCooldownFrom(-1)).toEqual({ kind: 'unknown' })
  })

  test('unknown 不逐秒、不解禁，也不声称是日配额用完了（那是没依据的推断）', () => {
    expect(tickPolishCooldown({ kind: 'unknown' })).toEqual({ kind: 'unknown' })
    expect(polishButtonText({ loading: false, cooldown: { kind: 'unknown' } })).toBe('请稍后再试')
  })

  test('逐秒走到 1 之后归零，返回 null 表示恢复可点', () => {
    expect(tickPolishCooldown({ kind: 'short', secondsLeft: 3 })).toEqual({
      kind: 'short',
      secondsLeft: 2,
    })
    expect(tickPolishCooldown({ kind: 'short', secondsLeft: 1 })).toBeNull()
  })
})

describe('polishButtonText —— 入口按钮上的字', () => {
  test('四种状态各有其字', () => {
    expect(polishButtonText({ loading: true, cooldown: null })).toBe('润色中')
    expect(polishButtonText({ loading: false, cooldown: null })).toBe('润色')
    expect(polishButtonText({ loading: false, cooldown: { kind: 'short', secondsLeft: 12 } })).toBe(
      '12s',
    )
    expect(polishButtonText({ loading: false, cooldown: { kind: 'coarse' } })).toBe(
      '今日次数已用完',
    )
  })
})
