import { describe, expect, test } from 'bun:test'

/**
 * 会话页消息流的滚动动画接线（#540）。
 *
 * 现象：进会话页时消息流先停在顶部，再**带平滑动画**一路滚到底 —— 因为 ScrollView
 * 的 `scrollWithAnimation` 是常开的裸属性，而 `scrollIntoView` 在首帧就指向尾行
 * （`tailId`）。定位逻辑本身正确，多出来的只是那段过渡。
 *
 * 本仓 `tests/` 没有 Taro 组件渲染基建，页面接线只能读源码钉住（先例
 * `tests/back-top-scroll-source.test.ts`）：断言**切到具体片段**再查，整份文件的子串
 * 命中挡不住「属性挂到了别的 ScrollView / 判据被删回去」这类改法。
 */

async function pageSource(): Promise<string> {
  return await Bun.file(
    new URL('../src/pkg-social/pages/conversation/index.tsx', import.meta.url),
  ).text()
}

/** 去掉注释再空白归一：注释里出现的标识符不算实现（先例 back-top-scroll-source.test.ts）。 */
function squash(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

/** 切出一个标签：从 `needle` 起到它自己的 `>`（跳过 `=>` 里的 `>`）。 */
function tag(source: string, needle: string): string {
  const start = source.indexOf(needle)
  if (start < 0) throw new Error(`找不到片段：${needle}`)
  let end = source.indexOf('>', start)
  while (end > 0 && source[end - 1] === '=') end = source.indexOf('>', end + 1)
  return source.slice(start, end + 1)
}

describe('会话页进入即贴底（#540）', () => {
  test('消息流的动画开关由判据驱动，不再是常开裸属性', async () => {
    const scroll = squash(tag(await pageSource(), '<ScrollView'))
    expect(scroll).toContain('className="conv__scroll"')
    expect(scroll).toContain('scrollWithAnimation={animateScroll}')
  })

  test('判据只在「点摘引跳过去」命中时开动画', async () => {
    const source = squash(await pageSource())
    expect(source).toContain('const animateScroll = jumpTo !== null && jumpTo.tail === tailId')
  })

  test('跳转目标与动画判据同源，正常态仍指向最后一条消息', async () => {
    const source = squash(await pageSource())
    expect(source).toContain(
      'const scrollTarget = jumpTo && jumpTo.tail === tailId ? jumpTo.id : tailId',
    )
    expect(source).toContain('scrollIntoView={scrollTarget}')
  })
})
