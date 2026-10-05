import { describe, expect, test } from 'bun:test'

/**
 * 「我的评论」页接线层的回归（纯逻辑在 `comments.test.ts`）。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（先例
 * `history-wiring.test.ts` / `following-wiring.test.ts`）。这里钉的是**账号作用域**
 * 这一条最容易漏的链：列表有 `loadEpoch` 代次守卫，但计数探测（`probeCounts`）是
 * 另发的一次聚合读，必须自己也守住账号。
 */

async function source(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/comments/index.tsx', import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `页面里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('我的评论：接线', () => {
  test('计数探测按账号守卫：A 发出的探测不许落到 B 的页面', async () => {
    const code = await source()
    const probe = sliceFrom(code, 'const probeCounts = useCallback(', '}, [])')

    // 必须在发请求**之前**记下这次探测属于哪个账号
    const captured = probe.indexOf('const owner = userIdRef.current')
    const requested = probe.indexOf('fetchMyComments({')
    expect(captured).toBeGreaterThanOrEqual(0)
    expect(requested).toBeGreaterThanOrEqual(0)
    expect(captured).toBeLessThan(requested)

    // 写入前比对：换号 / 退出（含未登录）时整批丢弃
    const guard = probe.indexOf('if (owner === null || userIdRef.current !== owner) return')
    const write = probe.indexOf('setCounts(')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(write).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(write)
  })
})
