import { describe, expect, test } from 'bun:test'

/**
 * 「进页先上屏本地快照」在**源码层**的接线（#631）。
 *
 * `tests/home-feed-cache.test.ts` 锁的是快照器自己的行为（TTL / 身份 / 版本 / 坏字节），
 * 但下面这几件只在 `pages/home/index.tsx` 里看得见，写错了也不会报错：
 *
 * 1. `useLoad` 必须**先画快照再发请求** —— 顺序反过来，快照要等网络回来才上屏，
 *    这个单子就白做了（而且没人会从运行结果里看出来）。
 * 2. 快照上屏时**归因上下文必须置空**：快照没有 `requestId` / `positions`，忘了清就会
 *    拿上一次会话的 requestId 给这批卡发 IMPRESSION / QUICK_SKIP —— 契约禁止。
 * 3. 身份指纹要在**请求发出时**捕获、写入时比对：写成「写入时才取身份」（草稿的实现）
 *    会在请求在途被换账号时把上一个账号的列表写到新身份名下。
 * 4. 只有**这次真的成功**（`failed` 为 false）那一次落盘：`held` 落的是上一次的数据，
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
  test('`useLoad` 先画快照，再发请求', async () => {
    const text = code(await homeSource())
    const body = slice(text, 'useLoad(() => {', '})')
    const paint = body.indexOf('paintEntrySnapshot()')
    const load = body.indexOf("void load('ALL')")
    expect(paint).toBeGreaterThanOrEqual(0)
    expect(load).toBeGreaterThan(paint)
  })

  test('快照上屏时把归因上下文置空，并让它成为屏幕事实', async () => {
    const text = code(await homeSource())
    const paint = slice(text, 'const paintEntrySnapshot = ', 'useLoad(() => {')
    // 读的 scope 必须和 `load()` 落盘用的那个分类一致（进页时 `category` 恒为 ALL）
    expect(paint).toContain('homeFeedCache.read(category)')
    expect(paint).toContain('setFeedContext({ requestId: null, positions: new Map() })')
    expect(paint).toContain('lastGoodRef.current = { items: visible, loadedFor: category }')
    // 本机「不感兴趣」名单优先：快照里可能还留着别处隐藏掉的卡
    expect(paint).toContain('readHiddenListingIds()')
    // 没有快照就是不画 —— 页面照旧走骨架屏
    expect(paint).toContain('return false')
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
