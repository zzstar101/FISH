import { expect, test } from 'bun:test'

/**
 * 液态玻璃的「静默失效」守卫。
 *
 * `packages/ui/src/liquid-glass.tsx` 的文档写明三条硬约束，破任何一条折射都**不会报错、
 * 只是效果消失**——这类失败没有运行时信号，测试是唯一能把它钉住的地方。所以这里直接读
 * 真实源码（组件 class 与样式表），而不是渲染组件：渲染 TopBar / SideNav 需要 router 与
 * auth provider，代价远大于收益，而约束本来就写在 class 与 CSS 上。
 * （读样式表断言生成 CSS 的先例见 features/home/announcement-bar.test.tsx。）
 */
const styles = await Bun.file(new URL('../../styles.css', import.meta.url)).text()
const topBar = await Bun.file(new URL('./top-bar.tsx', import.meta.url)).text()
const sideNav = await Bun.file(new URL('./side-nav.tsx', import.meta.url)).text()
const shell = await Bun.file(new URL('./pc-shell.tsx', import.meta.url)).text()

/** 取选择器对应的规则块；选择器可能只是选择器列表里的一项。 */
function rule(selector: string, source = styles): string {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{}]*\\{[^}]*\\}`)
  return source.match(pattern)?.[0] ?? ''
}

/** 取带 `pc-glass` 的那个元素的整行（class 都在同一行，注释行没有 className）。 */
function glassLine(source: string): string {
  return (
    source.split('\n').find((line) => line.includes('pc-glass') && line.includes('className')) ?? ''
  )
}

test('.pc-glass 不声明会让折射静默失效的属性', () => {
  const surface = rule('.pc-glass')
  expect(surface).not.toBe('')

  // isolation / opacity<1 / filter / backdrop-filter 会把表面变成 backdrop root，
  // warp 的 backdrop-filter 就只能采样表面内部，折射直接消失。
  for (const forbidden of ['isolation', 'backdrop-filter', 'filter', 'opacity']) {
    expect(surface).not.toContain(forbidden)
  }
  // 层叠上下文只能由使用方的 position + z-index 建立（见下一条），这里不能代劳：
  // 未分层规则会盖掉组件上的 Tailwind 类，顶栏会失去 sticky。
  expect(surface).not.toContain('position')
  expect(surface).not.toContain('z-index')
})

test('.pc-glass 位于 components 层内，Tailwind 工具类才能覆盖它', () => {
  expect(styles).toMatch(/@layer components\s*\{[\s\S]*?\.pc-glass/)
})

test('两个玻璃表面上没有会造成 backdrop root 的工具类', () => {
  // 四种成因都要堵住，漏一个折射就会静默消失：
  // backdrop-filter(backdrop-blur) / isolation(isolate) / opacity<1(opacity-*) /
  // will-change:opacity(will-change-*)。只堵前两个是不够的——实测给顶栏加
  // `opacity-90` 或 `will-change-opacity` 时，折射同样失效但测试不会红。
  const forbidden = ['backdrop-blur', 'isolate', 'opacity-', 'will-change', 'filter']
  for (const source of [topBar, sideNav]) {
    const line = glassLine(source)
    expect(line).toContain('pc-glass')
    for (const token of forbidden) {
      expect(line).not.toContain(token)
    }
  }
})

test('顶栏与侧栏各自用 position + z-index 建层叠上下文，warp 的 z-index:-1 才留在玻璃内部', () => {
  expect(glassLine(topBar)).toContain('sticky')
  expect(glassLine(topBar)).toContain('z-30')
  expect(glassLine(sideNav)).toContain('relative')
  expect(glassLine(sideNav)).toContain('z-0')
})

test('外壳根节点不带 isolate 与背景色，否则会成为 backdrop root / 盖掉水层', () => {
  const line =
    shell.split('\n').find((l) => l.includes('min-h-dvh') && l.includes('className')) ?? ''
  expect(line).toContain('min-h-dvh')
  expect(line).not.toContain('isolate')
  expect(line).not.toContain('bg-')
})
