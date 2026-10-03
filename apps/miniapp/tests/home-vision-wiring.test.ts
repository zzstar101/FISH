import { describe, expect, test } from 'bun:test'

/**
 * 首页搜索胶囊里那枚相机图标的识图接线（#324）。
 *
 * 这几条都**只在源码里可见**，写错了不会有任何编译错误，端上演示也很容易漏掉：
 *
 * 1. **先掐冒泡、再启动识图**：相机热区嵌在整条 `.home__search` 里，而胶囊自己有
 *    `onClick={goSearch}`。Taro 合成事件的冒泡是运行时行为，`stopPropagation()` 一旦被挪到
 *    `await` 之后（或干脆漏掉），同一次点击就会**既进识图又跳文字搜索页** —— 表现是「点了
 *    相机，结果页上又叠了一层搜索页」，端上要连点两次才看得出来。
 * 2. **在途守卫在置位之前**：`if (visionBusy) return` 必须排在 `setVisionBusy(true)` 前面。
 *    反过来写等于没有守卫 —— 上传在途时连点会打出多次真实计费的上游调用。
 * 3. **命中区靠负 margin 还宽**：热区多占的宽度必须由**等量**负 margin 还回 flex 行，
 *    否则后面的「搜『键盘』…」占位文案会被整条右推。这是纯算术，不是视觉判断。
 * 4. **热区补偿要留痕**：本页热区只有 28×32 CSS px，低于仓库「可点区域视觉高度 ≥ 44pt」
 *    的口径，按先例必须在源码里显式标注「热区补偿」而不是宣称达标。
 *
 * 断言一律跑在**去掉注释之后**的源码上：本页注释正逐条解释着这些机制，只在原文上
 * `toContain`，把某行代码注释掉也能过。
 */

async function homeSource(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.tsx', import.meta.url)).text()
}

