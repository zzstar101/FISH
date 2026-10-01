import { describe, expect, test } from 'bun:test'
import { phoneBindFailureMessage } from '../src/features/auth/phone-messages'

/**
 * 手机号绑定（#204）的两层：**错误码 → 文案**的纯函数，以及**接线**（源码层）。
 *
 * 为什么两层都要：文案映射是唯一决定用户看到什么话的地方，而它写错不会有任何编译 / 运行时
 * 错误；接线（按钮 openType、ownerId 捕获时点）同理，只在源码里可见。
 *
 * ⚠️ 本文件**不覆盖**真机授权（`getPhoneNumber` 原生控件、拒绝授权的回调形态、
 * 服务端与微信真实交互）——那些属 Issue 的「外部前置：须验证，不预填通过」，
 * 开发者工具与本文件都不替代真机验收。
 */

/** 与页面文案明显不同的哨兵：映射表被清空时会退回透传，立刻就红。 */
const BACKEND = '后端原话'

describe('phoneBindFailureMessage：每个契约码都有明确文案', () => {
  test('422 PHONE_CODE_INVALID 与 502 PHONE_UPSTREAM_UNAVAILABLE 必须给出**不同**的下一步', () => {
    const invalid = phoneBindFailureMessage({ code: 'PHONE_CODE_INVALID', message: BACKEND })
    const upstream = phoneBindFailureMessage({
      code: 'PHONE_UPSTREAM_UNAVAILABLE',
      message: BACKEND,
    })
    // 前者要用户「重新授权」（换一枚新 code 才有意义），后者只能等 —— 混成一句
    // 会让用户对着上游故障反复点同一个必然失败的按钮，或反过来放弃一次重授权就能成功的绑定。
    expect(invalid).not.toBe(BACKEND)
    expect(upstream).not.toBe(BACKEND)
    expect(invalid).not.toBe(upstream)
    expect(invalid).toContain('重新授权')
  })

  test('503 WECHAT_DISABLED 是「未开通」，与 502 的平台故障分开', () => {
    const disabled = phoneBindFailureMessage({ code: 'WECHAT_DISABLED', message: BACKEND })
    const upstream = phoneBindFailureMessage({
      code: 'PHONE_UPSTREAM_UNAVAILABLE',
      message: BACKEND,
    })
    expect(disabled).not.toBe(BACKEND)
    expect(disabled).not.toBe(upstream)
  })

  test('非 ApiError（请求没到后端）→ 通用兜底，与「码失效」区分', () => {
    expect(phoneBindFailureMessage(null)).not.toBe(
      phoneBindFailureMessage({ code: 'PHONE_CODE_INVALID', message: BACKEND }),
    )
  })

  test('未映射的码透传后端 message（后端文案已是可读中文）', () => {
    expect(phoneBindFailureMessage({ code: 'VALIDATION_FAILED', message: '请求参数不合法' })).toBe(
      '请求参数不合法',
    )
  })
})

/** 去掉注释后的源码：断言必须看**代码**，否则注释里写着这些机制也能过。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function read(relativePath: string): Promise<string> {
  return code(await Bun.file(new URL(relativePath, import.meta.url)).text())
}

describe('设置页手机号入口：接线', () => {
  test('入口是微信原生授权按钮（openType="getPhoneNumber"），不是普通点击行', async () => {
    const source = await read('../src/pages/settings/index.tsx')
    expect(source).toContain('openType="getPhoneNumber"')
    expect(source).toContain('onGetPhoneNumber=')
    // 只在响应里出现（`phoneBindFailureMessage` 的 import 不算）：确认绑的是这个 handler
    expect(source).toContain('onGetPhoneNumber={onGetPhoneNumber}')
  })

  test('拒绝授权（微信不给 code）不发起请求，只给中性提示', async () => {
    const source = await read('../src/pages/settings/index.tsx')
    const rejectGuard = source.indexOf('if (!code)')
    const request = source.indexOf('bindPhone(code)')
    expect(rejectGuard).toBeGreaterThan(-1)
    expect(request).toBeGreaterThan(-1)
    // 拒绝分支必须在发请求之前 return —— 顺序反了就成了「不给 code 也照发」
    expect(rejectGuard).toBeLessThan(request)
  })

  test('ownerId 在**发请求之前**捕获，并传给 applyPhone（换号后迟到响应不写新账号）', async () => {
    const source = await read('../src/pages/settings/index.tsx')
    const capture = source.indexOf('const ownerId = user?.id')
    const request = source.indexOf('bindPhone(code)')
    expect(capture).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(request)
    expect(source).toContain('applyPhone(ownerId, await bindPhone(code))')
  })

  test('重复点击有在飞守卫，且原生按钮同时 disabled', async () => {
    const source = await read('../src/pages/settings/index.tsx')
    expect(source).toContain('if (bindingPhone) return')
    expect(source).toContain('disabled={bindingPhone}')
  })

  test('掩码读的是当前登录用户（store），不是页面自己编的字符串', async () => {
    const source = await read('../src/pages/settings/index.tsx')
    expect(source).toContain('user?.maskedPhone')
  })
})

describe('store / api 接线', () => {
  test('applyPhone 按 ownerId 守卫，账号不同就整个丢弃', async () => {
    const source = await read('../src/features/auth/store.ts')
    expect(source).toContain('export function applyPhone(')
    expect(source).toContain('snapshot.user?.id !== ownerId')
  })

  test('bindPhone 打 POST /auth/phone/bind 且只交 code，响应用契约 schema 收口', async () => {
    const source = await read('../src/features/auth/api.ts')
    expect(source).toContain("apiRequest('/auth/phone/bind'")
    expect(source).toContain('PhoneBindResponseSchema.parse(payload)')
    // 冻结项：端上只上报 code —— 契约里根本没有号码/encryptedData/iv 这些字段位
    expect(source).not.toContain('encryptedData')
    expect(source).not.toContain('cloudID')
  })
})
