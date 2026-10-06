import { describe, expect, test } from 'bun:test'
import { ACCOUNT_DELETION_ROUTES } from './routes'
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  ACCOUNT_DELETION_COOLING_OFF_DAYS,
  AccountDeletionErrorCodeSchema,
  AccountDeletionRequestResponseSchema,
  AccountDeletionStateSchema,
  AccountDeletionStatusSchema,
  DELETED_ACCOUNT_NICKNAME,
  RequestAccountDeletionSchema,
} from './schema'

const active = { status: 'ACTIVE' as const, requestedAt: null, purgeScheduledAt: null }

const pending = {
  status: 'DELETION_REQUESTED' as const,
  requestedAt: '2026-10-06T02:00:00.000Z',
  purgeScheduledAt: '2026-10-13T02:00:00.000Z',
}

describe('accountDeletionStateSchema', () => {
  test('对外只暴露 ACTIVE 与冷静期两态', () => {
    // 刻意不含 DELETED：去标识化完成后凭据全空，那个账号再也过不了 requireAuth，
    // 永远读不到自己的状态；DELETED 只活在服务端内部。
    expect(AccountDeletionStateSchema.options).toEqual(['ACTIVE', 'DELETION_REQUESTED'])
    expect(AccountDeletionStateSchema.safeParse('DELETED').success).toBe(false)
  })
})

describe('accountDeletionStatusSchema', () => {
  test('ACTIVE 态就是两个 null', () => {
    expect(AccountDeletionStatusSchema.parse(active)).toEqual(active)
  })

  test('冷静期态必须带上申请时刻与到期时刻', () => {
    expect(AccountDeletionStatusSchema.parse(pending)).toEqual(pending)
    // 两个字段都是必填（可空 ≠ 可省）：端上按 status 分支读，缺字段会让倒计时渲染成 undefined。
    expect(AccountDeletionStatusSchema.safeParse({ status: 'DELETION_REQUESTED' }).success).toBe(
      false,
    )
    expect(
      AccountDeletionStatusSchema.safeParse({ ...pending, purgeScheduledAt: undefined }).success,
    ).toBe(false)
  })

  test('两个时间戳是 ISO 字符串或 null，不是毫秒数', () => {
    // 端上要直接拿它渲染倒计时，服务端统一走 toISOString()。
    expect(
      AccountDeletionStatusSchema.safeParse({ ...pending, purgeScheduledAt: 1_760_000_000_000 })
        .success,
    ).toBe(false)
    expect(
      AccountDeletionStatusSchema.safeParse({ ...pending, requestedAt: '2026-10-06 02:00:00' })
        .success,
    ).toBe(false)
  })
})

describe('accountDeletionRequestResponseSchema', () => {
  test('在状态之上只多一个本次下架商品数', () => {
    const parsed = AccountDeletionRequestResponseSchema.parse({
      ...pending,
      offlinedListingCount: 2,
    })
    expect(parsed.offlinedListingCount).toBe(2)
    expect(
      AccountDeletionRequestResponseSchema.safeParse({ ...pending, offlinedListingCount: -1 })
        .success,
    ).toBe(false)
    expect(
      AccountDeletionRequestResponseSchema.safeParse({ ...pending, offlinedListingCount: 1.5 })
        .success,
    ).toBe(false)
  })

  test('重复申请回的是既有状态，计数归零而不是 undefined', () => {
    expect(
      AccountDeletionRequestResponseSchema.parse({ ...pending, offlinedListingCount: 0 }),
    ).toEqual({ ...pending, offlinedListingCount: 0 })
  })
})

describe('requestAccountDeletionSchema', () => {
  test('只接受逐字相等的固定确认词', () => {
    expect(
      RequestAccountDeletionSchema.parse({ confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE }),
    ).toEqual({
      confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
    })
    for (const bad of ['注销', '注销账号 ', 'cancel', '注销账号！']) {
      expect(RequestAccountDeletionSchema.safeParse({ confirmation: bad }).success).toBe(false)
    }
  })

  test('缺少确认词直接不合法（不能靠省略字段蒙过去）', () => {
    expect(RequestAccountDeletionSchema.safeParse({}).success).toBe(false)
  })

  test('多余字段拒绝而不是忽略', () => {
    // 服务端的身份与资格一律重新校验，端上不能通过多传字段影响它。
    expect(
      RequestAccountDeletionSchema.safeParse({
        confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE,
        userId: 'someone-else',
      }).success,
    ).toBe(false)
  })
})

describe('accountDeletionErrorCodeSchema', () => {
  test('冻结三个域内错误码', () => {
    expect(AccountDeletionErrorCodeSchema.options).toEqual([
      'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION',
      'ACCOUNT_DELETION_BLOCKED_BANNED',
      'ACCOUNT_DELETION_PENDING',
    ])
  })
})

describe('冻结常量', () => {
  test('冷静期天数与占位昵称是端上文案与服务端写入共用的单一来源', () => {
    expect(ACCOUNT_DELETION_COOLING_OFF_DAYS).toBe(7)
    expect(DELETED_ACCOUNT_NICKNAME).toBe('已注销用户')
    // users.nickname 是 NOT NULL，占位串必须非空，否则 worker 去标识化会写失败。
    expect(DELETED_ACCOUNT_NICKNAME.length).toBeGreaterThan(0)
  })

  test('三条方法共用一个 URL', () => {
    expect(ACCOUNT_DELETION_ROUTES.status).toBe('/me/account-deletion')
  })
})
