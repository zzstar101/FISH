import { describe, expect, test } from 'bun:test'
import {
  isPhoneBindCurrent,
  phoneAuthHint,
  phoneBindFailureMessage,
  readPhoneAuthResult,
  runPhoneBind,
} from '@/features/auth/phone'

/**
 * 手机号绑定（#204）的端上逻辑。
 *
 * 设置页的 JSX 拉不起 Taro runtime，所以「用户看到哪句文案、结果写进哪个账号」这两件事
 * 必须在纯函数里钉住：文案错了用户没有别的出口；账号错了会把别人的手机号显示在自己的
 * 账号上（store 是全局单例，不会自我纠正）。
 */

describe('readPhoneAuthResult', () => {
  test('成功回调：只认 code，其余字段一律不读', () => {
    expect(readPhoneAuthResult({ errMsg: 'getPhoneNumber:ok', code: 'abc123' })).toEqual({
      kind: 'code',
      code: 'abc123',
    })
  })

  test('code 两端的空白去掉：服务端按原样调微信，带空白必然失败', () => {
    expect(readPhoneAuthResult({ errMsg: 'getPhoneNumber:ok', code: '  abc123 ' })).toEqual({
      kind: 'code',
      code: 'abc123',
    })
  })

  test('空串 code 不算拿到授权（等同没 code）', () => {
    expect(readPhoneAuthResult({ errMsg: 'getPhoneNumber:ok', code: '' }).kind).not.toBe('code')
  })

  test('用户点拒绝：detail 里没有 code，只有 errMsg', () => {
    expect(readPhoneAuthResult({ errMsg: 'getPhoneNumber:fail user deny' })).toEqual({
      kind: 'denied',
    })
  })

  test('未同意隐私保护指引：微信在隐私接口处直接拦下', () => {
    expect(
      readPhoneAuthResult({ errMsg: 'getPhoneNumber:fail privacy permission is not authorized' }),
    ).toEqual({ kind: 'privacy-denied' })
  })

  test('没有 code 也不像拒绝（老基础库 / 工具未登录）：归为「未完成」', () => {
    expect(readPhoneAuthResult({ errMsg: 'getPhoneNumber:fail no permission' })).toEqual({
      kind: 'incomplete',
    })
    expect(readPhoneAuthResult(null)).toEqual({ kind: 'incomplete' })
  })
})

describe('phoneAuthHint', () => {
  test('三种非 code 分支各有非空提示，拒绝与隐私拦下不能同一句', () => {
    const denied = phoneAuthHint({ kind: 'denied' })
    const privacy = phoneAuthHint({ kind: 'privacy-denied' })
    const incomplete = phoneAuthHint({ kind: 'incomplete' })
    expect(denied.length).toBeGreaterThan(0)
    expect(privacy.length).toBeGreaterThan(0)
    expect(incomplete.length).toBeGreaterThan(0)
    expect(denied).not.toBe(privacy)
  })
})

describe('phoneBindFailureMessage', () => {
  test('422 PHONE_CODE_INVALID：让用户重新点一次授权（能拿到新 code）', () => {
    expect(
      phoneBindFailureMessage({
        code: 'PHONE_CODE_INVALID',
        message: '手机号授权凭证无效或已过期',
      }),
    ).toBe('手机号授权已失效，请重新授权')
  })

  test('422 PHONE_NUMBER_UNSUPPORTED：说清只能绑大陆号，重试同一个号没意义', () => {
    expect(
      phoneBindFailureMessage({ code: 'PHONE_NUMBER_UNSUPPORTED', message: '不支持的手机号' }),
    ).toBe('暂不支持该手机号，请使用中国大陆手机号')
  })

  test('502 PHONE_UPSTREAM_FAILED：会话没受影响，等一会儿重试', () => {
    expect(phoneBindFailureMessage({ code: 'PHONE_UPSTREAM_FAILED', message: '上游失败' })).toBe(
      '手机号服务暂不可用，请稍后重试',
    )
  })

  test('409 PHONE_ALREADY_BOUND：这个号已在别的账号上', () => {
    expect(phoneBindFailureMessage({ code: 'PHONE_ALREADY_BOUND', message: '已绑定' })).toBe(
      '该手机号已被其他账号绑定',
    )
  })

  test('503 WECHAT_DISABLED：后端没开手机号绑定', () => {
    expect(phoneBindFailureMessage({ code: 'WECHAT_DISABLED', message: '未开通' })).toBe(
      '手机号绑定暂未开通',
    )
  })

  test('其他契约错误：透传后端文案，不吞成通用句子', () => {
    expect(phoneBindFailureMessage({ code: 'VALIDATION_FAILED', message: '请求参数不合法' })).toBe(
      '请求参数不合法',
    )
  })

  test('请求没到后端（断网 / 超时）：给网络提示', () => {
    expect(phoneBindFailureMessage(null)).toBe('网络异常，请稍后重试')
  })

  test('每个分支都返回非空文案：空串会让 toast 什么都不显示', () => {
    const failures = [
      null,
      { code: 'PHONE_CODE_INVALID', message: 'x' },
      { code: 'PHONE_NUMBER_UNSUPPORTED', message: 'x' },
      { code: 'PHONE_UPSTREAM_FAILED', message: 'x' },
      { code: 'PHONE_ALREADY_BOUND', message: 'x' },
      { code: 'WECHAT_DISABLED', message: 'x' },
      { code: 'UNAUTHENTICATED', message: 'x' },
      { code: 'OTHER', message: '' },
    ]
    for (const failure of failures) {
      expect(phoneBindFailureMessage(failure).length).toBeGreaterThan(0)
    }
  })
})

