import { describe, expect, mock, test } from 'bun:test'

/**
 * 他人主页**整页**失败态的码（#607）。
 *
 * 修之前：`features/fetchers.ts` 的 `loadPublicUserHome` 把 `ApiError` 吞成裸
 * `{ status: 'failed' }`，页面只能渲染一句写死的「网络异常，请重试」—— 422（端上发了旧
 * 服务端不认的参数，#599）、401（会话失效）、5xx（服务端）在真机上一模一样，Owner 验收时
 * 看不到 Console 就没有任何线索（#607）。同页的分段列表（#598）早已把码写进文案，
 * 两条路径口径不一致正是这个 issue 的由来。
 *
 * 这里只替换 `@/features/user/api`：`isApiError` 的形状判据、`reportFailure`、
 * `segmentErrorSuffix` 的文案都走真实模块，用例钉的是「真实错误形状 → 真实返回值 → 端上文案」。
 * `__ALLOW_MOCK_FALLBACK__` 取 false：他人主页刻意没有 mock 回退（见 fetchers 的注释）。
 */

mock.module('@tarojs/taro', () => ({ default: {} }))

// 必须在动态 import 之前：`features/load-failure.ts` 在模块求值阶段就读这个常量。
Object.assign(globalThis, { __DEMO_AUTH__: false, __ALLOW_MOCK_FALLBACK__: false })

/** 形状对齐 `src/lib/request.ts` 的 `isApiError`：`name === 'ApiError'` + string code + number status。 */
class FakeApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/**
 * 两个端点的返回值用「模式」驱动：
 * - `null` → 解析成 `null`（后端说这个不存在，契约把非法 uuid 与不存在折成同一个 404）；
 * - 其它 → 按抛错处理。
 */
let profileFailure: unknown = null
let listingsFailure: unknown = null
/** `false` 时两个端点都正常返回，用来喂「存在性判断漂移」那一支。 */
let profileFound = false

const fakeProfile = { id: 'u-1', nickname: '小明', avatar: null, verified: false, stats: {} }

mock.module('@/features/user/api', () => ({
  fetchPublicUserProfile: () =>
    profileFailure === null
      ? Promise.resolve(profileFound ? (fakeProfile as never) : null)
      : Promise.reject(profileFailure),
  fetchPublicUserListings: () =>
    listingsFailure === null ? Promise.resolve(null) : Promise.reject(listingsFailure),
}))

const { loadPublicUserHome } = await import('../src/features/fetchers')
const { homeFailureText } = await import('../src/pkg-browse/pages/user/home-failure')

describe('loadPublicUserHome：失败态把 ApiError 的 code/status 交给页面（#607）', () => {
  test('422 / 401 / 5xx 各自把自己的码带回来，不再一律吞成「未知失败」', async () => {
    // 三档是 Owner 验收时要能区分的最小集：端上参数与服务端契约不符、会话失效、服务端挂了。
    const cases = [
      { status: 422, code: 'VALIDATION_FAILED' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 503, code: 'INTERNAL_ERROR' },
    ]

    for (const { status, code } of cases) {
      profileFailure = new FakeApiError(status, code, '服务端返回了错误信封')
      listingsFailure = profileFailure
      expect(await loadPublicUserHome('u-1')).toEqual({
        status: 'failed',
        error: { code, status },
      })
    }
  })

  test('断网 / 超时不是 ApiError → UNKNOWN + status 0（不编一个服务端码）', async () => {
    // `lib/request` 只在非 2xx 时抛 ApiError；`request:fail` 是原生错。
    profileFailure = new Error('request:fail timeout')
    listingsFailure = profileFailure

    expect(await loadPublicUserHome('u-1')).toEqual({
      status: 'failed',
      error: { code: 'UNKNOWN', status: 0 },
    })
  })

  test('页主注销（两个端点都说 null）→ notFound，与「没问到」的 failed 分开', async () => {
    // 404 不该显示码：它是空态（这个人没了），不是错误态。混成 failed 会把
    // 「后端挂了」说成「用户不存在」——#124 的老结论，这里只是把它钉住。
    profileFailure = null
    listingsFailure = null
    profileFound = false

    expect(await loadPublicUserHome('u-1')).toEqual({ status: 'notFound' })
  })

  test('存在性判断漂移（只有一个 null）→ failed 但 error 为 null，不借一个码充数', async () => {
    profileFailure = null
    listingsFailure = null
    profileFound = true

    expect(await loadPublicUserHome('u-1')).toEqual({ status: 'failed', error: null })
  })
})

