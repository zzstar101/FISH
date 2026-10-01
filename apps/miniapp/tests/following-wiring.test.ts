/**
 * 「我的关注」页的**接线层**回归（判据层的纯函数在 `following-load.test.ts`）。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（与
 * `tests/profile-lifecycle.test.ts` 的接线层同一手法）。这里钉两条**审查发现**：
 *
 * 1. **从他人主页返回要重拉**：本页可以点进 `/pages/user`，那边能关注 / 取关。只在挂载时
 *    取数（原来的写法）会让返回后的列表与 `total` / `mutualTotal` 停在旧值 —— 验收要求
 *    「关注/取关与计数同源、重进状态一致」。所以取数必须由 `useDidShow` 驱动。
 * 2. **迟到的首屏回包不能写进新账号**：`runLoad` 的 `setLoad` 之前必须先比对 `accountSeq`
 *    （换号 / 退出时自增），否则「先下拉刷新、再点加载更多」顶掉取消句柄后，旧账号的首屏
 *    结果会落到新账号界面上。
 */
import { describe, expect, test } from 'bun:test'

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pages/following/index.tsx', import.meta.url)).text()
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
  expect(i, `块里应出现 ${first}`).toBeGreaterThanOrEqual(0)
  expect(j, `块里应出现 ${second}`).toBeGreaterThanOrEqual(0)
  expect(i).toBeLessThan(j)
}

describe('我的关注：接线', () => {
  test('取数由 useDidShow 驱动（进页 + 从他人主页返回都重拉）', async () => {
    const code = await source()

    expect(code).toContain('useDidShow(')
    // 取数 effect 必须挂在 showToken 上：没有它，useDidShow 触发了也白搭
    const effect = sliceFrom(
      code,
      'useDidShow(() => setShowToken',
      '}, [showToken, authStatus, userId, runLoad])',
    )
    expect(effect).toContain('showToken === null')
    expect(effect).toContain('void runLoad()')
  })

  test('换号时自增 accountSeq（在渲染期清场里）', async () => {
    const code = await source()
    const reset = sliceFrom(code, 'if (prevUserId !== userId) {', 'accountSeq.current += 1')
    expect(reset).toContain("setLoad({ kind: 'loading' })")
  })

  test('runLoad 在 setLoad 之前比对 accountSeq（迟到的旧账号回包被丢弃）', async () => {
    const code = await source()
    const runLoad = sliceFrom(code, 'const runLoad = useCallback', '}, [loadFirstPage])')

    expect(runLoad).toContain('const seq = accountSeq.current')
    expectBefore(runLoad, 'if (accountSeq.current !== seq) return', 'setLoad(next)')
  })

  test('「加载更多」把「被取消」与「真失败」分开（取消不渲染成页脚错误）', async () => {
    const code = await source()
    const loadMore = sliceFrom(
      code,
      'const loadMore = async () => {',
      "setLoad((prev) => (prev.kind === 'ready' ? mergeFollowingPage(prev, page) : prev))",
    )

    // runLoad 刷新时会 cancel 在飞的这一发；cancellable 对取消与失败都给 null，
    // 不先判 isCancelled 就会把一次正常刷新画成「没加载出来 · 重试」
    expectBefore(loadMore, 'if (run.isCancelled()) return', 'setMoreError(true)')
  })

  test('「加载更多」有自己的取消句柄，不顶掉首屏那一发', async () => {
    const code = await source()
    const loadMore = sliceFrom(
      code,
      'const loadMore = async () => {',
      "setLoad((prev) => (prev.kind === 'ready' ? mergeFollowingPage(prev, page) : prev))",
    )

    expect(loadMore).toContain('pendingMore.current = run.cancel')
    expect(loadMore).not.toContain('pending.current = run.cancel')
    expectBefore(
      loadMore,
      'if (accountSeq.current !== seq) return',
      "setLoad((prev) => (prev.kind === 'ready' ? mergeFollowingPage(prev, page) : prev))",
    )
  })
})