describe('isPhoneBindCurrent', () => {
  test('账号或代次任一变都不算同一会话（退出再登回同一账号也算变了）', () => {
    const ticket = { ownerId: 'u1', epoch: 3 }
    expect(isPhoneBindCurrent(ticket, { ownerId: 'u1', epoch: 3 })).toBe(true)
    expect(isPhoneBindCurrent(ticket, { ownerId: 'u2', epoch: 3 })).toBe(false)
    expect(isPhoneBindCurrent(ticket, { ownerId: 'u1', epoch: 4 })).toBe(false)
    expect(isPhoneBindCurrent(ticket, { ownerId: null, epoch: 4 })).toBe(false)
  })
})

describe('runPhoneBind', () => {
  test('会话没变：返回绑定结果与发起时的账号，页面据此广播', async () => {
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => ({ maskedPhone: '138****8000' }),
        session: () => ({ ownerId: 'u1', epoch: 1 }),
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'bound', ownerId: 'u1', maskedPhone: '138****8000' })
  })

  test('请求飞行途中换了账号：迟到的 200 归 aborted，绝不写进新账号', async () => {
    let current = { ownerId: 'u1', epoch: 1 }
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          // 请求在飞行：用户退出并登进了 u2
          current = { ownerId: 'u2', epoch: 2 }
          return { maskedPhone: '138****8000' }
        },
        session: () => current,
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('同一账号但会话代次变了（退出又登回）：也算换号', async () => {
    let epoch = 1
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          epoch = 2
          return { maskedPhone: '138****8000' }
        },
        session: () => ({ ownerId: 'u1', epoch }),
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('会话没变时失败原样透出，由页面翻译成文案', async () => {
    const error = new Error('boom')
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          throw error
        },
        session: () => ({ ownerId: 'u1', epoch: 1 }),
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'failed', error })
  })

  test('迟到的失败也不弹给新账号', async () => {
    let current = { ownerId: 'u1', epoch: 1 }
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          current = { ownerId: 'u2', epoch: 2 }
          throw new Error('boom')
        },
        session: () => current,
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('401 把当前会话清掉：错误必须交回页面，不能被当成旧任务静默吞掉', async () => {
    // `lib/request` 收到 401 `UNAUTHENTICATED` 时会 clearSession()，代次随之前进、
    // 当前已无人登录 —— 长得像「旧任务」，但那正是「登录已失效」的原因本身。
    let current: { ownerId: string | null; epoch: number } = { ownerId: 'u1', epoch: 1 }
    const error = Object.assign(new Error('登录已失效'), {
      name: 'ApiError',
      code: 'UNAUTHENTICATED',
      status: 401,
    })
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          current = { ownerId: null, epoch: 2 }
          throw error
        },
        session: () => current,
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'failed', error })
    // 页面据此给用户的正是这句（`phoneBindFailureMessage` 的 UNAUTHENTICATED 分支）
    expect(phoneBindFailureMessage({ code: 'UNAUTHENTICATED', message: 'x' })).toBe(
      '登录已失效，请重新登录',
    )
  })

  test('401 但用户已登进另一个账号：仍 aborted，不把旧账号的报错弹给新账号', async () => {
    const error = Object.assign(new Error('登录已失效'), {
      name: 'ApiError',
      code: 'UNAUTHENTICATED',
      status: 401,
    })
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          throw error
        },
        session: () => ({ ownerId: 'u2', epoch: 2 }),
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('会话已变但不是 401（断网 / 超时）：仍算旧任务，静默', async () => {
    let current: { ownerId: string | null; epoch: number } = { ownerId: 'u1', epoch: 1 }
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          current = { ownerId: null, epoch: 2 }
          throw new Error('network')
        },
        session: () => current,
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('发起时会话已不匹配：一个请求都不发（新凭据不能去换旧账号的授权）', async () => {
    let calls = 0
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          calls += 1
          return { maskedPhone: '138****8000' }
        },
        session: () => ({ ownerId: 'u2', epoch: 2 }),
        pageAlive: () => true,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
    expect(calls).toBe(0)
  })
})

