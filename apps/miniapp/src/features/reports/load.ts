/**
 * 「我的举报」取数包装（`pages/my-reports` 消费）。
 *
 * main 还没有 `GET /reports/mine`（#252 的后端在 Draft PR #231/#240/#241，未合并）：
 * - **真实构建不发请求**，回空列表 + `failed:false`，页面渲染缺口空态
 *   （与 `pages/favorites` 的「收藏功能还没有后端」同一口径，不造错误态）；
 * - 演示构建（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关都要 ——
 *   只认 MOCK_FALLBACK 会把 `dev:weapp` 的真实空态顶掉，判据与 `pages/favorites` 相同）
 *   回 `features/reports/demo` 的记录。
 *
 * `failed` 出口是给将来真实请求留的：接线时只改这个文件，页面的失败分支已经就位。
 */
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { loadDemoReports, type ReportRecord } from './demo'

export const DEMO_REPORTS_ENABLED = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

export type ReportsLoad = {
  items: ReportRecord[]
  /** 本次列表来自演示数据：页面据此渲染「演示数据」说明带 */
  demo: boolean
  failed: boolean
}

export async function loadMyReports(): Promise<ReportsLoad> {
  if (!DEMO_REPORTS_ENABLED) return { items: [], demo: false, failed: false }
  try {
    return { items: await loadDemoReports(), demo: true, failed: false }
  } catch (error) {
    // 演示数据是常量数组 + 内存追加，失败理论不可能；留 failed 出口给将来的真实请求
    console.warn('[reports] 演示列表读取失败', error)
    return { items: [], demo: false, failed: true }
  }
}