async function homeStyle(): Promise<string> {
  return await Bun.file(new URL('../src/pages/home/index.scss', import.meta.url)).text()
}

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 取 `from` 到其后第一个 `to` 之间的**代码**（两端都不含） */
async function slice(from: string, to: string): Promise<string> {
  const text = code(await homeSource())
  const start = text.indexOf(from)
  expect(start, `代码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `代码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

/** 取 scss 里某条选择器的基础规则（去注释，到其后第一个 `}` 为止） */
async function rule(selector: string): Promise<string> {
  const style = code(await homeStyle())
  const at = style.indexOf(`${selector} {`)
  expect(at, `scss 里没有 ${selector}`).toBeGreaterThanOrEqual(0)
  return style.slice(at, style.indexOf('}', at))
}

describe('相机热区：先掐冒泡，再启动识图', () => {
  test('onCameraTap 先 stopPropagation 再调 visionSearch', async () => {
    const handler = await slice('const onCameraTap = ', 'const onCategoryTap = ')
    const stopped = handler.indexOf('event.stopPropagation()')
    const started = handler.indexOf('visionSearch()')
    expect(
      stopped,
      'onCameraTap 没有拦冒泡：同一次点击会再触发胶囊的 goSearch',
    ).toBeGreaterThanOrEqual(0)
    expect(started).toBeGreaterThanOrEqual(0)
    // 顺序是语义本身：挪到 await 之后，冒泡早已发生，拦了也白拦
    expect(stopped).toBeLessThan(started)
  })

  test('拦冒泡是 handler 的第一条语句（连点被挡下的那几次也得拦住）', async () => {
    const handler = await slice('const onCameraTap = ', 'const onCategoryTap = ')
    // `visionBusy` 的守卫在 `visionSearch` 里、位于本 handler 之下；本 handler 唯一能保证的是
    // 「先拦冒泡」——只要 stopPropagation 是函数体第一条语句，被守卫挡下的连点也同样不进文字搜索
    expect(handler).toMatch(/\{\s*event\.stopPropagation\(\)/)
  })

  test('相机 Image 包在独立命中区里，胶囊自己的 onClick 仍然是 goSearch', async () => {
    const source = code(await homeSource())
    expect(source).toContain('<View className="home__search-cam-hit" onClick={onCameraTap}>')
    expect(source).toContain('<View className="home__search" onClick={goSearch}>')
    // 命中区里就是那枚相机图标本体，没有换成别的元素
    expect(source).toContain('<Image className="home__search-cam"')
    // 文字区那条腿没被顺手改掉
    const goSearch = await slice('const goSearch = ', 'const visionSearch = ')
    expect(goSearch).toContain("Taro.navigateTo({ url: '/pkg-browse/pages/search/index' })")
  })

  test('onCameraTap 用的结构化类型（避开 any），且不吞掉 stopPropagation', async () => {
    const handler = await slice('const onCameraTap = ', 'const onCategoryTap = ')
    expect(handler).toContain('{ stopPropagation: () => void }')
    expect(handler).not.toContain('any')
  })
})

describe('识图在途守卫', () => {
  test('守卫排在置位之前，且用 finally 复位', async () => {
    const fn = await slice('const visionSearch = async () => {', 'const onCameraTap = ')
    const guard = fn.indexOf('if (visionBusy) return')
    const armed = fn.indexOf('setVisionBusy(true)')
    expect(guard, 'visionSearch 丢了在途守卫').toBeGreaterThanOrEqual(0)
    expect(armed).toBeGreaterThanOrEqual(0)
    // 守卫必须在置位之前 —— 反过来写等于没守卫
    expect(guard).toBeLessThan(armed)
    // 复位放 finally：startVisualSearch 的失败分支不会 throw，但 try 里将来加一行就会漏
    expect(fn).toContain('await startVisualSearch()')
    expect(fn).toContain('finally')
    expect(fn).toContain('setVisionBusy(false)')
  })

  test('本页不传 onPicked（没有文字搜索任务日志可作废）', async () => {
    const fn = await slice('const visionSearch = async () => {', 'const onCameraTap = ')
    expect(fn).toContain('startVisualSearch()')
    expect(fn).not.toContain('onPicked')
  })
})

describe('命中区几何：热区变大、视觉零位移', () => {
  test('热区 = 图标 30×30 + 等量负 margin 还宽', async () => {
    const hit = await rule('.home__search-cam-hit')
    const padding = /padding:\s*(\d+)px\s+(\d+)px/.exec(hit)
    const margin = /margin:\s*0\s+-(\d+)px/.exec(hit)
    expect(padding, `命中区没写 padding：${hit}`).not.toBeNull()
    expect(margin, `命中区没写负 margin：${hit}`).not.toBeNull()
    const vertical = Number(padding?.[1])
    const horizontal = Number(padding?.[2])
    const pulledBack = Number(margin?.[1])
    // 横向多占的宽度必须**等量**还回 flex 行，否则占位文案被右推
    expect(pulledBack).toBe(horizontal)
    // 图标本体尺寸：热区是它加出来的，不是换了张更大的图
    const icon = await rule('.home__search-cam')
    expect(icon).toContain('width: 30px')
    expect(icon).toContain('height: 30px')
    // 热区尺寸 = 图标 + 两侧 padding（这里只钉算术，不钉具体数值口径）
    expect(30 + 2 * horizontal).toBeGreaterThan(30)
    expect(30 + 2 * vertical).toBeGreaterThan(30)
    // 纵向不需要补偿：父级 `align-items: center` 已经把多出来的高度对称吃掉
    expect(hit).not.toContain('margin: -')
  })

  test('热区高度不超过胶囊高度（否则会溢出到胶囊外吃点击）', async () => {
    const hit = await rule('.home__search-cam-hit')
    const pill = await rule('.home__search')
    const padding = /padding:\s*(\d+)px\s+(\d+)px/.exec(hit)
    const pillHeight = /height:\s*(\d+)px/.exec(pill)
    expect(pillHeight).not.toBeNull()
    expect(Number(padding?.[1]) * 2 + 30).toBeLessThanOrEqual(Number(pillHeight?.[1]))
  })
})

describe('热区补偿留痕（低于 44pt 必须显式标注）', () => {
  test('注释里写明热区补偿 + 44pt 口径，且不再宣称达标', async () => {
    const style = await homeStyle()
    const at = style.indexOf('.home__search-cam-hit')
    const comment = style.slice(0, at)
    expect(comment).toContain('热区补偿')
    expect(comment).toContain('44pt')
    // 反面：不许再出现「≥48×48」这类不成立的达标声明（750rpx 屏下 64px = 32 CSS px）
    expect(style).not.toContain('≥48×48')
  })
})
