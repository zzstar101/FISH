/**
 * 纠纷列表「从子页返回要不要重拉」的两层回归。
 *
 * 判据层（`features/disputes/refresh.ts` 的 `isRecentlyLoaded`）见
 * `disputes-show-reload.test.ts`；这里钉三件纯函数与判据都管不了的事：
 *
 * 1. **所有写操作都必须置 dirty**，包括「新建争议」这条最显眼的：列表页全程在栈上
 *    （订单卡 → 我的争议 → 详情 → 重新发起 → 新建），返回时命中的正是「30 秒内刚拉过」
 *    那道闸。少一处置位 = 服务端已经有这条、列表上 30 秒内看不见它。
 * 2. **置位必须发生在 `opAlive` 判断之前**：服务端写成功后，`read(true)` / 回前台
 *    TTL 重读 / 409 重同步 / 预览附件都会推进 `loadEpoch`，走早退分支时若不置位，
 *    列表拿不到信号。
 * 3. **「只认成功」的那道判断不能被去掉**：`lastLoadedAt` 只在 `!result.failed` 时更新，
 *    否则失败一次也会被当成「刚拉过」，用户在错误态里反复进出却一直看不到重试。
 *
 * 断言都跑在去掉注释之后的源码上：这些机制在页面注释里逐条解释着，只对原文 `toContain`
 * 的话，把某行注释掉也能通过。
 */
import { beforeEach, describe, expect, test } from 'bun:test'

async function pageSource(path: string): Promise<string> {
  return Bun.file(new URL(`../src/pkg-trade/pages/${path}/index.tsx`, import.meta.url)).text()
}

/** 去掉注释后的源码 —— 断言必须看**代码**。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 取 `start` 到其后第一次出现的 `end`（含 `end`）之间的片段 */
function sliceFrom(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from, `源码里应出现 ${start}`).toBeGreaterThanOrEqual(0)
  const to = source.indexOf(end, from)
  expect(to, `${end} 应出现在 ${start} 之后`).toBeGreaterThanOrEqual(0)
  return source.slice(from, to + end.length)
}

/** `needle` 在 `haystack` 里的下标，必须存在 */
function at(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle)
  expect(index, `片段里应出现 ${needle}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('纠纷 dirty 标记：语义', () => {
  // 模块级布尔：用例之间必须自己收尾，否则上一条残留的 true 会让下一条的首个断言失真
  beforeEach(async () => {
    const { clearDisputesDirty } = await import('@/features/disputes/refresh')
    clearDisputesDirty()
  })

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

  test('clear 把标记丢掉：这次进页会全量读，标记要表达的事已被覆盖', async () => {
    const { clearDisputesDirty, consumeDisputesDirty, markDisputesDirty } = await import(
      '@/features/disputes/refresh'
    )
    markDisputesDirty()
    clearDisputesDirty()
    expect(consumeDisputesDirty()).toBe(false)
  })
})

describe('纠纷列表：接线', () => {
  test('从详情页返回时先消费 dirty，再判时间闸', async () => {
    const source = code(await pageSource('my-disputes'))
    const block = sliceFrom(source, 'useDidShow(() => {', 'void read(true)\n  })')
    // 只有「没改过」才允许被时间闸挡掉
    expect(block).toContain('if (!mutated && isRecentlyLoaded(')
    expect(at(block, 'consumeDisputesDirty()')).toBeLessThan(at(block, 'isRecentlyLoaded('))
  })

  test('`lastLoadedAt` 只在成功那一支更新（失败不能被当成「刚拉过」）', async () => {
    const source = code(await pageSource('my-disputes'))
    // 全文件只允许这一处写入
    expect(source.split('lastLoadedAt.current = Date.now()').length - 1).toBe(1)
    const guarded = sliceFrom(source, 'if (!result.failed) {', '}\n')
    expect(guarded).toContain('lastLoadedAt.current = Date.now()')
    // 换账号是清零（`= 0`），不属于上面这条
    expect(source).toContain('lastLoadedAt.current = 0')
  })

  test('进页全量读成功时丢掉残留 dirty；换账号也清（不泄漏到下一次「看一眼就返回」）', async () => {
    const source = code(await pageSource('my-disputes'))
    const read = sliceFrom(source, 'const read = useCallback(', 'setLoading(false)\n    },\n')
    expect(read).toContain('if (!silent) clearDisputesDirty()')
    const switchAccount = sliceFrom(source, 'if (prevUserId !== userId) {', 'setItems([])')
    expect(switchAccount).toContain('clearDisputesDirty()')
  })

  test('撤回争议：置位发生在 `opAlive` 判断之前', async () => {
    const source = code(await pageSource('dispute-detail'))
    const withdraw = sliceFrom(
      source,
      'const runWithdraw = async () => {',
      "void Taro.showToast({ title: '已撤回争议'",
    )
    expect(at(withdraw, 'markDisputesDirty()')).toBeLessThan(at(withdraw, 'if (!opAlive(op))'))
  })

  test('加证据：同样在 `opAlive` 之前，且只在那条真的是新证据时置位', async () => {
    const source = code(await pageSource('dispute-detail'))
    const evidence = sliceFrom(
      source,
      'const addEvidence = async (messageId: string) => {',
      'setSheetOpen(false)',
    )
    expect(at(evidence, 'if (result.created) markDisputesDirty()')).toBeLessThan(
      at(evidence, 'if (!opAlive(op))'),
    )
  })

  test('新建争议也要置位：返回列表时「我刚建的」不能消失 30 秒', async () => {
    const source = code(await pageSource('dispute-create'))
    const created = sliceFrom(
      source,
      'const result = await createDispute({',
      'void Taro.redirectTo({',
    )
    expect(created).toContain('if (result.created) markDisputesDirty()')
  })
})
