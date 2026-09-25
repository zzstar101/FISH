import { describe, expect, test } from 'bun:test'
import {
  ScanErrorCodeSchema,
  ScanTicketResponseSchema,
  ScanTicketSchema,
  ScanTicketStatusResponseSchema,
  ScanUserSchema,
  ScanVerifierSchema,
} from './scan'
import type { AuthErrorCodeAll } from './verification'
import { AuthErrorCodeAllSchema } from './verification'

/**
 * 扫码登录契约的边界（#197）。
 *
 * 重点不是复述 zod 的行为，而是把**产品/平台约束**钉在用例里：
 * ticket 必须能塞进微信 scene 的 32 字符预算、verifier 只接受小写 hex、
 * 状态响应里 `user` 只允许出现在 `confirmed`（前端据此做二次确认）。
 */
const TICKET = 'AbCdEfGhIjKlMnOpQrStUv' // 22 字符 base64url
const VERIFIER = 'a'.repeat(64)
const USER = {
  id: '01930000-0000-7000-8000-00000000000a',
  nickname: '阿岚',
  avatarUrl: null,
}
const EXPIRES_AT = '2026-09-25T00:00:00.000Z'

describe('ScanTicketSchema（scene 预算）', () => {
  test('接受 22 字符 base64url', () => {
    expect(ScanTicketSchema.parse(TICKET)).toBe(TICKET)
    expect(ScanTicketSchema.parse(`${'A-_0'.repeat(5)}AB`)).toHaveLength(22)
  })

  test('拒绝长度不等于 22 的取值（scene 上限 32 字符是硬预算）', () => {
    expect(ScanTicketSchema.safeParse('A'.repeat(21)).success).toBe(false)
    expect(ScanTicketSchema.safeParse('A'.repeat(23)).success).toBe(false)
    expect(ScanTicketSchema.safeParse('A'.repeat(33)).success).toBe(false)
  })

  test('拒绝白名单外字符：微信 scene 不支持 % 与 +，也不是任意 base64', () => {
    for (const bad of [`${'A'.repeat(21)}%`, `${'A'.repeat(21)}+`, `${'A'.repeat(21)}=`]) {
      expect(ScanTicketSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('ScanVerifierSchema', () => {
  test('接受 64 字符小写 hex', () => {
    expect(ScanVerifierSchema.parse(VERIFIER)).toBe(VERIFIER)
  })

  test('拒绝大写 hex、非 hex 与长度不符', () => {
    for (const bad of ['A'.repeat(64), 'z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      expect(ScanVerifierSchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('ScanTicketStatusResponseSchema', () => {
  test('pending / expired 不带 user', () => {
    expect(
      ScanTicketStatusResponseSchema.parse({ status: 'pending', expiresAt: EXPIRES_AT }),
    ).toEqual({ status: 'pending', expiresAt: EXPIRES_AT })
    expect(
      ScanTicketStatusResponseSchema.safeParse({ status: 'expired', expiresAt: EXPIRES_AT })
        .success,
    ).toBe(true)
  })

  test('confirmed 必须带 user —— Web 要靠它展示「即将登录为 X」再做二次确认', () => {
    expect(
      ScanTicketStatusResponseSchema.safeParse({ status: 'confirmed', expiresAt: EXPIRES_AT })
        .success,
    ).toBe(false)
    expect(
      ScanTicketStatusResponseSchema.parse({
        status: 'confirmed',
        expiresAt: EXPIRES_AT,
        user: USER,
      }),
    ).toMatchObject({ status: 'confirmed', user: USER })
  })

  test('pending 即便带上 user 也不会漏出去：解析结果里没有它', () => {
    // zod 的 object 默认剥掉未知键（与 MeSchema 等响应 schema 同一取舍：响应不做 .strict()，
    // 便于将来纯增量加字段）。所以这里钉的是**解析结果**而不是「线上必须报错」：
    // 前端拿到的 pending 形状里不可能出现 user，`confirmed` 分支才是唯一能拿到账号的地方。
    const parsed = ScanTicketStatusResponseSchema.parse({
      status: 'pending',
      expiresAt: EXPIRES_AT,
      user: USER,
    })
    expect(parsed).toEqual({ status: 'pending', expiresAt: EXPIRES_AT })
    expect('user' in parsed).toBe(false)
  })
})

describe('ScanUserSchema（最小公开投影）', () => {
  test('只保留 id / nickname / avatarUrl，Me 的私有派生态被剥掉', () => {
    const parsed = ScanUserSchema.parse({
      ...USER,
      authStatus: 'VERIFIED',
      verifiedAt: EXPIRES_AT,
      phoneBound: true,
      maskedPhone: '138****8000',
    })
    expect(Object.keys(parsed).sort()).toEqual(['avatarUrl', 'id', 'nickname'])
  })
})

describe('建票响应与错误码', () => {
  test('qrCodeDataUrl 允许为 null（stub 下生成不了真码），但字段必须存在', () => {
    const base = { ticket: TICKET, verifier: VERIFIER, expiresAt: EXPIRES_AT }
    expect(
      ScanTicketResponseSchema.parse({ ...base, qrCodeDataUrl: null }).qrCodeDataUrl,
    ).toBeNull()
    expect(ScanTicketResponseSchema.safeParse(base).success).toBe(false)
  })

  test('qrCodeDataUrl 只接受 image/* 的 base64 data URL', () => {
    const base = { ticket: TICKET, verifier: VERIFIER, expiresAt: EXPIRES_AT }
    const ok = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    expect(ScanTicketResponseSchema.parse({ ...base, qrCodeDataUrl: ok }).qrCodeDataUrl).toBe(ok)

    for (const bad of [
      '',
      'not-a-data-url',
      // 「取码失败却伪装成成功建票」正是这条要挡住的形状。
      'data:text/html;base64,PGh0bWw+',
      'data:image/png,not-base64',
    ]) {
      expect(ScanTicketResponseSchema.safeParse({ ...base, qrCodeDataUrl: bad }).success).toBe(
        false,
      )
    }
  })

  test('AuthErrorCodeAll 保留字面量联合：拼错的错误码在编译期就该被挡下', () => {
    // 这行本身就是断言：若聚合类型被扩宽成 `string`，`@ts-expect-error` 会因「没有错误」而报错，
    // `bun run typecheck` 立刻变红——比只查 `.options` 更能守住收窄。
    // @ts-expect-error SCAN_TICKET_INVLID 是拼错的错误码
    const typo: AuthErrorCodeAll = 'SCAN_TICKET_INVLID'
    expect(typeof typo).toBe('string')
  })

  test('扫码子域错误码已并入 AuthErrorCodeAll（t5 接线时 AuthError 能收窄它们）', () => {
    expect(ScanErrorCodeSchema.options).toEqual([
      'SCAN_TICKET_INVALID',
      'SCAN_TICKET_CONFLICT',
      'WECHAT_QR_UNAVAILABLE',
    ])
    for (const code of ScanErrorCodeSchema.options) {
      expect(AuthErrorCodeAllSchema.options).toContain(code)
    }
  })
})