describe('homeFailureText：整页失败态的正文（#607）', () => {
  test('有码时与分段那条路径共用同一句后缀', () => {
    expect(homeFailureText({ code: 'VALIDATION_FAILED', status: 422 })).toBe(
      '主页没加载出来（错误码 VALIDATION_FAILED 422）',
    )
    expect(homeFailureText({ code: 'UNAUTHENTICATED', status: 401 })).toContain('401')
    expect(homeFailureText({ code: 'INTERNAL_ERROR', status: 503 })).toContain('INTERNAL_ERROR')
  })

  test('网络异常翻成人话，不摆一个 status 0 出来', () => {
    // 整句钉死：`status: 0` 若被原样拼进文案，这里立刻变红
    expect(homeFailureText({ code: 'UNKNOWN', status: 0 })).toBe(
      '主页没加载出来（网络异常，请重试）',
    )
  })

  test('没有码时退到通用句：不留空括号、不出现 undefined', () => {
    expect(homeFailureText(null)).toBe('主页没加载出来，请稍后重试')
  })

  test('三条路径的文案两两不同：注销 / 网络 / 服务端各自可辨（#607 验收 ③）', () => {
    const texts = [
      // 注销走的是空态（`EmptyState`「用户不存在」），不在本函数里 —— 这里只钉住
      // 失败态里「网络」与「有码」两句不同，否则两档在端上还是一句话。
      homeFailureText({ code: 'UNKNOWN', status: 0 }),
      homeFailureText({ code: 'VALIDATION_FAILED', status: 422 }),
      homeFailureText(null),
    ]

    expect(new Set(texts).size).toBe(3)
  })
})

describe('接线：页面把码接进 LoadError，不再写死一句「网络异常」（#607）', () => {
  const page = Bun.file(new URL('../src/pkg-browse/pages/user/index.tsx', import.meta.url)).text()
  const fetchers = Bun.file(new URL('../src/features/fetchers.ts', import.meta.url)).text()

  function slice(code: string, from: string, to: string, nth = 0): string {
    let at = -1
    for (let i = 0; i <= nth; i++) {
      at = code.indexOf(from, at + 1)
      if (at < 0) throw new Error(`切片起点缺失：${from}`)
    }
    const end = code.indexOf(to, at + from.length)
    if (end < 0) throw new Error(`切片终点缺失：${to}（起点：${from}）`)
    return code.slice(at, end)
  }

  test('读取层：catch 里把码取出来，不吞成裸 failed', async () => {
    const body = slice(await fetchers, 'export async function loadPublicUserHome(', '\n}')

    // 删掉取码这一句 ⇒ `ApiError` 又变成无人认领的异常，页面回到写死文案（本用例变红）。
    expect(body).toContain("return { status: 'failed', error: publicUserFailureOf(error) }")
  })

  test('页面：failed 记进 state，LoadError 的正文由它算出来', async () => {
    const source = await page
    const load = slice(source, 'const load = useCallback(', 'const loadSegment = useCallback(')
    expect(load).toContain("setHomeError(result.status === 'failed' ? result.error : null)")

    const failed = slice(source, "{loadState === 'failed' ? (", ") : loadState === 'notFound' ? (")
    expect(failed).toContain('text={homeFailureText(homeError)}')
    // 写死文案会重新制造 #607：端上又只剩「网络异常，请重试」（注释里的复述不算）
    expect(failed).not.toContain('text="网络异常')
  })

  test('页面：注销仍然是独立的空态分支，不被并进失败态', async () => {
    const notFound = slice(
      await page,
      ") : loadState === 'notFound' ? (",
      ") : loadState === 'loading'",
    )
    expect(notFound).toContain('用户不存在')
    expect(notFound).toContain('已注销')
  })
})
