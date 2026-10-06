import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DELETION_CONSEQUENCES } from '@fish/contracts/account-deletion/copy'
import { ApiError } from '../../lib/api-client'
import { describeDeletionFailure, matchesDeletionConfirmation } from './account-deletion'
import { fetchAccountDeletionStatus, requestAccountDeletion, withdrawAccountDeletion } from './api'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const REQUESTED_AT = '2026-10-01T00:00:00.000Z'
const PURGE_AT = '2026-10-08T00:00:00.000Z'

function recordFetch(payload: unknown) {
  const calls: Array<{ url: string; method: string; body: string | null }> = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
    })
    return Response.json(payload)
  }) as unknown as typeof fetch
  return calls
}

describe('account deletion api paths', () => {
  test('读状态是 GET /me/account-deletion（注销态不在 /me 里）', async () => {
    const calls = recordFetch({
      status: 'ACTIVE',
      requestedAt: null,
      purgeScheduledAt: null,
    })

    const status = await fetchAccountDeletionStatus()

    expect(status).toEqual({ status: 'ACTIVE', requestedAt: null, purgeScheduledAt: null })
    expect(calls).toEqual([{ url: '/api/me/account-deletion', method: 'GET', body: null }])
  })

  test('申请注销是 POST 同一 URL，确认词取自契约常量而不是页面字面量', async () => {
    const calls = recordFetch({
      status: 'DELETION_REQUESTED',
      requestedAt: REQUESTED_AT,
      purgeScheduledAt: PURGE_AT,
      offlinedListingCount: 2,
    })

    const result = await requestAccountDeletion()

    expect(result.offlinedListingCount).toBe(2)
    expect(calls).toEqual([
      {
        url: '/api/me/account-deletion',
        method: 'POST',
        body: JSON.stringify({ confirmation: '注销账号' }),
      },
    ])
  })

  test('撤回注销是 DELETE 同一 URL', async () => {
    const calls = recordFetch({
      status: 'ACTIVE',
      requestedAt: null,
      purgeScheduledAt: null,
    })

    const status = await withdrawAccountDeletion()

    expect(status.status).toBe('ACTIVE')
    expect(calls).toEqual([{ url: '/api/me/account-deletion', method: 'DELETE', body: null }])
  })

  test('响应不合契约时抛错，不把漂移的形状放进 UI', async () => {
    recordFetch({ requestedAt: null, purgeScheduledAt: null })

    // 缺 `status`：端上宁可报错，也不能拿一个 undefined 去决定「申请」还是「撤回」。
    await expect(fetchAccountDeletionStatus()).rejects.toThrow()
  })

  test('状态与时间戳的可空性照契约透传（强约束在服务端，端上不自己造）', async () => {
    recordFetch({
      status: 'DELETION_REQUESTED',
      requestedAt: REQUESTED_AT,
      purgeScheduledAt: PURGE_AT,
    })

    await expect(fetchAccountDeletionStatus()).resolves.toEqual({
      status: 'DELETION_REQUESTED',
      requestedAt: REQUESTED_AT,
      purgeScheduledAt: PURGE_AT,
    })
  })
})

describe('二次确认', () => {
  test('逐字匹配才放行，首尾空白不算错', () => {
    expect(matchesDeletionConfirmation('注销账号')).toBe(true)
    expect(matchesDeletionConfirmation('  注销账号\n')).toBe(true)
    expect(matchesDeletionConfirmation('注销帐号')).toBe(false)
    expect(matchesDeletionConfirmation('注销')).toBe(false)
    expect(matchesDeletionConfirmation('')).toBe(false)
  })
})

// 冷静期倒计时的用例已随实现一起搬到 `@fish/contracts/account-deletion/countdown`：
// 那是两端共用的唯一实现，在这里再断言一遍只会得到「两端各测各的、口径照样漂移」。

describe('失败文案', () => {
  test('资格类失败原样透出服务端 message（含对方昵称，是唯一可行动的信息）', () => {
    expect(
      describeDeletionFailure(
        new ApiError(
          'ACCOUNT_DELETION_BLOCKED_PENDING_TRANSACTION',
          409,
          '存在 1 笔未完成交易（对方：小林），需先完成或取消后再申请注销',
        ),
        '兜底',
      ),
    ).toBe('存在 1 笔未完成交易（对方：小林），需先完成或取消后再申请注销')

    expect(
      describeDeletionFailure(
        new ApiError(
          'ACCOUNT_DELETION_BLOCKED_BANNED',
          403,
          '账号处于封禁中，不能申请注销；请先申诉解除封禁',
        ),
        '兜底',
      ),
    ).toBe('账号处于封禁中，不能申请注销；请先申诉解除封禁')
  })

  test('冷静期内的写拦截提示撤回途径，校验失败提示逐字输入', () => {
    expect(
      describeDeletionFailure(
        new ApiError('ACCOUNT_DELETION_PENDING', 403, '注销申请处理中'),
        '兜底',
      ),
    ).toContain('撤回申请')
    expect(
      describeDeletionFailure(new ApiError('VALIDATION_FAILED', 422, '请求参数不合法'), '兜底'),
    ).toContain('注销账号')
  })

  test('未知 ApiError 用服务端 message，非 ApiError 用兜底文案', () => {
    expect(
      describeDeletionFailure(new ApiError('INTERNAL_ERROR', 500, '服务器开小差了'), '兜底'),
    ).toBe('服务器开小差了')
    expect(describeDeletionFailure(new Error('boom'), '注销申请提交失败，请稍后重试')).toBe(
      '注销申请提交失败，请稍后重试',
    )
  })
})

describe('后果说明', () => {
  test('必须说到的后果一件都不少', () => {
    const text = DELETION_CONSEQUENCES.map((item) => `${item.title}${item.detail}`).join('\n')

    expect(text).toContain('7 天')
    expect(text).toContain('撤回')
    // 用户最容易误解的一条：以为撤回就全恢复了。
    expect(text).toContain('不会自动重新上架')
    expect(text).toContain('其它设备')
    expect(text).toContain('已注销用户')
    expect(text).toContain('不可恢复')
  })

  test('每条都有标题与说明，不留空条目', () => {
    expect(DELETION_CONSEQUENCES.length).toBeGreaterThanOrEqual(5)
    for (const item of DELETION_CONSEQUENCES) {
      expect(item.title.trim().length).toBeGreaterThan(0)
      expect(item.detail.trim().length).toBeGreaterThan(0)
    }
  })
})
