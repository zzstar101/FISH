import { describe, expect, test } from 'bun:test'

/**
 * 识图结果页「缺省不发 `sort`」在**源码层**的接线（#324 M6 对抗性审查 B1）。
 *
 * `tests/vision-result-view.test.ts` 锁的是纯判据（`visualSortQuery(null)` → `{}`），锁不住
 * 页面**有没有用它** —— 审查实测过：`api.ts` 的「不传就不发」分支一直存在，但页面无条件
 * `searchByVisualQuery(objectKey, { sort: next })`，于是进页首帧的请求体里照样有
 * `sort: 'relevance'`，而没有任何编译 / 运行时错误、单测也全绿。这条空洞只能在源码里钉。
 *
 * 断言跑在 `code()` **去掉注释之后**的源码上：本页注释里正逐条解释这些机制，只在原文上
 * 查 `toContain`，把代码整行注释掉也能过。
 */

/** 去掉注释后的源码：断言必须看**代码**，不能命中解释这些机制的注释 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

async function pageSource(): Promise<string> {
  return code(
    await Bun.file(new URL('../src/pages/vision-result/index.tsx', import.meta.url)).text(),
  )
}

describe('识图结果页排序接线', () => {
  test('页面 state 初值是 null（= 一档都没点过），不是 "relevance"', async () => {
    const source = await pageSource()
    expect(source).toContain('useState<VisualSearchSort | null>(null)')
    // 初值写成 'relevance' 就是把「没点过」和「点了综合」合并了，请求体必然带上 sort
    expect(source).not.toContain("useState<VisualSearchSort>('relevance')")
  })

  test('发请求时经过 visualSortQuery，不直接拼 { sort }', async () => {
    const source = await pageSource()
    expect(source).toContain('searchByVisualQuery(objectKey, visualSortQuery(next))')
    expect(source).not.toContain('searchByVisualQuery(objectKey, { sort: next })')
  })

  test('胶囊高亮与同档判定都用「生效档」，不是原始 state', async () => {
    const source = await pageSource()
    expect(source).toContain('const activeSort = activeVisualSort(sort)')
    expect(source).toContain("option.sort === activeSort ? ' is-on' : ''")
    expect(source).toContain('if (next === activeSort) return')
    // 用原始 state 判定的话，没点过档时五个胶囊全灭
    expect(source).not.toContain("option.sort === sort ? ' is-on' : ''")
    expect(source).not.toContain('if (next === sort) return')
  })
})
