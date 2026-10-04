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
 * `tests/user-list-end.test.ts` 的「页面接线」段）。断言**切到具体片段**再查，不查整份
 * 文件 —— 整份文件的子串命中挡不住「属性挂错了元素」「锚点挪到了列表末尾」这类改法。
 */

async function watchersSource(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-browse/pages/watchers/index.tsx', import.meta.url),
  ).text()
}

async function watchersStyle(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-browse/pages/watchers/index.scss', import.meta.url),
  ).text()
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

/** 取 `from` 到其后第一个 `to` 之间的源码（两端都不含） */
async function slice(from: string, to: string): Promise<string> {
  const text = await watchersSource()
  const start = text.indexOf(from)
  expect(start, `缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

describe('watchers 回顶钮的滚动源（内滚容器）', () => {
  test('本页确实是内滚容器：根节点满屏 + 裁切，名单在 `.wt__scroll` 里滚', async () => {
    const style = await watchersStyle()
    const root = style.slice(style.indexOf('.wt {'), style.indexOf('.wt__bg'))
    // 页面不滚（`height:100vh` + `overflow:hidden`），所以页面级滚动源在这里必然失效
    expect(root).toContain('height: 100vh')
    expect(root).toContain('overflow: hidden')
    // 名单容器的滚动样式（`flex: 1 1 auto; min-height: 0`）也在
    const scroll = style.slice(style.indexOf('.wt__scroll'))
    expect(scroll.slice(0, scroll.indexOf('}'))).toContain('min-height: 0')
  })

  test('不再用页面级滚动源（`usePageScroll` / `Taro.pageScrollTo` 都够不到内滚容器）', async () => {
    const source = code(await watchersSource())
    expect(source).not.toContain('usePageScroll')
    expect(source).not.toContain('pageScrollTo')
  })

  test('显示判据挂在名单那个 ScrollView 自己的 onScroll 上，阈值取自共享组件', async () => {
    // 只切到 `<ScrollView ...>` 这个开标签：挂在骨架屏 / 空态的 `<View>` 上会被这里拦住
    const tag = await slice('<ScrollView', '>')
    expect(tag).toContain('className="wt__scroll"')
    expect(tag).toContain('scrollY')
    expect(tag).toContain('onScroll={onScroll}')
    expect(tag).toContain('scrollIntoView={topAnchor}')

    // 判据来自事件里的 scrollTop（设备 px，与共享组件阈值同口径），且阈值不是写死的数字
    const handler = await slice('const onScroll = useCallback(', 'const [topAnchor')
    expect(handler).toContain('e.detail.scrollTop')
    expect(handler).toContain('BACK_TOP_THRESHOLD')
    expect(handler).toContain('setShowTop(')
  })

  test('阈值与钮的组件都从共享组件来（不是页面里再写一个数字 / 一份实现）', async () => {
    const importLine = await slice('import BackTop, {', '\n')
    expect(importLine).toContain('BACK_TOP_THRESHOLD')
    expect(importLine).toContain("from '@/components/back-top'")
    // 页面里不许再出现一份自己画的圆钮箭头（旧实现的类名前缀）
    const source = await watchersSource()
    expect(source).not.toContain('wt__totop')
  })

  test('回顶锚点在名单之前（不是在列表末尾），且双锚点交替指', async () => {
    // 两个同位锚点必须排在 `.wt__list` 之前 —— 放末尾就变成「滚到底」
    const inside = await slice('scrollIntoView={topAnchor}', '<View className="wt__list">')
    expect(inside).toContain('id="wt-top-a"')
    expect(inside).toContain('id="wt-top-b"')

    const toggle = await slice('const backToTop = () => {', 'const [showToken')
    // 交替指：同值原生层不会重滚，写成固定常量会让「连点第二次」失效
    expect(toggle).toContain("prev === 'wt-top-a' ? 'wt-top-b' : 'wt-top-a'")
    expect(await watchersSource()).toContain('onTop={backToTop}')
  })

  test('名单每次重载都把浮现态归零（否则钮会悬在骨架屏 / 空态上）', async () => {
    // 换商品 / 换账号那一支：用下一个语句当右界（块里有多个 `}`，切到第一个就断了）
    const scopeBlock = await slice(
      'if (scope.userId !== userId || scope.listingId !== listingId)',
      'useDidShow(',
    )
    expect(scopeBlock).toContain('setPage(initialPage())')
    expect(scopeBlock).toContain('setShowTop(false)')

    // 从详情页返回触发 `useDidShow` → 重拉那一支：页面实例没换，清场块不会跑，
    // 所以这里也得归零（实测：漏了它，返回后钮仍悬着，而列表已回到顶部）
    const reloadBlock = await slice('useEffect(() => {', 'if (!listingId) {')
    expect(reloadBlock).toContain('setPage(initialPage())')
    expect(reloadBlock).toContain('setShowTop(false)')
  })
})
