import { describe, expect, test } from 'bun:test'

/**
 * 「身份变了之后首页列表重建」在**源码层**的接线（#650 退出/401，#652 扩展登录与换号）。
 *
 * 这条链上每一环都写得出来、也都不报错，但错一环用户看到的就是上一个账号的商品：
 *
 * 1. **订阅必须挂在 `useLoad`**：身份变化经常在首页**不可见**时发生（在设置页点「退出登录」
 *    再登录成另一个账号），挂到 `useDidShow` 上要等用户切回来才补，中间它照样挂着旧身份的数据。
 *    订阅的是 `onSessionChanged`（会话真的变了）而不是 auth store 的快照：后者每次
 *    `emit()` 都变，改个昵称/头像也会通知，首页就被无谓地打回骨架屏重拉一次。
 * 2. **回调要走 ref 镜像**：订阅一辈子只注册一次，直接传函数就把闭包钉在注册那次渲染上 ——
 *    用户切到「教材书籍」再退出登录，重拉的还是进页时的「推荐」。
 * 3. **在途可见段要丢弃、不要结算**：结算会把上一个身份看到的停留补发成 IMPRESSION /
 *    QUICK_SKIP，而服务端按投递那一刻的 cookie 定归属 → 记到新账号头上（`recommendation/queue`
 *    在身份变化时清队列正是为了这件事）。所以 `discardAll()` 必须发生在清 `feedContext` **之前**：
 *    `use-impressions` 里那条 effect 会把「requestId 与当前上下文不同」的段就地结算掉。
 * 4. **重拉的是当前分类，不是写死的 `ALL`**：`load('ALL')` 会把 `loadedFor` 记成 `ALL`，而
 *    `category` 还停在别的档上 → `homeListState` 恒给骨架屏，重拉成功了也还是骨架屏。
 * 5. **本机「不感兴趣」名单不动**：那是本机口径，不跟着账号走。
 * 6. **旧身份的在途响应不许落地**：判定必须比的是「请求发出时的身份」与「落地时的身份」，
 *    不能只靠 `reqSeq` —— 那是「又发了一次请求」的意思，不是「换了个人」的意思。
 *
 * 断言一律跑在去掉注释之后的源码上（本文件注释里正逐条解释这些机制，只在原文上 `toContain`
 * 的话把某行注释掉也能过）。本仓 `tests/` 没有 Taro 组件渲染基建，页面接线这一层历来靠
 * 源码层用例 + code review 兜（同 `tests/home-keep-on-fail-wiring.test.ts`）。
 */

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
}

async function impressionsSource(): Promise<string> {
  return await Bun.file(
    new URL('../src/features/recommendation/use-impressions.ts', import.meta.url),
  ).text()
}

