import { describe, expect, test } from 'bun:test'

/**
 * 「回到顶部」钮在**内滚容器**页面上的接线（#237 复查 P2）。
 *
 * 共享组件 `components/back-top` 是纯 UI：它不监听滚动，`show` 与回顶都由页面按自己的
 * 滚动源算。于是每个接入页都要回答同一个问题 —— **本页到底是页面级滚动还是内滚容器**。
 *
 * 回答错了不会有任何编译或运行时错误，只是能力静默失效：`watchers` 的名单在
 * `.wt__scroll`（页面根 `.wt` 是 `height:100vh; overflow:hidden`）里滚动，页面本身
 * 不滚，于是 `usePageScroll` 永远收不到事件（钮不出现）、`Taro.pageScrollTo` 也够不到
 * 那个容器（钮出现了也回不去）。演示时名单短、滚不动，这一条同样看不出来。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，只能读源码钉住接线（先例
 * `tests/user-list-end.test.ts` 的「页面接线」段）。这里钉的是**滚动源的选择**：
 * 内滚页必须走容器 `onScroll` + `scrollIntoView`，且不得再留 `usePageScroll`。
 */

async function watchersSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/watchers/index.tsx', import.meta.url)).text()
}

/**
 * 去掉注释后的源码。
 *
 * 「不得再用页面级滚动源」这类**反面**断言必须看在代码上：本页的注释里正解释着
 * 「为什么 `usePageScroll` / `Taro.pageScrollTo` 在这里失效」，拿原文断言会把这段
 * 说明当成违规实现。
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function watchersStyle(): Promise<string> {
  return await Bun.file(new URL('../src/pages/watchers/index.scss', import.meta.url)).text()
}

describe('watchers 回顶钮的滚动源（内滚容器）', () => {
  test('本页确实是内滚容器：根节点满屏 + 裁切，名单在 `.wt__scroll` 里滚', async () => {
    const style = await watchersStyle()
    const root = style.slice(style.indexOf('.wt {'), style.indexOf('.wt__bg'))
    // 页面不滚（`height:100vh` + `overflow:hidden`），所以页面级滚动源在这里必然失效
    expect(root).toContain('height: 100vh')
    expect(root).toContain('overflow: hidden')
    expect(style).toContain('.wt__scroll')
  })

  test('不再用页面级滚动源（`usePageScroll` / `Taro.pageScrollTo` 都够不到内滚容器）', async () => {
    const source = code(await watchersSource())
    expect(source).not.toContain('usePageScroll')
    expect(source).not.toContain('pageScrollTo')
  })

  test('显示判据挂在 ScrollView 的 onScroll 上，阈值仍取自共享组件', async () => {
    const source = await watchersSource()
    expect(source).toContain("from '@/components/back-top'")
    expect(source).toContain('BACK_TOP_THRESHOLD')
    expect(source).toContain('onScroll={onScroll}')
    // 判据来自事件里的 scrollTop，而不是页面级钩子
    expect(source).toContain('e.detail.scrollTop')
    expect(source).toContain('setShowTop(')
  })

  test('回顶走 scrollIntoView 双锚点交替：连点两次也能真的回顶', async () => {
    const source = await watchersSource()
    expect(source).toContain('scrollIntoView={topAnchor}')
    expect(source).toContain('id="wt-top-a"')
    expect(source).toContain('id="wt-top-b"')
    // 交替指：同值不会重触发滚动，所以不能写成固定常量
    expect(source).toContain("prev === 'wt-top-a' ? 'wt-top-b' : 'wt-top-a'")
    expect(source).toContain('onTop={backToTop}')
  })
})