/**
 * 页面生命周期这一档（#204 审查第二轮 P2）。
 *
 * 设置页卸载（用户返回上一页）后，飞行中的绑定请求仍在跑。此时**会话判据完全失效**：
 * 账号没换、会话代次没变，旧响应的 `{ownerId, epoch}` 与新页面的任务一模一样。所以必须由
 * 页面存活标记作废；否则「旧页面发起 → 返回并重进 → 新页面绑定完成 → 旧响应迟到」会覆盖
 * 新掩码、再弹一次 toast，并把已作废页面的按钮解锁。
 */
describe('runPhoneBind：页面卸载', () => {
  test('卸载后成功回来：aborted（会话没变也不写 store、不提示）', async () => {
    let alive = true
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          // 请求飞行中用户返回上一页，页面卸载
          alive = false
          return { maskedPhone: '138****8000' }
        },
        // 账号与会话代次都没变：只有页面存活标记能挡住这次写入
        session: () => ({ ownerId: 'u1', epoch: 1 }),
        pageAlive: () => alive,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('卸载后失败回来：aborted（不把已关闭页面的错误弹到别处）', async () => {
    let alive = true
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          alive = false
          throw new Error('boom')
        },
        session: () => ({ ownerId: 'u1', epoch: 1 }),
        pageAlive: () => alive,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('卸载后 401 清掉会话也仍然 aborted：已卸载的页面没有 UI 可以提示', async () => {
    let alive = true
    const error = Object.assign(new Error('登录已失效'), {
      name: 'ApiError',
      code: 'UNAUTHENTICATED',
      status: 401,
    })
    let current: { ownerId: string | null; epoch: number } = { ownerId: 'u1', epoch: 1 }
    const outcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'abc' },
      {
        bindPhone: async () => {
          alive = false
          current = { ownerId: null, epoch: 2 }
          throw error
        },
        session: () => current,
        pageAlive: () => alive,
      },
    )
    expect(outcome).toEqual({ kind: 'aborted' })
  })

  test('卸载重进后的乱序响应：旧页面那次作废，新页面那次才是结果', async () => {
    const oldPage = { alive: true }
    const newPage = { alive: true }
    let resolveOld: (value: { maskedPhone: string }) => void = () => {}
    // 旧页面发起的那次请求一直挂着（慢网）
    const oldOutcome = runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'old-code' },
      {
        bindPhone: () => new Promise<{ maskedPhone: string }>((resolve) => (resolveOld = resolve)),
        session: () => ({ ownerId: 'u1', epoch: 1 }),
        pageAlive: () => oldPage.alive,
      },
    )
    // 用户返回（旧页面卸载）→ 重新进设置页（新页面实例）→ 在新页面上绑定成功
    oldPage.alive = false
    const newOutcome = await runPhoneBind(
      { ticket: { ownerId: 'u1', epoch: 1 }, code: 'new-code' },
      {
        bindPhone: async () => ({ maskedPhone: '139****9999' }),
        session: () => ({ ownerId: 'u1', epoch: 1 }),
        pageAlive: () => newPage.alive,
      },
    )
    expect(newOutcome).toEqual({ kind: 'bound', ownerId: 'u1', maskedPhone: '139****9999' })

    // 旧页面的 200 现在才到：账号与代次都与新任务相同，只有页面存活能把它判掉
    resolveOld({ maskedPhone: '138****8000' })
    expect(await oldOutcome).toEqual({ kind: 'aborted' })
  })
})