/** 去掉注释后的源码 —— 断言必须看**代码**。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 取 `from` 之后到其后第一个 `to` 之间的代码（两端都不含） */
function slice(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  expect(start, `代码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `代码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

/** `resetForIdentityChange` 的函数体 */
async function resetBody(): Promise<string> {
  return slice(code(await homeSource()), 'const resetForIdentityChange = () => {', '\n  }')
}

describe('#650/#652 身份变了之后首页重建：源码层接线', () => {
  test('清列表前保留当前滚动所需的页面高度，当前请求落地后释放', async () => {
    const body = await resetBody()
    expect(body).toContain('scrollTopRef.current + homeViewportHeightRef.current')
    // 身份回调可能发生在别的页面上；不能在这里重新读取当前页几何来撑首页。
    expect(body).not.toContain('Taro.getWindowInfo()')
    const shown = slice(code(await homeSource()), 'useDidShow(() => {', '\n  })')
    expect(shown).toContain('homeViewportHeightRef.current = Taro.getWindowInfo().windowHeight')
    expect(body.indexOf('setIdentityScrollHeight(')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('setIdentityScrollHeight(')).toBeLessThan(body.indexOf('setItems([])'))
    const text = code(await homeSource())
    expect(text).toMatch(/minHeight: `\$\{identityScrollHeight\}px`/)
    const load = slice(text, 'const load = async', 'const categoryRef')
    expect(load.indexOf('setIdentityScrollHeight(null)')).toBeGreaterThan(
      load.indexOf('viewerAtRequest !== homeFeedCache.viewer()'),
    )
    expect(load).toContain('setIdentityScrollHeight(null)')
  })

  test('首页订阅「本地身份变了」，且订阅装在 `useLoad` 里', async () => {
    const text = code(await homeSource())
    // 一条通道覆盖全部方向：登录 / 匿名→已登录 / A→B / 主动退出 / 401 撤销
    expect(text).toContain("import { onSessionChanged } from '@/lib/session'")
    expect(slice(text, 'useLoad(() => {', '\n  })')).toContain('onSessionChanged(')
    // 挂在 useLoad 而不是 useDidShow：身份可能在页面不可见时变
    expect(slice(text, 'useDidShow(() => {', '\n  })')).not.toContain('onSessionChanged')
    // `onSessionChanged` 已经包含「被清掉」，再挂一条 `onSessionCleared` 就是同一次变化重置两遍
    expect(text).not.toContain('onSessionCleared')
  })

  test('回调走 ref 镜像，订阅只注册一次也总能调到最新闭包', async () => {
    const text = code(await homeSource())
    expect(text).toContain('const resetRef = useRef(resetForIdentityChange)')
    expect(text).toContain('resetRef.current = resetForIdentityChange')
    expect(text).toContain('onSessionChanged(() => resetRef.current())')
    // 直接传函数 = 闭包钉在注册那次渲染上，读不到之后的 category
    expect(text).not.toContain('onSessionChanged(resetForIdentityChange)')
  })

  test('作废屏幕事实、归因上下文与在途可见段', async () => {
    const body = await resetBody()
    expect(body).toContain('impressions.discardAll()')
    expect(body).toContain('lastGoodRef.current = { items: [], loadedFor: null }')
    expect(body).toContain('setFeedContext({ requestId: null, positions: new Map() })')
    expect(body).toContain('setItems([])')
    expect(body).toContain('setLoadedFor(null)')
    // 本机「不感兴趣」名单是跨账号的本机口径，不能跟着身份一起清
    expect(body).not.toContain('setHiddenIds')
  })

  test('先丢弃在途可见段，再清归因上下文（顺序反了就等于把旧身份的曝光补发出去）', async () => {
    const body = await resetBody()
    const discarded = body.indexOf('impressions.discardAll()')
    const contextCleared = body.indexOf('setFeedContext({ requestId: null')
    expect(discarded).toBeGreaterThanOrEqual(0)
    expect(contextCleared).toBeGreaterThanOrEqual(0)
    expect(discarded).toBeLessThan(contextCleared)
  })

  test('重拉当前分类，不写死 `ALL`', async () => {
    const body = await resetBody()
    expect(body).toContain('void load(categoryRef.current)')
    expect(body).not.toContain("load('ALL')")
    const text = code(await homeSource())
    expect(text).toContain("const categoryRef = useRef<ListingCategory | 'ALL'>(category)")
    expect(text).toContain('categoryRef.current = category')
  })

  test('旧身份的在途响应不许落地：比「发出时的身份」与「落地时的身份」，不是只看序号', async () => {
    const text = code(await homeSource())
    const body = slice(text, 'const load = async (', '\n    return { failed: result.failed, held }')
    const gate =
      'if (viewerAtRequest !== homeFeedCache.viewer()) return { failed: false, held: false }'
    expect(body).toContain(gate)
    // 序号检查之后（先按「又发了一次」丢掉过期结果）、任何一次上屏之前
    expect(body.indexOf(gate)).toBeGreaterThan(body.indexOf('if (seq !== reqSeq.current)'))
    expect(body.indexOf(gate)).toBeLessThan(body.indexOf('applyLoadResult('))
  })

  test('页面卸载时摘掉订阅（迟到的清理不该写已销毁的页面）', async () => {
    const text = code(await homeSource())
    const unload = slice(text, 'useUnload(() => {', '\n  })')
    expect(unload).toContain('unsubscribeSessionRef.current?.()')
    expect(unload).toContain('unsubscribeSessionRef.current = null')
  })

  test('`discardAll()` 停掉计时器、清空账本，但一条事件都不发', async () => {
    const text = code(await impressionsSource())
    const body = slice(text, 'const discardAll = useCallback(() => {', '\n  }, [])')
    expect(body).toContain('clearTimeout(segment.timer)')
    expect(body).toContain('segmentsRef.current.clear()')
    // 发任何一条都是把上一个身份的停留记到新账号头上
    expect(body).not.toContain('settle(')
    expect(body).not.toContain('emitImpression')
    expect(body).not.toContain('trackRecommendationEvent')
    // 得从 hook 的返回值里露出来，页面才用得上
    expect(text).toContain('return { markOpened, settleListing, discardAll }')
  })
})
