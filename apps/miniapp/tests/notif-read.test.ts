import { describe, expect, test } from 'bun:test'
import { mergeMarkReadResults } from '../src/features/chat/notif-read'

/**
 * 通知逐条已读的归并口径（#129 review 修复）—— 锁住「谁被标成已读」：
 * 只认成功的那几条；演示兜底只在**整批都因后端不可达失败**时成立，
 * 真实的接口错误（401 / 404 / 5xx）不得被说成「已经读过了」。
 */
const settled = {
  ok: { status: 'fulfilled', value: undefined } as PromiseSettledResult<void>,
  unreachable: {
    status: 'rejected',
    reason: new Error('request:fail timeout'),
  } as PromiseSettledResult<void>,
  plainError: {
    status: 'rejected',
    reason: new Error('HTTP 401 UNAUTHENTICATED'),
  } as PromiseSettledResult<void>,
}

/**
 * 真机上网络失败的形状：`Taro.request` reject 的**不是 `Error`**，而是
 * `{ errMsg: 'request:fail …' }`（见 `pages/listing-detail/index.tsx` 的同款判据）。
 * 判据只认 `instanceof Error` 的话，演示兜底在真机上永远不会生效。
 */
const unreachableErrMsg = {
  status: 'rejected',
  reason: { errMsg: 'request:fail timeout' },
} as unknown as PromiseSettledResult<void>

/** 部分平台 / 版本的超时文案是中文，且**不含** `request:fail` —— 专门锁 `超时` 这个备选 */
const timeoutErrMsg = {
  status: 'rejected',
  reason: { errMsg: '请求超时' },
} as unknown as PromiseSettledResult<void>

/**
 * 结构化接口错误（`ApiError`）的形状：文案里出现 `network` / `timeout` 也不代表
 * 「没连上」—— 那是服务端回的错误信封，必须按真实错误处理。
 */
const apiErrorShape = {
  status: 'rejected',
  reason: Object.assign(new Error('network timeout'), {
    name: 'ApiError',
    code: 'UNAUTHENTICATED',
    status: 401,
  }),
} as unknown as PromiseSettledResult<void>

describe('mergeMarkReadResults', () => {
  test('部分成功：只回传成功的 id，不掩盖失败', () => {
    const { ok, firstError } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [settled.ok, settled.plainError],
      true,
    )

    expect([...ok]).toEqual(['n-1'])
    expect(firstError).not.toBeNull()
  })

  test('后端不可达且演示兜底打开：整批按已读处理（本地无后端是预期）', () => {
    const { ok } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [settled.unreachable, settled.unreachable],
      true,
    )

    expect([...ok]).toEqual(['n-1', 'n-2'])
  })

  test('后端不可达（真机的 errMsg 形状）同样按演示口径兜底', () => {
    const { ok } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [unreachableErrMsg, unreachableErrMsg],
      true,
    )

    expect([...ok]).toEqual(['n-1', 'n-2'])
  })

  test('中文超时文案（部分平台）同样算不可达', () => {
    const { ok } = mergeMarkReadResults(['n-1', 'n-2'], [timeoutErrMsg, timeoutErrMsg], true)

    expect([...ok]).toEqual(['n-1', 'n-2'])
  })

  test('结构化接口错误（ApiError）不算不可达：文案带 network 也不兜底', () => {
    const { ok, demoFallbackApplied } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [apiErrorShape, apiErrorShape],
      true,
    )

    expect(ok.size).toBe(0)
    expect(demoFallbackApplied).toBe(false)
  })

  test('混合批次（有的不可达、有的真实报错）：不兜底，一条都不冒充已读', () => {
    const { ok } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [settled.unreachable, settled.plainError],
      true,
    )

    expect(ok.size).toBe(0)
  })

  test('后端不可达但演示兜底关闭（真实构建）：如实返回空，不冒充已读', () => {
    const { ok } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [settled.unreachable, settled.unreachable],
      false,
    )

    expect(ok.size).toBe(0)
  })

  test('接口返回非网络错误（普通 Error）：即使演示兜底打开也不冒充已读', () => {
    const { ok } = mergeMarkReadResults(
      ['n-1', 'n-2'],
      [settled.plainError, settled.plainError],
      true,
    )

    expect(ok.size).toBe(0)
  })
})
