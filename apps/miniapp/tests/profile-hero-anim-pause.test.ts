/**
 * 「我的」页页头动效切走时暂停的接线回归（#624 审查）。
 *
 * 这条改动的机制只有一个单点：`index.tsx` 按 `useDidHide`/`useDidShow` 切一个 class，
 * `index.scss` 里那条 `animation-play-state: paused` 才生效。两处都不报错，掉一处只是
 * 「白占合成器」悄悄回来 —— 所以在这里钉住：
 *
 * 1. **靠特异性赢，不靠源序**：`animation` 简写会把 `animation-play-state` 重置成
 *    `running`，但暂停规则带两个类（`.profile--anim-paused .profile__hero-bg`），比
 *    基础规则的单个类 + 伪元素更高，所以在层叠里赢，与写在文件哪一段无关。headless
 *    Chromium 里两种源序都读到 `paused`（`%TEMP%/perf-check/order-vs-specificity.html`）。
 *    下面断言的是「暂停规则仍有 2 个类、基础规则仍只有 1 个类」—— 把暂停规则写成
 *    `.profile__hero-bg`（丢掉前缀类）才是真正会静默失效的改法。
 * 2. **三处根节点都挂上**：本页有三个 `return`（未登录 / 加载中 / 主态），漏一个就等于
 *    那条路径切走时还在跑。
 * 3. **`heroMeshDrift` 不回来**：它被删是因为实测为视觉 no-op（只留重绘），不是重构掉的。
 *
 * 钉的是源码形状（本仓没有 Taro 渲染基建），手法与 `listing-status-mark.test.ts` 一致：
 * `.tsx` 管接的哪根线、`.scss` 管视觉真的在。
 */
import { describe, expect, test } from 'bun:test'

const SRC = new URL('../src/pages/profile/', import.meta.url)

async function read(name: string): Promise<string> {
  return Bun.file(new URL(name, SRC)).text()
}

/** 去掉注释：注释里提到 `heroMeshDrift` / `animation-play-state` 不算数 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('我的页页头动效：切走时暂停', () => {
  test('暂停规则每条选择器都是两个类（比基础规则的单个类更高，层叠里赢得下来）', async () => {
    const scss = code(await read('index.scss'))
    const paused = scss.indexOf('animation-play-state: paused')
    expect(paused).toBeGreaterThan(-1)

    // 往回找这条规则的起点，取出选择器块
    const ruleStart = scss.lastIndexOf('}', paused) + 1
    const selectors = scss
      .slice(ruleStart, scss.lastIndexOf('{', paused))
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)

    expect(selectors.length).toBe(3)
    for (const selector of selectors) {
      expect(selector.startsWith('.profile--anim-paused .profile__hero-bg')).toBe(true)
      expect(selector.match(/\./g)?.length).toBe(2) // 恰好两个类
    }
  })

  test('基础规则仍只带一个类（对方没被一起提高，比较还成立）', async () => {
    const scss = code(await read('index.scss'))
    const base = scss.slice(0, scss.indexOf('animation: heroGlow'))
    const selectors = base
      .match(/^\.profile[^{]*\{/gm)
      ?.map((line) => line.trim())
      .filter((line) => line.startsWith('.profile__hero-bg'))
      .map((line) => line.replace(/\s*\{$/, ''))

    expect(selectors?.length).toBeGreaterThan(0)
    for (const selector of selectors ?? []) {
      expect(selector.match(/\./g)?.length).toBe(1)
    }
  })

  test('三条选择器都覆盖：外壳、::before（流光）、::after（高光）', async () => {
    const scss = code(await read('index.scss'))
    const flattened = scss.replace(/\s+/g, ' ')

    for (const selector of [
      '.profile--anim-paused .profile__hero-bg,',
      '.profile--anim-paused .profile__hero-bg::before,',
      '.profile--anim-paused .profile__hero-bg::after {',
    ]) {
      expect(flattened).toContain(selector)
    }
  })

  test('被删掉的 heroMeshDrift 没有偷偷回来', async () => {
    const scss = code(await read('index.scss'))
    expect(scss).not.toContain('heroMeshDrift')
  })

  test('两条真动效还在（别为了省事把暂停做成删除动画）', async () => {
    const scss = code(await read('index.scss'))
    expect(scss).toContain('animation: heroGlow 7s ease-in-out infinite alternate')
    expect(scss).toContain('animation: heroSweep 9s ease-in-out infinite')
  })

  test('弱动效偏好仍整块关掉三条动画（这一支没被暂停规则顶掉）', async () => {
    const scss = code(await read('index.scss'))
    const reduced = scss.slice(scss.indexOf('prefers-reduced-motion'))
    expect(reduced).toContain('animation: none')
  })
})

describe('我的页页头动效：页面侧的接线', () => {
  test('useDidShow 恢复、useDidHide 暂停', async () => {
    const tsx = code(await read('index.tsx'))

    expect(tsx).toContain("import Taro, { useDidHide, useDidShow } from '@tarojs/taro'")
    expect(tsx).toContain('useDidShow(() => setPageHidden(false))')
    expect(tsx).toContain('useDidHide(() => setPageHidden(true))')
    expect(tsx).toContain(
      "const pageClass = pageHidden ? 'profile profile--anim-paused' : 'profile'",
    )
  })

  test('三处 return 的根节点都挂的是 pageClass（漏一个就有路径切走还在跑）', async () => {
    const tsx = code(await read('index.tsx'))

    const roots = tsx.match(/<View className=\{pageClass\}>/g) ?? []
    expect(roots.length).toBe(3)
    // 根节点不许再按字面量写死
    expect(tsx).not.toContain('<View className="profile">')
  })
})
