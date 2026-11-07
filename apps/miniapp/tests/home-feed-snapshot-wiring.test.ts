import { describe, expect, test } from 'bun:test'

/**
 * 「进页先上屏本地快照」在**源码层**的接线（#631）。
 *
 * `tests/home-feed-cache.test.ts` 锁的是快照器自己的行为（TTL / 身份 / 版本 / 坏字节），
 * 但下面这几件只在 `pages/home/index.tsx` 里看得见，写错了也不会报错：
 *
 * 1. 快照必须在**发请求之前**上屏 —— 顺序反过来，快照要等网络回来才上屏，
 *    这个单子就白做了（而且没人会从运行结果里看出来）。
 * 2. 读的 scope 必须和写的是**同一个分类**：写侧按分类落盘（`write(next, …)`），
 *    读侧写成固定 `'ALL'` 就会拿「推荐」的货去顶别的分类，8 个分类的 key 也永远没人读。
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
    expect(beforeRoundTrip).toContain('paintSnapshot(next)')
    // 同一次 `load()` 里不要重复画：`paintSnapshot` 的 `setLoadedFor` 还没生效，只能看 `lastGoodRef`
    expect(beforeRoundTrip).toContain(
      'if (lastGoodRef.current.loadedFor !== next) paintSnapshot(next)',
    )
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
    expect(paint).toContain('if (!snapshot) return')
    expect(paint).toContain('if (visible.length === 0) return')
  })

  test('身份指纹在请求发出前捕获，落盘在成功分支上', async () => {
    const text = code(await homeSource())
    expect(text.indexOf('const viewerAtRequest = homeFeedCache.viewer()')).toBeGreaterThanOrEqual(0)
    // 捕获要早于这次网络往返（`load()` 里第一条 await）
    expect(text.indexOf('const viewerAtRequest = homeFeedCache.viewer()')).toBeLessThan(
      text.indexOf('await loadHomeFeed'),
    )
    expect(text).toContain(
      'if (!result.failed) homeFeedCache.write(next, applied.items, viewerAtRequest)',
    )
  })
})
