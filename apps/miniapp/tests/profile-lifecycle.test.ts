/**
 * Profile 页「返回刷新」(#170 D) 的判据与接线回归。
 *
 * 分两层：
 * - **判据层**：直接跑 `pages/profile/view.ts` 的纯函数（门禁、迟到作废、账号校验），
 *   把「什么时候允许发请求、什么响应算数」用行为用例钉死；
 * - **接线层**：读 `pages/profile/index.tsx` 的源码文本，钉住页面真的按这些判据接线，
 *   且**位置**正确（守卫必须在 setter / 发请求之前）。只钉「函数被调用过」不够：
 *   把守卫挪到 `setProfile` 之后，判据层照样全绿。
 *
 * 修复前的页面（`origin/main`）没有 `useDidShow`，接线层用例在它上面应当全红 ——
 * 见 PR 说明里的镜像反证。
 */
import { describe, expect, test } from 'bun:test'
import {
  acceptsRefreshedProfile,
  canLoad,
  isLatestLoad,
  isNotOlderThan,
  shouldRefreshOnShow,
} from '../src/pages/profile/view'

/** 页面源码（接线层只读文本，仓库没有 Taro 组件渲染基建） */
async function source(): Promise<string> {
  return Bun.file(new URL('../src/pages/profile/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

/** 断言 `first` 出现在 `second` 之前（两者都必须存在） */
function expectBefore(block: string, first: string, second: string): void {
  const i = block.indexOf(first)
  const j = block.indexOf(second)
  expect(i, `应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i, `${first} 应在 ${second} 之前`).toBeLessThan(j)
}

/** 返回刷新链的源码片段 */
function showBlock(code: string): string {
  return sliceFrom(code, 'useDidShow(() => {', '\n  })')
}

/** 登录态 effect 的源码片段（含序号前进与既有 C 的两处防串号） */
function loginEffect(code: string): string {
  return sliceFrom(
    code,
    'useEffect(() => {\n    loadSeqRef.current += 1',
    '}, [authStatus, authUser])',
  )
}

describe('#170 D 判据层：什么时候允许重拉', () => {
  test('冷启动首帧（unknown）不发受限请求', () => {
    expect(shouldRefreshOnShow({ firstShow: true, authed: false, userId: null })).toBe(false)
    expect(shouldRefreshOnShow({ firstShow: false, authed: false, userId: null })).toBe(false)
  })

  test('首次 show 一律跳过，让渡给登录态 effect', () => {
    expect(shouldRefreshOnShow({ firstShow: true, authed: true, userId: 'user-a' })).toBe(false)
  })

  test('非首次 show 且已登录才重拉', () => {
    expect(shouldRefreshOnShow({ firstShow: false, authed: true, userId: 'user-a' })).toBe(true)
  })

  test('状态与身份不一致时不重拉', () => {
    expect(shouldRefreshOnShow({ firstShow: false, authed: true, userId: null })).toBe(false)
    expect(shouldRefreshOnShow({ firstShow: false, authed: false, userId: 'user-a' })).toBe(false)
  })

  test('canLoad 只认「确定已登录且有身份」', () => {
    expect(canLoad(true, 'user-a')).toBe(true)
    expect(canLoad(false, 'user-a')).toBe(false)
    expect(canLoad(true, null)).toBe(false)
    expect(canLoad(false, null)).toBe(false)
  })
})

describe('#170 D 判据层：迟到 / 跨账号的响应不得落地', () => {
  test('isLatestLoad 只认最后一次', () => {
    expect(isLatestLoad(3, 3)).toBe(true)
    expect(isLatestLoad(2, 3)).toBe(false)
  })

  test('更旧的快照不覆盖已展示的更新快照', () => {
    // 首屏链更早发出（序号更小），弱网下更晚返回时不得盖掉返回刷新拿到的快照。
    expect(isNotOlderThan(2, 1)).toBe(true)
    expect(isNotOlderThan(1, 1)).toBe(true)
    expect(isNotOlderThan(1, 2)).toBe(false)
  })

  test('刷新失败（null）保留旧数据', () => {
    expect(acceptsRefreshedProfile(null, 'user-a', 'user-a')).toBe(false)
  })

  test('同一账号的响应才收下', () => {
    const next = { user: { id: 'user-a' }, stats: {} }
    expect(acceptsRefreshedProfile(next, 'user-a', 'user-a')).toBe(true)
  })

  test('换号后 A 的刷新响应不写进 B 的页面', () => {
    // 只比对 `next.user.id === forUserId` 会漏掉这一条：A 的响应在 B 登录后回来时，
    // 「响应属于 A」照样成立，所以必须再比一次「现在登录的还是不是 A」。
    const fromA = { user: { id: 'user-a' }, stats: {} }
    expect(acceptsRefreshedProfile(fromA, 'user-a', 'user-b')).toBe(false)
    expect(acceptsRefreshedProfile(fromA, 'user-a', null)).toBe(false)
  })

  test('响应本身就不属于发请求时的账号时也不收', () => {
    const fromB = { user: { id: 'user-b' }, stats: {} }
    expect(acceptsRefreshedProfile(fromB, 'user-a', 'user-a')).toBe(false)
  })
})

describe('#170 D 接线层：useDidShow 静默重拉', () => {
  test('页面注册了 useDidShow，且从 @tarojs/taro 引入', async () => {
    const code = await source()
    expect(code).toContain("import Taro, { useDidShow, usePageScroll } from '@tarojs/taro'")
    expect(code).toContain('useDidShow(() => {')
  })

  test('首次 show 跳过，之后每次 show 都尝试重拉', async () => {
    const code = await source()
    const block = showBlock(code)
    expect(block).toContain('const firstShow = skipFirstShowRef.current')
    expectBefore(
      block,
      'const firstShow = skipFirstShowRef.current',
      'skipFirstShowRef.current = false',
    )
    // 清除标志必须在门禁 return 之前：挪到之后会让标志永不清，之后每次 show 都被当首屏跳过（D 永久失效）
    expectBefore(block, 'skipFirstShowRef.current = false', '!shouldRefreshOnShow({')
    expect(block).toContain('shouldRefreshOnShow({')
    // 初值必须是 `true`（否则一进页就与登录态 effect 双发），且门禁要拿到真实的 firstShow
    expect(code).toContain('const skipFirstShowRef = useRef(true)')
    expect(block).toContain('firstShow,')
  })

  test('门禁在推进序号与发请求之前', async () => {
    const code = await source()
    const block = showBlock(code)
    expectBefore(block, 'shouldRefreshOnShow({', 'const seq = loadSeqRef.current + 1')
    expectBefore(block, 'shouldRefreshOnShow({', 'void loadProfile()')
    expectBefore(block, 'const seq = loadSeqRef.current + 1', 'void loadProfile()')
    // 极性：门禁为假才继续（去掉 `!` 会让第二次 show 直接 return，D 永不生效）
    expect(block).toContain('!shouldRefreshOnShow({')
    // 序号必须写回 ref：漏掉 `= seq` 时 `isLatestLoad` 恒假，返回刷新永不落地
    expectBefore(block, 'const seq = loadSeqRef.current + 1', 'loadSeqRef.current = seq')
    expectBefore(block, 'loadSeqRef.current = seq', 'void loadProfile()')
  })

  test('刷新链只有一条请求，且携带发请求时的账号', async () => {
    const code = await source()
    const block = showBlock(code)
    expect(block.split('void loadProfile()').length - 1).toBe(1)
    expect(block).toContain('const forUserId = currentUserId')
  })

  test('两条守卫都在 setProfile 之前，且序号守卫在前', async () => {
    const code = await source()
    const block = showBlock(code)
    expectBefore(
      block,
      'isLatestLoad(seq, loadSeqRef.current)',
      'acceptsRefreshedProfile(next, forUserId, userIdRef.current)',
    )
    expectBefore(
      block,
      'acceptsRefreshedProfile(next, forUserId, userIdRef.current)',
      'setProfile(next)',
    )
  })

  test('静默刷新：show 链不清空 profile（不闪 —）', async () => {
    const code = await source()
    const block = showBlock(code)
    expect(block).not.toContain('setProfile(null)')
    expect(block).not.toContain("setLoadState('loading')")
  })

  test('刷新失败保留旧数据：null 由守卫挡下，直接 return', async () => {
    const code = await source()
    const block = showBlock(code)
    expect(block).toContain(
      'if (!acceptsRefreshedProfile(next, forUserId, userIdRef.current)) return',
    )
  })

  test('登录态与账号 ref 每帧同步，且都排在 useDidShow 之前', async () => {
    const code = await source()
    expect(code).toContain("authedRef.current = authStatus === 'authed'")
    expect(code).toContain('userIdRef.current = authUser?.id ?? null')
    expectBefore(code, "authedRef.current = authStatus === 'authed'", 'useDidShow(() => {')
    expectBefore(code, 'userIdRef.current = authUser?.id ?? null', 'useDidShow(() => {')
  })
})

describe('#170 D 接线层：在途刷新被换号与卸载作废', () => {
  test('登录态 effect 先推进序号，再清场', async () => {
    const code = await source()
    const effect = loginEffect(code)
    expectBefore(effect, 'loadSeqRef.current += 1', 'setProfile(null)')
  })

  test('既有 C 口径不回退：清场 + cancellable 只认同一账号', async () => {
    const code = await source()
    const effect = loginEffect(code)
    expect(effect).toContain('setProfile(null)')
    expect(effect).toContain('cancellable(')
    expect(effect).toContain('next.user.id === forUserId')
    expect(effect).toContain('return load.cancel')
  })

  test('卸载让序号前进（在途响应不再写状态）', async () => {
    const code = await source()
    expect(code).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*loadSeqRef\.current \+= 1,?\s*\},\s*\[\],?\s*\)/,
    )
    // 只有登录态 effect 与卸载两处推进序号（返回刷新走的是 `= seq` 形式，见上一条用例）
    expect(code.split('loadSeqRef.current += 1').length - 1).toBe(2)
  })

  test('更早发出、更晚返回的首屏响应不得覆盖返回刷新的快照', async () => {
    const code = await source()
    const effect = loginEffect(code)
    // 首屏链：`seq` 必须绑定到刚推进的计数器（写成 `+ 1` 或 `shownSeqRef.current` 都会让比较形同虚设），
    // 且落地前比一次「已展示的序号」
    expect(effect).toContain('const seq = loadSeqRef.current\n')
    expect(effect).toContain('isNotOlderThan(seq, shownSeqRef.current)')
    expectBefore(effect, 'if (!next) return', 'shownSeqRef.current = seq')
    expectBefore(effect, 'shownSeqRef.current = seq', 'setProfile(next)')
    // 刷新链：落地时同样记账，否则首屏那份更旧的快照会把它盖回去
    const block = showBlock(code)
    expectBefore(
      block,
      'acceptsRefreshedProfile(next, forUserId, userIdRef.current)',
      'shownSeqRef.current = seq',
    )
    expectBefore(block, 'shownSeqRef.current = seq', 'setProfile(next)')
  })

  test('范围边界：本页没有「写入在飞延后」机器', async () => {
    const code = await source()
    expect(code).not.toContain('DeferredReload')
    expect(code).not.toContain('pendingWrites')
    expect(code).not.toContain('deferredRefresh')
  })

  test('旧的「后续改动」注释随实现删除', async () => {
    const code = await source()
    expect(code).not.toContain('要更实时就得加')
    expect(code).not.toContain('属于后续改动')
  })
})
