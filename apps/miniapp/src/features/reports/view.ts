/**
 * 举报只读态的入口判定（`pages/report-listing` / `pages/report-user` 共用，**纯逻辑**）。
 *
 * 「我的举报」点卡片带 `reportId` 进填写页的只读态，而只读记录来自演示数据，
 * 所以查询必须同时满足两件事（#260 / #261 复查 P2）：
 *
 * 1. **只有演示构建才查**。真实构建没有举报读取端点，把打包进来的样例记录当正式记录
 *    渲染，就是给用户看一条带「已处理 / 已驳回」的虚构处理结果 —— 提交分支的
 *    「真实构建不假成功」拦不住这条**读**路径。
 * 2. **目标类型要对得上**。商品页拿用户举报的记录去渲染，会把两套不同的原因枚举
 *    混着解释（`meta.ts` 的 `reasonsOf` 也按 target 分叉）。
 *
 * 只给了 `reportId` 却拿不到记录时**不退回新建表单**：那会让「打开一条记录」静默变成
 * 「凭空举报一个没有对象的商品」。落 `unavailable`，由页面明确说这条打不开。
 */
import { findDemoReport, type ReportRecord } from './demo'
import type { ReportTarget } from './meta'

export type ReportViewMode = 'fill' | 'view' | 'unavailable'

export type ReportView = {
  mode: ReportViewMode
  /** 仅 `mode === 'view'` 时非 null */
  record: ReportRecord | null
}

export function resolveReportView(input: {
  /** 入口 query 里的 `reportId`；没有就是新建态 */
  reportId: string | null
  /** 本页负责的目标类型（商品页 / 用户页各一个） */
  target: ReportTarget
  /** 演示构建判据（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`） */
  demoEnabled: boolean
}): ReportView {
  const { reportId, target, demoEnabled } = input
  if (reportId === null || reportId === '') return { mode: 'fill', record: null }
  const record = demoEnabled ? findDemoReport(reportId, target) : null
  return record === null ? { mode: 'unavailable', record: null } : { mode: 'view', record }
}

/**
 * `unavailable` 态的文案。两种缺失要分开说：
 * - **真实构建**：缺口在后端（没有举报读取接口），如实说，不假装「这条不存在」；
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
    title: '举报详情还没有后端',
    text: '服务端还没有举报读取接口（#252），这条举报暂时看不了。',
  }
}
