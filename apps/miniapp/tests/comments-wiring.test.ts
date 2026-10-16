import { describe, expect, test } from 'bun:test'

/**
 * 「我的评论」页接线层的回归（纯逻辑在 `comments.test.ts`，补读编排在
 * `comments-image-refresh.test.ts`）。
 *
 * 仓库没有 Taro 组件渲染基建，页面级行为只能读源码文本钉住（先例
 * `history-wiring.test.ts` / `following-wiring.test.ts`）。这里钉两条最容易漏的链：
 *
 * 1. **账号作用域**：列表有 `loadEpoch` 代次守卫，但计数探测（`probeCounts`）是
 *    另发的一次聚合读，必须自己也守住账号；
 * 2. **配图补读不碰列表状态**（#485 审查 P2）：`onError` 那条链**不许**调首屏
 *    `read()`、不许 `setError` / `setCursor` / `setLoading` —— 旧写法就是在这里调
 *    `read()`，把已翻到第 N 页的列表打回页首、失败还会整页错误态。这条断言是弱验证
 *    （同 `listing-detail-comments-paging.test.ts` 的口径），真正的时序由
 *    `comments-image-refresh.test.ts` 的编排用例与端上演示负责。
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

describe('我的评论：配图补读不碰列表状态（#485 审查 P2）', () => {
  /** 取 `refreshImages` 的整个函数体（到下一条顶层 `const` 为止） */
  async function refreshBlock(): Promise<string> {
    const code = await source()
    const start = code.indexOf('const refreshImages = (url: string, rowId: string) => {')
    expect(start, '页面里应有 refreshImages').toBeGreaterThanOrEqual(0)
    const end = code.indexOf('\n  const demoCounts', start)
    expect(end, 'refreshImages 之后应跟着 demoCounts').toBeGreaterThan(start)
    return code.slice(start, end)
  }

  test('图片 onError 走 refreshImages，不走 read / setRefreshTick 之类会重置列表的路径', async () => {
    const code = await source()
    // 渲染处接线：onError 调 refreshImages
    expect(code).toContain('onError={() => refreshImages(url, item.id)}')
    // 旧写法（补读直接调首屏 read）不许回来
    expect(code).not.toContain('void read(segmentRef.current, true)\n  }')
  })

  test('补读链里没有 read( / setError( / setCursor( / setLoading( —— 列表、游标、错误态都不动', async () => {
    const block = await refreshBlock()
    // 唯一允许的状态写入是按 id 合并后的 setItems
    expect(block).toContain('setItems((prev) => mergeRefreshedImages(prev, fresh))')
    for (const forbidden of ['read(', 'setError(', 'setCursor(', 'setLoading(', 'setCounts(']) {
      expect(block, `补读链里不该出现 ${forbidden}`).not.toContain(forbidden)
    }
  })

  test('补读按已加载页数回走，且带代次判据（换号 / 重读 / 切段时整批丢弃）', async () => {
    const block = await refreshBlock()
    expect(block).toContain('loadedPages: loadedPagesRef.current')
    expect(block).toContain('isCurrent: () => epoch === loadEpoch.current')
    // 落地前再核一次代次（回走期间可能已经换号 / 重读）
    expect(block).toContain('if (fresh === null || epoch !== loadEpoch.current) return')
  })

  test('已加载页数在三条链上同步：首屏读重置为 1、续页 +1、换号重置为 1', async () => {
    const code = await source()
    // 首屏读（read）：一进来就把页数打回 1
    const read = sliceFrom(code, 'const read = useCallback(', '}, [])')
    expect(read).toContain('loadedPagesRef.current = 1')
    // 续页：游标与页数一起推进
    const more = sliceFrom(code, 'const loadMore = async () => {', 'void Taro.showToast')
    expect(more).toContain('setCursor(response.nextCursor)')
    expect(more).toContain('loadedPagesRef.current += 1')
    // 换号：渲染期同步重置（与 items / cursor 同一处）
    const reset = sliceFrom(code, 'if (prevUserId !== userId) {', 'setSegment(')
    expect(reset).toContain('loadedPagesRef.current = 1')
  })
})
