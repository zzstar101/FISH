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
