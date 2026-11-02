import { describe, expect, test } from 'bun:test'

/**
 * 识图家族四个页面的**顶部标题层命中区契约**（#533 防回归）。
 *
 * 标题层都是全宽绝对定位（`left: 0; right: 0`）、与返回钮同 `z-index` 且在 DOM 中
 * 后渲染：一旦漏掉 `pointer-events: none`，它会盖住 `left: 32px` 的返回钮，点返回
 * 毫无反应 —— 而 lint / typecheck / 功能单测全绿，编译期拦不住（这正是 #533 上线
 * 时的状态）。本仓 `tests/` 没有 WXSS 渲染基建，按先例
 * （`tests/tabbar-capsule-sizing.test.ts`、`tests/back-top-scroll-source.test.ts`）
 * 读样式源码、钉住具体规则块。
 */
const PAGES = [
  {
    name: 'vision-result',
    file: '../src/pkg-vision/pages/vision-result/index.scss',
    title: '.vres__title {',
    back: '.vres__back {',
  },
  {
    name: 'scan-vision',
    file: '../src/pkg-vision/pages/scan-vision/index.scss',
    title: '.scanvis__title {',
    back: '.scanvis__back {',
  },
  {
    name: 'scan',
    file: '../src/pkg-vision/pages/scan/index.scss',
    title: '.scanqr__topbar-title {',
    back: '.scanqr__back {',
  },
  {
    name: 'scan-pr',
    file: '../src/pkg-vision/pages/scan-pr/index.scss',
    title: '.scan__topbar-title {',
    back: '.scan__back {',
  },
] as const

async function style(relPath: string): Promise<string> {
  return await Bun.file(new URL(relPath, import.meta.url)).text()
}

/** 取 `from` 到其后第一个 `}` 之间的规则块（含 `from`，不含 `}`） */
function ruleBlock(source: string, selector: string): string {
  const start = source.indexOf(selector)
  if (start === -1) return ''
  return source.slice(start, source.indexOf('}', start))
}

/** 去掉注释再断言：注释里写着 `pointer-events: none` 本身不能算契约满足 */
function stripComments(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('识图家族顶部标题层命中区契约（#533）', () => {
  for (const page of PAGES) {
    test(`${page.name}：标题层必须 pointer-events: none（命中区穿透）`, async () => {
      const block = ruleBlock(await style(page.file), page.title)
      expect(block).not.toBe('')
      expect(stripComments(block)).toContain('pointer-events: none')
    })

    test(`${page.name}：返回钮不得被一并置穿透`, async () => {
      const block = ruleBlock(await style(page.file), page.back)
      expect(block).not.toBe('')
      expect(stripComments(block)).not.toContain('pointer-events: none')
    })
  }
})
