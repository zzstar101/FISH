import { describe, expect, test } from 'bun:test'
import { wechatLoginFailureMessage } from '@/features/auth/login-messages'

/**
 * 登录失败提示（#198 review P3-3）。
 *
 * 学号入口下线后，「登录失败」是用户唯一能拿到的出口信息——映射错了就没有别的路可走。
 * 这里钉住三条：契约错误码各有专文、未知契约错误透传后端文案、非契约错误给中性提示。
 */
describe('wechatLoginFailureMessage', () => {
  test('503 WECHAT_DISABLED：指向「服务未开通」，不把用户往学号入口引', () => {
    expect(wechatLoginFailureMessage({ code: 'WECHAT_DISABLED', message: '微信登录未启用' })).toBe(
      '登录服务暂未开通，请稍后再试',
    )
  })

  test('401 WECHAT_CODE_INVALID：说清是授权失效、重试即可', () => {
    expect(
      wechatLoginFailureMessage({
        code: 'WECHAT_CODE_INVALID',
        message: '微信登录凭证无效或已过期',
      }),
    ).toBe('微信授权已失效，请重试')
  })

  test('其他契约错误：透传后端文案，不吞成通用句子', () => {
    expect(
      wechatLoginFailureMessage({ code: 'VALIDATION_FAILED', message: '请求参数不合法' }),
    ).toBe('请求参数不合法')
  })

  test('非契约错误（Taro.login 失败 / 请求没到后端）：给中性提示', () => {
    expect(wechatLoginFailureMessage(null)).toBe('微信登录失败，请重试')
  })

  test('每个分支都返回非空文案：空串会让 toast 什么都不显示', () => {
    const failures = [
      null,
      { code: 'WECHAT_DISABLED', message: 'x' },
      { code: 'WECHAT_CODE_INVALID', message: 'x' },
      { code: 'OTHER', message: '后端说的' },
    ]
    for (const failure of failures) {
      expect(wechatLoginFailureMessage(failure).length).toBeGreaterThan(0)
    }
  })
})
