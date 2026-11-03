import { describe, expect, test } from 'bun:test'

/**
 * 「搜索」页切排序抖动（#564）的接线层回归。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（先例
 * `tests/history-wiring.test.ts`）。本票的根因是**布局**，两处接线最容易改回去：
 * 1. 计数行 `{loading || failed || isNumber ? null : …}` —— 请求途中整块卸载，
 *    下方瀑布流整块上移 ≈88rpx，结果回来再插回，用户看到「先上抽再回落」；
 * 2. `changeSort` 无相等短路 —— 点当前已选 chip 也会重发一次请求、再抖一次
 *    （`toListingSort` 把综合/最新/成色都映射成 `newest`，数据根本不变）。
 *
 * 端上像素位移按 `docs/miniapp-dev-workflow.md` 的门禁在开发者工具里验，静态用例只钉接线。
 */

async function pageSource(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/search/index.tsx', import.meta.url)).text()
}

async function styleSource(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/search/index.scss', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('搜索页：计数行常驻、不在 loading 期卸载（#564）', () => {
  test('计数行只按编号查询与「本就没卡片可顶」两条裁剪，loading / failed 时保留盒子', async () => {
    const code = await pageSource()
    // 常驻：只有「编号查询」（没有排序口径）和「结果为空、下方本来就无卡片可被顶动」两种情况
    // 不挂这行。整行写法连着断言 —— `{isNumber ? null : (` 在 filters 行也有同形片段，单看分不清目标行
    expect(code).toContain('{isNumber || (results.length === 0 && (loading || failed)) ? null : (')
    // 卸载式条件写法一旦回来，抖动就回来
    expect(code).not.toContain('loading || failed || isNumber ? null')
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 要的是页面源码原文
    const metaTag = "<View className={`search__meta${loading || failed ? ' is-wait' : ''}`}>"
    expect(code).toContain(metaTag)
    // 计数数字仍是原来那一行（`tests/product-card-menu.test.ts` 也在钉它）
    expect(code).toContain('<Text className="search__meta-num num">{results.length}</Text>')
  })

  test('is-wait 只隐藏不占位塌缩（visibility，而非 display:none / 高度归零）', async () => {
    const scss = await styleSource()
    const block = sliceFrom(scss, '.search__meta.is-wait {', '}')
    // 逐条列声明而不是「有没有 visibility」：`height: 0` / `max-height` / `overflow` / `display`
    // 任一条混进来都会把盒子塌掉，抖动原样回来（只有 visibility 才是「藏起来但留住盒子」）
    const decls = block
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[^{]*\{/, '')
      .replace(/\}$/, '')
      .split(';')
      .map((decl) => decl.trim())
      .filter((decl) => decl.length > 0)
    expect(decls).toEqual(['visibility: hidden'])
    // 行高与内边距是那 88rpx 的来源，隐藏态不许动它们
    const meta = sliceFrom(scss, '.search__meta {', '}')
    expect(meta).toContain('padding: 24px 0 28px')
    expect(meta).toContain('line-height: 1.4')
  })
})

describe('搜索页：切排序相等短路（#564）', () => {
  test('点当前已选 chip 直接返回，不发请求', async () => {
    const code = await pageSource()
    const changeSort = sliceFrom(code, 'const changeSort = (next: SearchFilter) => {', '}')
    // 短路必须在 setSort / run 之前 —— 放在后面就成了「先重渲染再退回」
    const guard = changeSort.indexOf('if (next === sort) return')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(changeSort.indexOf('setSort(next)'))
  })
})
