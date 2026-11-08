import { expect, test } from 'bun:test'

/**
 * #662：四个 Tab 页的 WebView 预热由 `useTabTransition` 在 onReady 后显式触发，
 * 页面配置必须设成 `handleWebviewPreload: 'manual'`，否则框架默认的
 * onReady+200ms 自动预加载会与显式调用重复建 WebView。
 *
 * 页面清单从 `app.config.ts` 的 `tabBar.list` 派生，新增 Tab 时自动纳入。
 */
test('tabBar.list 的每个页面都关闭框架自动预热，交给 useTabTransition 显式触发', async () => {
  const appConfig = await Bun.file(new URL('../src/app.config.ts', import.meta.url)).text()
  const tabPages = [...appConfig.matchAll(/pagePath: '(pages\/[^']+)'/g)].map((match) => match[1])

  expect(tabPages.length).toBeGreaterThanOrEqual(4)
  for (const pagePath of tabPages) {
    const code = await Bun.file(new URL(`../src/${pagePath}.config.ts`, import.meta.url)).text()
    expect(code, `${pagePath} 应设置 handleWebviewPreload: 'manual'`).toContain(
      "handleWebviewPreload: 'manual'",
    )
  }
})
