/**
 * 纠纷列表「从详情页返回要不要重拉」的两层回归。
 *
 * 判据层（`lib/show-reload` 的 `isRecentlyLoaded`）见 `show-reload.test.ts`；这里钉两件它
 * 单独管不了的事：
 *
 * 1. **写操作必须置 dirty**：撤回了争议 / 加了证据之后，列表上的状态和证据条数都变了。
 *    光有时间闸（30 秒内不重拉）会把这种「我刚改的」一起挡掉 —— 闸只看时间，看不见写操作。
 * 2. **消费顺序**：`useDidShow` 里必须先 `consumeDisputesDirty()` 再判时间闸，否则 dirty
 *    置了也白置（先被闸拦掉，标记还留在那里，等于把一次重拉推给下一次无关的返回）。
 */
import { describe, expect, test } from 'bun:test'

async function pageSource(path: string): Promise<string> {
  return Bun.file(new URL(`../src/pkg-trade/pages/${path}/index.tsx`, import.meta.url)).text()
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(code: string, start: string, end: string): string {
  const from = code.indexOf(start)
  expect(from, `源码里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = code.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return code.slice(from, to + end.length)
}

describe('纠纷 dirty 标记：语义', () => {
  test('没人置位时消费为 false', async () => {
    const { consumeDisputesDirty } = await import('@/features/disputes/refresh')
    expect(consumeDisputesDirty()).toBe(false)
  })

  test('置位后消费一次为 true，且只触发一次', async () => {
    const { consumeDisputesDirty, markDisputesDirty } = await import('@/features/disputes/refresh')
    markDisputesDirty()
    expect(consumeDisputesDirty()).toBe(true)
    expect(consumeDisputesDirty()).toBe(false)
  })

  test('可以反复置位（每次写操作都要能触发一次重拉）', async () => {
    const { consumeDisputesDirty, markDisputesDirty } = await import('@/features/disputes/refresh')
    markDisputesDirty()
    markDisputesDirty()
    expect(consumeDisputesDirty()).toBe(true)
    expect(consumeDisputesDirty()).toBe(false)
    markDisputesDirty()
    expect(consumeDisputesDirty()).toBe(true)
  })
})

describe('纠纷列表：接线', () => {
  test('从详情页返回时先消费 dirty，再判时间闸', async () => {
    const code = await pageSource('my-disputes')
    const block = sliceFrom(code, 'useDidShow(() => {', 'void read(true)\n  })')
    expect(block).toContain('consumeDisputesDirty()')
    const dirty = block.indexOf('consumeDisputesDirty()')
    const gate = block.indexOf('isRecentlyLoaded(')
    expect(gate).toBeGreaterThanOrEqual(0)
    expect(dirty).toBeLessThan(gate)
    // 只有「没改过」才允许被时间闸挡掉
    expect(block).toContain('if (!mutated && isRecentlyLoaded(')
  })

  test('详情页的两处写操作都置 dirty（撤回争议 / 加证据）', async () => {
    const code = await pageSource('dispute-detail')
    const withdraw = sliceFrom(
      code,
      'const runWithdraw = async () => {',
      "void Taro.showToast({ title: '已撤回争议'",
    )
    expect(withdraw).toContain('markDisputesDirty()')
    const evidence = sliceFrom(
      code,
      'const addEvidence = async (messageId: string) => {',
      'markDisputesDirty()',
    )
    expect(evidence).toContain('await addDisputeEvidence(')
  })
})
