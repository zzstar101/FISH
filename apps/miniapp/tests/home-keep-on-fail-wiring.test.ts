import { describe, expect, test } from 'bun:test'

/**
 * 「失败不清屏」在**源码层**的接线（#623 C 批的审查发现）。
 *
 * `tests/home-list-state.test.ts` 锁的是纯函数（`applyLoadResult` 拿到什么样的
 * `previous` 就给什么答案），锁不住下面这几件只在 `pages/home/index.tsx` 里看得见、
 * 写错了也不会报错的事：
 *
 * 1. **`previous` 必须是屏幕事实**：组件要真的把 `lastGoodRef.current` 传进去，且这个
 *    ref 每次落屏后**无条件**跟写。写成「只在成功时更新」会让它退化成「历史上成功过的
 *    那一批」——「按推荐成功 → 换分类失败清屏 → 再按推荐失败」时把早已清掉的列表复活，
 *    `failed` 还被压成 `false`，用户看到一次假成功（纯函数永远测不出这种错）。
 * 2. **留住旧数据时不能重置归因上下文**：那批商品来自上一次成功请求，`requestId` /
 *    `positions` 清成 `null` 之后，整屏商品在下次成功加载前一条 IMPRESSION 都不发。
 * 3. **重试入口不能断**：兜底态下 `failed` 是 `false`，只判 `failed` 的话
 *    「再点当前分类 = 重试」变成死代码，用户只剩下拉刷新一个入口。
 * 4. **下拉刷新必须告诉用户这次没刷上**：列表原地不动时，不弹 toast 就是纯静默失败。
 *
 * 断言一律跑在去掉注释之后的源码上（本文件注释里正逐条解释这些机制，只在原文上
 * `toContain` 的话把某行注释掉也能过）。
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

describe('首页失败兜底：源码层接线', () => {
  test('`load()` 把屏幕事实（lastGoodRef.current）当 previous 交给结转', async () => {
    const text = code(await homeSource())
    const call = slice(text, 'const applied = applyLoadResult({', '})')
    expect(call).toContain('previous: lastGoodRef.current')
    expect(call).toContain('failed: result.failed')
  })

  test('lastGoodRef 每次落屏后无条件跟写（不能只写成功那一支）', async () => {
    const text = code(await homeSource())
    // 旧写法：`if (!applied.failed) lastGoodRef.current = …` —— 会在清屏之后留下历史数据
    expect(text).not.toContain('if (!applied.failed)')
    expect(text).toContain(
      'lastGoodRef.current = { items: applied.items, loadedFor: applied.loadedFor }',
    )
    // 跟写必须发生在三件套落屏之前/之间，不能藏在成功分支里
    const tail = slice(text, 'lastGoodRef.current = {', 'setLoadedFor(applied.loadedFor)')
    expect(tail).toContain('setItems(applied.items)')
  })

  test('兜底态判定 `held`，并转成页面可见的 stale 标志', async () => {
    const text = code(await homeSource())
    expect(text).toContain('const held = result.failed && !applied.failed')
    expect(text).toContain('setStaleAfterFailure(held)')
  })

  test('留住旧数据时不重置归因上下文（否则整屏商品不再计曝光）', async () => {
    const text = code(await homeSource())
    // setFeedContext 必须被 `if (!held)` 包住
    const guarded = slice(text, 'if (!held) {', '}')
    expect(guarded).toContain('setFeedContext(')
    // 反过来：`applyLoadResult(...)` 之后到函数返回之间，不允许出现无条件的 setFeedContext
    const body = slice(text, 'const held = result.failed', 'return { failed: result.failed, held }')
    const unguarded = body.replace(guarded, '')
    expect(unguarded).not.toContain('setFeedContext(')
  })

  test('兜底态下「再点当前分类」仍然是重试入口', async () => {
    const text = code(await homeSource())
    const tap = slice(text, 'const onCategoryTap = (key: ListingCategory', 'setCategory(key)')
    expect(tap).toContain('if (failed || staleAfterFailure) void load(key)')
  })

  test('下拉刷新在兜底态（列表没动）时要明说这次没刷上', async () => {
    const text = code(await homeSource())
    const refresh = slice(text, 'usePullDownRefresh(() => {', 'const [left, right]')
    expect(refresh).toContain('if (outcome.held)')
    expect(refresh).toContain('Taro.showToast(')
    expect(refresh).toContain('Taro.stopPullDownRefresh()')
  })
})
