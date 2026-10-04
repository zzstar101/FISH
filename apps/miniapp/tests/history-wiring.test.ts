import { describe, expect, test } from 'bun:test'

/**
 * 「历史浏览」页接线层的回归（纯逻辑在 `history-records.test.ts` / `history-real.test.ts`）。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（先例
 * `tests/following-wiring.test.ts` / `tests/profile-lifecycle.test.ts`）。这里钉审查
 * 指出的四条最容易做错的接线：
 * 1. 清空失败**不做任何本地翻转**（只在 catch 里 toast 服务端文案）；
 * 2. 清空成功先作废在飞请求、再清本地状态（否则迟到的 GET 会把已清掉的列表画回来）；
 * 3. 换号渲染期重置把 real 相关状态全部清掉（不串上一个账号的足迹）；
 * 4. 「加载更多」的 updater 在 ownerId 对不上时**不追加**（迟到页不落到新账号）。
 */

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/history/index.tsx', import.meta.url)).text()
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

describe('历史浏览：接线', () => {
  test('清空失败分支不做任何本地翻转（只 toast 服务端文案）', async () => {
    const code = await source()
    const clearTab = sliceFrom(code, 'const clearTab = () => {', '})()')
    const fail = sliceFrom(clearTab, '} catch (error) {', "'清空失败，请重试')")

    expect(fail).toContain('toast(')
    // 失败不本地翻转：catch 里一个 set* / realRef 写都不许有（本地删几行再回滚是假接线）
    expect(fail).not.toMatch(/\bset[A-Z]\w*\(/)
    expect(fail).not.toContain('realRef.current =')
  })

  test('清空成功：先作废在飞请求（取消句柄），再清本地状态并收指示器', async () => {
    const code = await source()
    const clearTab = sliceFrom(code, 'const clearTab = () => {', '})()')
    const success = sliceFrom(clearTab, 'await clearMyViewHistory()', 'toast(clearDoneOf(tab))')

    expect(success).toContain('pendingFirst.current?.()')
    expect(success).toContain('pendingMore.current?.()')
    // 顺序必须是「先取消、后清状态」：反了的话迟到的 GET / 加载更多仍会把列表画回来
    expectBefore(success, 'pendingFirst.current?.()', 'setRealHistory(null)')
    expectBefore(success, 'pendingMore.current?.()', 'setRealHistory(null)')
    // 取消在飞请求后没有结果会来收原生指示器，这条路径要自己收
    expect(success).toContain('void Taro.stopPullDownRefresh()')
  })

  test('换号渲染期重置清掉 real 相关状态与在飞句柄', async () => {
    const code = await source()
    const reset = sliceFrom(code, 'if (prevScopeUser !== userId) {', 'setRealLoading(!demo)')

    expect(reset).toContain('pendingFirst.current?.()')
    expect(reset).toContain('pendingMore.current?.()')
    expect(reset).toContain('realRef.current = null')
    expect(reset).toContain('setRealHistory(null)')
    expect(reset).toContain('setRealFetchFailed(false)')
    expect(reset).toContain('setRealCleared(false)')
    expect(reset).toContain('setLoadingMore(false)')
  })

  test('「加载更多」updater 校验 ownerId，不追加别的账号的页', async () => {
    const code = await source()
    const loadMore = sliceFrom(code, 'const loadMore = () => {', "toast('没加载出来，请重试')")
    const updater = sliceFrom(
      loadMore,
      'setRealHistory((prev) => {',
      'mergeHistoryItems(prev.items, page.items)',
    )

    // 换号后旧账号那一页迟到：ownerId 对不上必须原样返回，不能追加
    expect(updater).toContain('if (prev === null || prev.ownerId !== forUserId) return prev')
    expectBefore(
      updater,
      'if (prev === null || prev.ownerId !== forUserId) return prev',
      'mergeHistoryItems(prev.items, page.items)',
    )
    // 追加必须走去重合并（同一天跨页 + 并发写入下重复下发的行不能出现两张格）
    expect(updater).toContain('mergeHistoryItems(prev.items, page.items)')
  })

  test('「已清空」标记按档位收口：清空浏览记录不能把收藏 / 留言档也说成已清空', async () => {
    const code = await source()
    const emptyKind = sliceFrom(code, 'const emptyKind: EmptyKind =', ')')

    /*
      真实构建只有浏览档能清（`canClearTab(false, tab) === false` 对收藏 / 留言成立），
      `realCleared` 却是整页一个布尔量。不收口的话「清空浏览记录 → 切到空的收藏档」
      会渲染成「收藏已清空」—— 用户根本没清过收藏，属于无中生有。
    */
    expect(emptyKind).toContain("realCleared && tab === 'history'")
  })

  test('收藏 / 留言两档各自取数：都走翻页取全，且带 ownerId 作用域校验', async () => {
    const code = await source()
    const effect = sliceFrom(
      code,
      '真实构建 · 收藏档 / 留言档取数',
      '}, [demo, tab, authStatus, userId, reloadToken])',
    )

    // 两档分别打各自的读端点（不能只接一档、也不能用浏览档的端点顶替）
    expect(effect).toContain('fetchMyFavorites(cursor)')
    expect(effect).toContain("fetchMyComments({ kind: 'all', cursor })")
    // 翻页取全：共用 `fetchAllPages`
    expect(effect).toContain('fetchAllPages(')
    // 迟到结果按 ownerId 丢弃（换号后旧账号那一档不能落到新账号上）
    expect(effect).toContain('(next) => next.ownerId === forUserId')
  })
})
