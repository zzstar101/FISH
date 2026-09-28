import { describe, expect, test } from 'bun:test'
import { confirmBackTicket } from '../src/features/auth/login-continue'

/**
 * 扫码登录「登录后回确认页」的续接判定（#197 审查修复轮 1）。
 *
 * 关键回归：微信 `navigateTo` **不解码** query（#252 实测，见 `@/lib/route-param`），
 * 确认页按仓库惯例 `encodeURIComponent` 拼 `back` —— 真机上到手的是
 * `pages%2Flogin-confirm%2Findex`。**修复前**的实现在登录页拿原样串与
 * `'pages/login-confirm/index'` 精确比较，恒为 false，续接链路在真机上静默断裂；
 * H5 预览（Taro H5 路由会解码）测不出这个差别，所以这里直接用编码后的串当输入。
 */

const TICKET = 'ZGVtb0xvZ2luQ29uZmlybQ'

describe('confirmBackTicket（真机编码形状优先）', () => {
  test('微信真机形状：back 经 encodeURIComponent → 解码后命中，票据解码原样返回', () => {
    expect(confirmBackTicket('pages%2Flogin-confirm%2Findex', TICKET)).toBe(TICKET)
  })

  test('H5 / 已解码形状：原样 back 也命中（两种来源都要接住）', () => {
    expect(confirmBackTicket('pages/login-confirm/index', TICKET)).toBe(TICKET)
  })

  test('票据同样先解码：不改变 base64url 原值', () => {
    expect(confirmBackTicket('pages%2Flogin-confirm%2Findex', encodeURIComponent(TICKET))).toBe(
      TICKET,
    )
  })

  test('不是从确认页来的 → null（登录后照常回首页）', () => {
    expect(confirmBackTicket('pages/report/index', TICKET)).toBeNull()
    expect(confirmBackTicket('pages%2Freport%2Findex', TICKET)).toBeNull()
    expect(confirmBackTicket(undefined, TICKET)).toBeNull()
  })

  test('从确认页来但没带票据 → null（不带参数回确认页只会落无效码，不如回首页）', () => {
    expect(confirmBackTicket('pages%2Flogin-confirm%2Findex', undefined)).toBeNull()
    expect(confirmBackTicket('pages%2Flogin-confirm%2Findex', '')).toBeNull()
  })

  test('解码失败的手改链接按原样参与比较 → 不命中（交给下游形状校验的取舍不适用于比较）', () => {
    expect(confirmBackTicket('pages%2Flogin-confirm%2Findex%zz', TICKET)).toBeNull()
  })
})
