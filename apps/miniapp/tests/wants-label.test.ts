import { describe, expect, test } from 'bun:test'
import { wantsLabel } from '../src/components/product-card/wants-label'

/**
 * #406 第 5 项：识图结果页在 `favoriteCount` 缺失（`undefined`）时会渲染「undefined人想要」。
 *
 * 判据被抽成 `../src/components/product-card/wants-label.ts` 这个纯函数（卡片本身依赖 Taro
 * 运行时，小程序目录里没有渲染测试的基建），但**抽出判据不等于接线也安全**：把卡片里的
 * `wantsLabel(listing.wants)` 换回内联模板串，纯函数用例照样全绿，而页面上「undefined人想要」
 * 会原样回来。所以下面第二组用例按 `product-card-menu.test.ts` 的惯例，把接线钉在卡片源码上。
 *
 * 本文件放在 `apps/miniapp/tests/`（= 仓库里 101 个 miniapp 测试的家）：`apps/miniapp/tsconfig.json`
 * 的 `include` 只有 `src`/`config`/`types` 且 `types: ["node"]`，放 `src/` 下就要靠
 * `/// <reference types="bun" />` 才能 typecheck，而那会把 Bun 全局类型灌进整个程序
 * （含生产 src），让 `Bun.file()` 这类端上不存在的 API 也能过 typecheck。
 */

describe('wantsLabel（「N 人想要」的渲染判据）', () => {
  test('拿到真数就画', () => {
    expect(wantsLabel(7)).toBe('7人想要')
  })

  test('0 是真数：0 表示"没人收藏"，不是"没有这个数"', () => {
    expect(wantsLabel(0)).toBe('0人想要')
  })

  test('null（契约里"没有这个计数"的表示法）不画', () => {
    expect(wantsLabel(null)).toBeNull()
  })

  test('undefined 不画，绝不能漏成「undefined人想要」', () => {
    expect(wantsLabel(undefined)).toBeNull()
  })

  test('NaN / Infinity 同样不画，而不是漏成「NaN人想要」', () => {
    expect(wantsLabel(Number.NaN)).toBeNull()
    expect(wantsLabel(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

async function cardSource(): Promise<string> {
  return await Bun.file(new URL('../src/components/product-card/index.tsx', import.meta.url)).text()
}

/** 去掉注释后的源码：断言必须看**代码**（卡片源码里正逐条解释这些机制，只在原文上 toContain，把某行注释掉也能过） */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 压掉空白：biome 会把长行折行，按原样匹配就把格式当成了语义 */
function flat(source: string): string {
  return source.replace(/\s+/g, ' ')
}

describe('卡片真的用了这个判据（接线回归保护）', () => {
  test('渲染的是 wantsLabel 的结果，不是裸的 listing.wants', async () => {
    const source = flat(code(await cardSource()))
    expect(source).toContain('const wantsText = wantsLabel(listing.wants)')
    expect(source).toContain(
      '{wantsText === null ? null : <Text className="pcard__want">{wantsText}</Text>}',
    )
  })

  test('卡片里没有第二处内联的「人想要」模板串（那正是本 bug 的形态）', async () => {
    const source = code(await cardSource())
    // 脏字来自 `${listing.wants}人想要` 这种内联插值：判据一旦被绕开就会复活
    expect(source).not.toMatch(/人想要/)
    expect(source).not.toMatch(/\$\{[^}]*wants[^}]*\}人想要/)
  })
})
