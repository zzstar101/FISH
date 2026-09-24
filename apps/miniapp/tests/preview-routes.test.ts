import { describe, expect, test } from 'bun:test'

/**
 * H5 预览壳的路由表必须与 `src/app.config.ts` 的页面清单一致（#86 B 线复评 P2）。
 *
 * 为什么值得一条测试：`preview/main.tsx` 的 `PageMount` 找不到 loader 时只是
 * `setComponent(null)` 就返回，**没有任何失败态** —— 漏注册的页面在预览里表现为
 * 永远停在「加载中…」。`profile-edit` 正是这样漏了一轮，而它同时是本次唯一新增的页面。
 *
 * 为什么按文本解析而不是 import：`preview/main.tsx` 在模块顶层就 `createRoot(...)`，
 * 并且 `app.config.ts` 依赖 Taro 的编译期全局 `defineAppConfig`，两者都不能在 bun 里 import。
 * （同样的做法见 `tests/verify-messages.test.ts` 对页面接线的断言。）
 */

/** 取 `anchor` 之后第一个 `= {` 到下一个行首 `}` 之间的内容。 */
function objectLiteralAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor)
  const open = at === -1 ? -1 : source.indexOf('= {', at)
  const close = open === -1 ? -1 : source.indexOf('\n}', open)
  if (at === -1 || open === -1 || close === -1) throw new Error(`解析失败：${anchor}`)
  return source.slice(open, close)
}

/** 取 `anchor` 之后第一个 `[` 到 `]` 之间的内容。 */
function arrayLiteralAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor)
  const open = at === -1 ? -1 : source.indexOf('[', at)
  const close = open === -1 ? -1 : source.indexOf(']', open)
  if (at === -1 || open === -1 || close === -1) throw new Error(`解析失败：${anchor}`)
  return source.slice(open, close)
}

/** 抽块里的页面路由字符串；`app.config.ts` 不带前导 `/`，这里统一补上。 */
function pageRoutes(block: string): string[] {
  return [...block.matchAll(/'(\/?pages\/[^']+)'/g)].map((match) => {
    const route = match[1] ?? ''
    return route.startsWith('/') ? route : `/${route}`
  })
}

const miniappRoot = new URL('..', import.meta.url)
const appPages = pageRoutes(
  arrayLiteralAfter(await Bun.file(new URL('src/app.config.ts', miniappRoot)).text(), 'pages: ['),
)
const previewPages = pageRoutes(
  objectLiteralAfter(
    await Bun.file(new URL('preview/main.tsx', miniappRoot)).text(),
    'const PAGES',
  ),
)

describe('H5 预览路由表 vs app.config 页面清单', () => {
  test('解析器没取空：两边都解析出了完整清单', () => {
    expect(appPages.length).toBeGreaterThanOrEqual(20)
    expect(previewPages.length).toBe(appPages.length)
  })

  test('预览壳注册了 app.config 的每一个页面（漏一个就永远「加载中…」）', () => {
    expect([...previewPages].sort()).toEqual([...appPages].sort())
  })

  test('本次新增的资料编辑页确实在预览壳里（P2 的原漏项）', () => {
    expect(appPages).toContain('/pages/profile-edit/index')
    expect(previewPages).toContain('/pages/profile-edit/index')
  })
})
