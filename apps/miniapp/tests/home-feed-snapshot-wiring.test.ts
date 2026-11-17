import { describe, expect, test } from 'bun:test'

/**
 * 「进页先上屏本地快照」在**源码层**的接线（#631）。
 *
 * `tests/home-feed-cache.test.ts` 锁的是快照器自己的行为（TTL / 身份 / 版本 / 坏字节），
 * 但下面这几件只在 `pages/home/index.tsx` 里看得见，写错了也不会报错：
 *
 * 1. 快照必须在**发请求之前**上屏 —— 顺序反过来，快照要等网络回来才上屏，
 *    这个单子就白做了（而且没人会从运行结果里看出来）。
 * 2. 只有**进页那条路径**（`next === 'ALL'`）读写快照：切分类照旧骨架屏（Owner 拍板，
 *    分类列表先上屏一份可能已售的旧货更容易让人误判）。读写两侧的判据必须一致，
 *    写成「写所有分类、只读推荐」就是白付同步写盘。
 * 3. 快照上屏时**归因上下文必须置空**：快照没有 `requestId` / `positions`，忘了清就会
 *    拿上一次会话的 requestId 给这批卡发 IMPRESSION / QUICK_SKIP —— 契约禁止。
 * 4. 身份指纹要在**请求发出时**捕获、写入时比对：写成「写入时才取身份」（草稿的实现）
 *    会在请求在途被换账号时把上一个账号的列表写到新身份名下。
 * 5. 只有**这次真的成功**（`failed` 为 false）那一次落盘：`held` 落的是上一次的数据，
 *    重写还会把 `savedAt` 刷成「刚刚」。
 *
 * 断言一律跑在去掉注释之后的源码上（本文件注释里正逐条解释这些机制）。
 */

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
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

describe('首页进页快照：源码层接线', () => {
  test('`load()` 先画快照，再发请求', async () => {
    const text = code(await homeSource())
    // 进页与切分类都走 `load()`，所以快照上屏必须排在这次网络往返之前
    const beforeRoundTrip = slice(text, 'const load = async (', 'await loadHomeFeed')
    /*
      只有「推荐」有快照：切分类照旧骨架屏（Owner 拍板的口径，别悄悄扩成九个分类）。
      判据是「屏幕上现在什么都没有」而不是「当前分类不是推荐」—— 后者会让切回「推荐」时
      拿 24 条快照顶掉刚拉到的 50 条，列表先缩再涨。
      第二个实参是「保住已挂出的批量」的信号（#595 身份重置深滚），不影响这里的判据。
    */
    expect(beforeRoundTrip).toContain("next === 'ALL' && lastGoodRef.current.items.length === 0")
    expect(beforeRoundTrip).toContain('paintSnapshot(next, keepMountCount)')
    // 进页那条入口仍然只是拉「推荐」
    expect(slice(text, 'useLoad(() => {', '})')).toContain("void load('ALL')")
  })

  test('快照上屏时把归因上下文置空，并让它成为屏幕事实', async () => {
    const text = code(await homeSource())
    const paint = slice(text, 'const paintSnapshot = ', 'const load = async (')
    // 读的 scope 就是调用方传进来的那个分类 —— 与 `write(next, …)` 的 scope 同源
    expect(paint).toContain('homeFeedCache.read(scope)')
    expect(paint).toContain('setFeedContext({ requestId: null, positions: new Map() })')
    expect(paint).toContain('lastGoodRef.current = { items: visible, loadedFor: scope }')
    // 本机「不感兴趣」名单优先：快照里可能还留着别处隐藏掉的卡
    expect(paint).toContain('readHiddenListingIds()')
    // 没有快照 / 全被隐藏就是不画 —— 页面照旧走骨架屏
    expect(paint).toContain('if (!snapshot) return false')
    expect(paint).toContain('if (visible.length === 0) return false')
  })

  test('快照顶上的那一屏请求失败时要说明这是旧数据', async () => {
    const text = code(await homeSource())
    /*
      进页命中快照 + 这次失败：列表被 `held` 留住、页面不出现错误块，屏幕上就没有任何
      「这是半小时前的货」的信号 —— 只有下拉刷新才有一条 toast。这里补的正是进页这一次。
    */
    expect(text).toContain('if (paintedSnapshot && result.failed) {')
    expect(text).toContain("Taro.showToast({ title: '网络不太行，先看上次的', icon: 'none' })")
  })

  test('身份指纹在请求发出前捕获，落盘在成功分支上', async () => {
    const text = code(await homeSource())
    expect(text.indexOf('const viewerAtRequest = homeFeedCache.viewer()')).toBeGreaterThanOrEqual(0)
    // 捕获要早于这次网络往返（`load()` 里第一条 await）
    expect(text.indexOf('const viewerAtRequest = homeFeedCache.viewer()')).toBeLessThan(
      text.indexOf('await loadHomeFeed'),
    )
    expect(text).toContain("if (!result.failed && next === 'ALL') {")
    expect(text).toContain('homeFeedCache.write(next, applied.items, viewerAtRequest)')
  })
})
