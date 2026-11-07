import { describe, expect, test } from 'bun:test'
import {
  beginSearchTask,
  invalidateSearchTasks,
  isSearchTaskCurrent,
  type SearchTaskLog,
} from '../src/features/listing/search-task'

/**
 * 搜索页识图钮离开本页时**不再有作废语义**的回归（#637 原 PR 正文「只报告、未修」那一条）。
 *
 * #583 把「拍 / 选图」搬进扫码页的「拍图搜」tab 后，本页的识图钮从
 * `startVisualSearch({ onPicked })` 变成 `navigateTo(scanPageUrl('photo'))`，
 * 顺手把 `onPicked` 里那句 `invalidateSearchTasks(taskLog)` 一起丢了。后果不是「状态被覆盖」
 * 这么轻：`runNumber` 命中后要**打开详情页**，跳扫码页期间它迟到成功，详情页就压在扫码页之上
 * （用户扫完码 / 拍完图返回时会莫名多一层商品页）；关键词搜索迟到则把结果写回用户已经离开的页面。
 *
 * 恢复作废还带两个必须一起成立的收尾，否则「压抑代价」比不修还差：
 * 1. 迟到的响应在守卫处直接 return，跳过它自己的 `setLoading(false)` → 返回本页永远在 loading；
 * 2. 被打断且还没有任何结果的那次搜索会落进空态分支，被渲染成「没有找到相关闲置」——
 *    把「没查完」说成「没这件东西」，还把人往许愿墙引。
 *
 * 本仓没有 Taro 组件渲染基建（先例 `tests/search-count-row.test.ts`），`visionSearch` 的接线
 * 只能读源码钉住；「迟到的响应还算不算数」是纯逻辑，`tests/listing-search-task.test.ts` 已逐条
 * 覆盖，这里只按页面的真实调用顺序复述本票的场景，并补一条「作废之后本页仍能继续搜」。
 */

async function pageSource(): Promise<string> {
  return Bun.file(new URL('../src/pkg-browse/pages/search/index.tsx', import.meta.url)).text()
}

/** 去掉注释：本页注释正逐条解释这些机制，只在原文上 `toContain`，把代码注释掉也能过 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** 取 `from` 到其后第一个 `to` 之间的**代码**（两端都不含） */
async function slice(from: string, to: string): Promise<string> {
  const text = code(await pageSource())
  const start = text.indexOf(from)
  expect(start, `代码里缺少片段：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `代码里缺少片段：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

/** 在已取出的片段里取 `from` 到其后第一个 `to`（两端都不含） */
function sliceIn(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  expect(start, `片段里缺少：${from}`).toBeGreaterThanOrEqual(0)
  const end = text.indexOf(to, start + from.length)
  expect(end, `片段里缺少：${to}`).toBeGreaterThan(start)
  return text.slice(start + from.length, end)
}

describe('搜索页识图钮：离开本页前作废在途搜索（#637）', () => {
  test('先作废任务代次，再进扫码页', async () => {
    const body = await slice('const visionSearch = ', 'useLoad(')
    const invalidated = body.indexOf('invalidateSearchTasks(taskLog)')
    const navigated = body.indexOf('await Taro.navigateTo(')
    expect(
      invalidated,
      'visionSearch 里没有作废在途搜索：迟到的编号命中会把详情页压在扫码页之上',
    ).toBeGreaterThanOrEqual(0)
    expect(navigated).toBeGreaterThanOrEqual(0)
    // 顺序反了等于没修：跳转先发生，迟到的响应在守卫之前就已经 navigateTo 出去了
    expect(invalidated).toBeLessThan(navigated)
  })

  test('同一步把 loading 收尾：作废让迟到响应跳过 setLoading(false)，否则返回时永远在 loading', async () => {
    const body = await slice('const visionSearch = ', 'useLoad(')
    const settled = body.indexOf('setLoading(false)')
    const navigated = body.indexOf('await Taro.navigateTo(')
    expect(
      settled,
      'visionSearch 只作废不收尾 loading：返回本页会一直停在「请求在途」',
    ).toBeGreaterThanOrEqual(0)
    expect(settled).toBeLessThan(navigated)
  })

  test('不动用户已输入的关键词 / 排序 / 历史 / 已展示结果', async () => {
    const body = await slice('const visionSearch = ', 'useLoad(')
    // 识图是另一条检索路径：清空输入、换排序、重搜都由用户自己触发，
    // 离开去识图不该顺手清掉输入框里的词、历史、排序口径或上一次的结果列表。
    for (const setter of ['setKeyword', 'setResults', 'setHistory', 'setSort']) {
      expect(
        body,
        `visionSearch 不该调用 ${setter}：离开识图不该清掉本页已有的输入与结果`,
      ).not.toContain(setter)
    }
  })

  test('被打断且还没有任何结果的搜索退回建议面板，不落成「没有找到」假空态', async () => {
    const body = await slice('const visionSearch = ', 'useLoad(')
    // 「请求在途 + 空结果」这一种被打断的搜索，留在结果区会被渲染成
    // 「没有找到相关闲置 · 去许愿墙发心愿」——把「没查完」说成「没这件东西」。
    const branch = sliceIn(body, 'if (loading) {', 'try {')
    const condition = branch.indexOf("results.length === 0 && numberState === 'none'")
    expect(
      condition,
      '退面板没有限定在「没有任何结果、也没有编号结论」上：会把已展示的结果清掉',
    ).toBeGreaterThanOrEqual(0)
    // 退面板只做两件事：清「已提交词」与开面板；输入框里的词由 `keyword` 自己留着
    expect(branch.indexOf("setSubmitted('')")).toBeGreaterThan(condition)
    expect(branch.indexOf('setPanelOpen(true)')).toBeGreaterThan(condition)
    // 已经展示了结果的搜索（results 非空）不该走到这里 —— 条件必须挡在前面
    expect(branch.slice(condition)).not.toContain('setResults')
  })

  test('编号查询命中后的导航仍在代次守卫之后（作废才有意义）', async () => {
    const body = await slice('const runNumber = ', 'const run = ')
    const guard = body.indexOf('isSearchTaskCurrent(taskLog, startedAt)')
    const navigated = body.indexOf('Taro.navigateTo')
    expect(guard, 'runNumber 命中后没有先问代次：作废也拦不住导航').toBeGreaterThanOrEqual(0)
    expect(navigated).toBeGreaterThanOrEqual(0)
    expect(guard).toBeLessThan(navigated)
  })
})

describe('作废之后本页不会永久失效', () => {
  test('离开去识图作废在途编号查询：迟到命中不算数，返回后再搜一次仍然算数', () => {
    const log: SearchTaskLog = { current: 0 }
    // 用户输入 12 位编号并点了搜索：`run` 开新任务，`runNumber` 在途
    const inFlight = beginSearchTask(log)
    // 此刻点识图钮跳扫码页（`visionSearch` 的第一件事）
    invalidateSearchTasks(log)
    // 迟到命中：守卫不通过 → 既不开详情页，也不写回结果
    expect(isSearchTaskCurrent(log, inFlight)).toBe(false)
    // 回到本页重新搜索：新代次仍是当前任务，页面没有被打成「永久作废」
    expect(isSearchTaskCurrent(log, beginSearchTask(log))).toBe(true)
  })
})
