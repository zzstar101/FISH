/**
 * 举报只读态的入口判定（`pages/report-listing` / `pages/report-user` 共用，**纯逻辑**）。
 *
 * 「我的举报」点卡片带 `reportId` 进填写页的只读态。真实构建下记录来自
 * `GET /reports/mine`（#252 接线，由页面异步取，见 `./load` 的 `loadReportRecord`）；
 * 演示构建下记录就在打包产物里（`./demo`）。两条路径都要满足两件事（#260 / #261 复查 P2）：
 *
 * 1. **真实构建不得把演示样例当正式记录**。演示数据是打包进来的虚构记录，带上
 *    「已处理 / 已驳回」的状态；把它当真实处理结果渲染出去，提交分支的
 *    「真实构建不假成功」拦不住这条**读**路径。所以 `demoEnabled` 为假时**只认**调用方
 *    异步查到的 `record`，绝不回落到 `./demo`。
 * 2. **目标类型要对得上**。商品页拿用户举报的记录去渲染，会把两套不同的原因枚举
 *    混着解释（`meta.ts` 的 `reasonsOf` 也按 target 分叉）。
 *
 * 只给了 `reportId` 却拿不到记录时**不退回新建表单**：那会让「打开一条记录」静默变成
 * 「凭空举报一个没有对象的商品」。落 `unavailable`，由页面明确说这条打不开。
 * `reportId=` 这种**带了参数但值为空**的链接同样算「打不开」—— 判据是「入口有没有给
 * reportId」，不是「这个值是不是空串」，否则被改坏的深链会静默变成新建表单。
 */
import { findDemoReport, type ReportRecord } from './demo'
import type { ReportTarget } from './meta'

export type ReportViewMode = 'fill' | 'view' | 'unavailable'

export type ReportView = {
  mode: ReportViewMode
  /** 仅 `mode === 'view'` 时非 null */
  record: ReportRecord | null
}

/**
 * 入口带没带 `reportId`（页面据此决定要不要异步查记录）。
 *
 * 单独抽出来是让页面与 `resolveReportView` 用**同一个**判据：`reportId` 键不存在才是新建态，
 * 空串算「要查但查不到」。两处各写一份 `!= null` 迟早会分叉。
 */
export function wantsReportRecord(reportId: string | null | undefined): boolean {
  return reportId !== null && reportId !== undefined
}

/**
 * 一次账号作用域的异步任务（PR #280 复查 P2-1）：属于**哪个账号**、属于**哪一轮**。
 *
 * 两张填写页都可能跨过一次换号（`authed(A) → authed(B)`）：只读记录、提交结果、成功态与
 * toast 全都属于**发起它的那个账号**的私有数据。落地前必须确认任务仍归当前账号所有，
 * 否则 A 的迟到响应会写进 B 的界面（B 会看到 A 的举报编号、原因、说明与「举报已提交」）。
 *
 * 只比对 `ownerId` 不够：`A → B → A` 时当前账号又变回 A，A 的旧响应会被写进 A 的**新**会话，
 * 所以还要叠一个只在换号 / 卸载时前进的代次。判据与 `pages/sell/view.ts` 的 `SellTask` 同源。
 */
export type ReportTask = { ownerId: string; epoch: number }

export function beginReportTask(epoch: number, ownerId: string): ReportTask {
  return { ownerId, epoch }
}

/** 任务是否仍然「活着」：代次没被换号 / 卸载作废，且账号就是当前这个人。 */
export function isReportTaskCurrent(
  task: ReportTask,
  currentEpoch: number,
  currentOwnerId: string | null,
): boolean {
  return task.epoch === currentEpoch && task.ownerId === currentOwnerId
}

/**
 * 渲染期换号判据。
 *
 * 与 `pages/sell/view.ts` 的 `ownerChanged` 同构：冷启动把身份从 `unknown` 解析出来
 * （`null → usr_…`）也走一次清场 —— 举报页此时本来就没有任何私有数据，清场是空操作，
 * 但它让代次前进，把「身份还没就绪就发出去的读取」一并作废。
 */
export function reportOwnerChanged(previous: string | null, next: string | null): boolean {
  return previous !== next
}

export function resolveReportView(input: {
  /** 入口 query 里的 `reportId`；键不存在（`undefined`）才是新建态 */
  reportId: string | null | undefined
  /** 本页负责的目标类型（商品页 / 用户页各一个） */
  target: ReportTarget
  /** 演示构建判据（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`） */
  demoEnabled: boolean
  /**
   * 真实构建下由 `loadReportRecord()` 异步查到的记录；`null` = 查过但没查到。
   * `undefined` 表示调用方还没查（页面在查询期间渲染骨架，不该调到这里）。
   * **演示构建忽略它**（记录同步可得，不必等网络）。
   */
  record?: ReportRecord | null
}): ReportView {
  const { reportId, target, demoEnabled, record } = input
  if (!wantsReportRecord(reportId)) return { mode: 'fill', record: null }
  const hit = demoEnabled ? findDemoReport(reportId as string, target) : (record ?? null)
  if (hit === null || hit.target !== target) return { mode: 'unavailable', record: null }
  return { mode: 'view', record: hit }
}

/**
 * `unavailable` 态的文案。两种缺失要分开说：
 * - **真实构建**：读取接口是通的（`GET /reports/mine`），查不到就是这条不在返回里 ——
 *   说「编号有误 / 不在最近的处理记录里」，不谎称「功能没做」，也不谎称「平台没收到」；
 * - **演示构建**：读取是通的（演示数据），只是这条编号不在数据里 —— 演示提交的记录
 *   重启小程序就没了，用户再去点旧卡片就会走到这里。
 */
export function unavailableCopy(demo: boolean): { title: string; text: string } {
  if (demo) {
    return {
      title: '这条举报打不开',
      text: '演示数据里没有这条记录。演示提交的记录在小程序重启后就会消失。',
    }
  }
  return {
    title: '这条举报打不开',
    text: '没有查到你提交的这条举报。可能是链接有误，或它不在最近的处理记录里。',
  }
}
