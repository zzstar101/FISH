import { describe, expect, test } from 'bun:test'
import {
  beginSearchTask,
  invalidateSearchTasks,
  isSearchTaskCurrent,
  type SearchTaskLog,
} from '../src/features/listing/search-task'

/**
 * PR #280 复查 P2-2：搜索页的编号查询与关键词搜索必须共用**一把**代次尺子。
 *
 * 组件接线没有单测（本仓 tests/ 只有纯逻辑测试，无 Taro 组件渲染基建），所以把
 * 「这次响应还算不算数」抽成 `features/listing/search-task`，页面只在写状态 / 导航 / 弹提示
 * 之前问一句 `isSearchTaskCurrent`。下面逐条钉住它在竞态下的判定。
 */

const newLog = (): SearchTaskLog => ({ current: 0 })

describe('搜索任务代次（beginSearchTask / invalidateSearchTasks / isSearchTaskCurrent）', () => {
  test('刚开的任务就是当前任务', () => {
    const log = newLog()
    const startedAt = beginSearchTask(log)
    expect(isSearchTaskCurrent(log, startedAt)).toBe(true)
  })

  test('后开的任务让先开的失效（N1 在途时搜了 N2，N1 迟到不能导航）', () => {
    const log = newLog()
    const n1 = beginSearchTask(log)
    const n2 = beginSearchTask(log)
    expect(isSearchTaskCurrent(log, n1)).toBe(false)
    expect(isSearchTaskCurrent(log, n2)).toBe(true)
  })

  test('编号与关键词走同一把尺子（同一次输入框、同一颗按钮，不分叉）', () => {
    const log = newLog()
    const numberTask = beginSearchTask(log)
    const keywordTask = beginSearchTask(log)
    // 关键词搜索之后，编号查询的迟到响应不再算数；反之亦然
    expect(isSearchTaskCurrent(log, numberTask)).toBe(false)
    expect(isSearchTaskCurrent(log, keywordTask)).toBe(true)
  })

  test('清空输入作废在途任务（清空后编号 N1 迟到成功不能打开详情页）', () => {
    const log = newLog()
    const n1 = beginSearchTask(log)
    invalidateSearchTasks(log)
    expect(isSearchTaskCurrent(log, n1)).toBe(false)
  })

  test('卸载作废在途任务', () => {
    const log = newLog()
    const n1 = beginSearchTask(log)
    // 卸载 effect 里调的就是这个
    invalidateSearchTasks(log)
    expect(isSearchTaskCurrent(log, n1)).toBe(false)
  })

  test('作废之后再开新任务，只有最新的那次算数', () => {
    const log = newLog()
    const n1 = beginSearchTask(log)
    invalidateSearchTasks(log)
    const n2 = beginSearchTask(log)
    expect(isSearchTaskCurrent(log, n1)).toBe(false)
    expect(isSearchTaskCurrent(log, n2)).toBe(true)
  })

  test('两个编号请求同时成功时只允许最新的那次导航（不会叠出两个详情页）', () => {
    const log = newLog()
    const n1 = beginSearchTask(log)
    const n2 = beginSearchTask(log)
    const allowed = [n1, n2].filter((startedAt) => isSearchTaskCurrent(log, startedAt))
    expect(allowed).toEqual([n2])
  })

  test('代次单调递增，不会因为反复清空回退到旧值', () => {
    const log = newLog()
    const first = beginSearchTask(log)
    invalidateSearchTasks(log)
    invalidateSearchTasks(log)
    const later = beginSearchTask(log)
    expect(later).toBeGreaterThan(first)
    expect(isSearchTaskCurrent(log, first)).toBe(false)
  })
})
