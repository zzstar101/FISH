import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * 授权结果必须归给**发起它的那个账号**（#511 审查 high）。
 *
 * 场景：A 点「发送/同意」→ `requestSubscribeMessage` 弹框 → 用户还没点允许就退出登录或换成 B
 * → 授权框返回。微信的返回值与身份无关，若这时照常上报，A 的「允许」就记到了 B 名下。
 * 一次性订阅的额度是**按账号**记账的，记错人等于给 B 凭空加一次站外推送、A 的那次授权丢失。
 *
 * 这里用可控的 `sessionEpoch` / `authSnapshot` 桩把两个判据分别钉住：
 * 退出登录（代次 +1）与 A→B 换号（代次不变、账号变）。
 */

let epoch = 0
let userId: string | null = 'user-a'
let reports: { grants: { kind: string; status: string }[] }[] = []

mock.module('@/lib/session', () => ({
  sessionEpoch: () => epoch,
}))

mock.module('@/features/auth/store', () => ({
  authSnapshot: () => ({
    status: userId === null ? 'anonymous' : 'authed',
    user: userId === null ? null : { id: userId },
  }),
}))

mock.module('@/features/subscribe/api', () => ({
  // 模板配置已预热（点击时同步读缓存，不能 await）
  cachedSubscribeConfig: () => ({
    templates: { CHAT: 'tmpl_chat', TX: 'tmpl_tx', REVIEW: 'tmpl_review' },
  }),
  loadSubscribeConfig: async () => null,
  reportSubscribeGrants: async (report: { grants: { kind: string; status: string }[] }) => {
    reports.push(report)
    return { remaining: { CHAT: 1, TX: 0, REVIEW: 0 } }
  },
}))

/** 授权框：返回一个挂起的 Promise，由用例决定什么时候、以什么结果返回。 */
let resolvePending: ((value: Record<string, string>) => void) | null = null
mock.module('@tarojs/taro', () => ({
  default: {
    requestSubscribeMessage: () =>
      new Promise<Record<string, string>>((resolve) => {
        resolvePending = resolve
      }),
  },
}))

const { requestSubscribe } = await import('../src/features/subscribe/request')

beforeEach(() => {
  epoch = 0
  userId = 'user-a'
  reports = []
  resolvePending = null
})

describe('requestSubscribe：授权结果的账号归属', () => {
  test('身份没变：把微信的原始结果摊平上报，并返回剩余次数', async () => {
    const pending = requestSubscribe(['TX', 'CHAT'])
    // 调微信这一句在用户手势的同步阶段完成，桩在 executor 里就挂好了 resolve
    expect(resolvePending).not.toBeNull()
    resolvePending?.({ tmpl_tx: 'accept', tmpl_chat: 'reject' })

    expect(await pending).toEqual({ remaining: { CHAT: 1, TX: 0, REVIEW: 0 } })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.grants).toEqual([
      { kind: 'TX', status: 'accept' },
      { kind: 'CHAT', status: 'reject' },
    ])
  })

  test('授权框期间退出登录（会话代次 +1）：整包丢弃，不上报', async () => {
    const pending = requestSubscribe(['TX'])
    // `clearSession()` 的效果：代次 +1、账号变 null
    epoch += 1
    userId = null
    resolvePending?.({ tmpl_tx: 'accept' })

    expect(await pending).toBeNull()
    expect(reports).toHaveLength(0)
  })

  test('授权框期间换成另一个账号（代次不变、账号变）：同样丢弃', async () => {
    const pending = requestSubscribe(['TX'])
    // 换号不一定清会话：这里刻意保持 epoch 不变，只改账号
    userId = 'user-b'
    resolvePending?.({ tmpl_tx: 'accept' })

    expect(await pending).toBeNull()
    expect(reports).toHaveLength(0)
  })

  test('未登录时发起、返回时仍未登录：账号判据前后一致，照常上报', async () => {
    userId = null
    const pending = requestSubscribe(['REVIEW'])
    resolvePending?.({ tmpl_review: 'accept' })

    // 这条钉住"判据是前后比对，不是要求必须已登录"：否则前后一致时也会被误丢
    expect(await pending).toEqual({ remaining: { CHAT: 1, TX: 0, REVIEW: 0 } })
    expect(reports).toHaveLength(1)
    expect(reports[0]?.grants).toEqual([{ kind: 'REVIEW', status: 'accept' }])
  })
})
