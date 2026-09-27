/**
 * 搜索页的**单一**任务代次（PR #280 复查 P2-2，纯逻辑）。
 *
 * 搜索页有两条异步路径：编号精确查询（`findListingByNumber`，命中后 `navigateTo` 进详情）
 * 与关键词搜索（`loadSearch`）。它们共用同一个输入框、同一个按钮，用户可以在前一次请求
 * 还在途时继续输入、再搜、清空或离开页面 —— 所以「这次响应还是不是当前想要的结果」
 * 必须由**一把共用的尺子**回答，两条路各发一个序号迟早会分叉。
 *
 * 为什么要独立成模块：迟到响应的危害不是「状态被覆盖」这么轻 ——
 * 编号查询命中后会直接**打开详情页**，N1 在途时搜了 N2，N1 迟到成功会打开用户已经
 * 不想要的 N1 商品；两个编号请求都成功还会叠出两个详情页。这类竞态不能靠「接口正确返回」
 * 避免，只能靠调用方在写状态 / 导航 / 弹提示之前先问一次判据。
 *
 * 作废时机：新的一次搜索（关键词或编号，走 `beginSearchTask`）、清空输入、页面卸载。
 */
export type SearchTaskLog = { current: number }

/** 开一次新任务：代次前进，返回本次任务的代次。 */
export function beginSearchTask(log: SearchTaskLog): number {
  log.current += 1
  return log.current
}

/** 作废所有在途任务（清空输入 / 卸载）：代次前进即可，不必逐个取消。 */
export function invalidateSearchTasks(log: SearchTaskLog): void {
  log.current += 1
}

/** 这次响应是否仍属于**最新的**那次搜索。 */
export function isSearchTaskCurrent(log: SearchTaskLog, startedAt: number): boolean {
  return log.current === startedAt
}
