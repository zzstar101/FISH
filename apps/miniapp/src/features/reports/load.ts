/**
 * 举报域取数包装（`pages/my-reports` 与两个填写页的只读态消费）。
 *
 * ## 口径：先试真实接口，只有演示构建才回退
 *
 * `GET /reports/mine` 已经接线（#252），所以真实构建**先发请求**：
 * - 成功 → `demo: false` 的真实记录；
 * - 失败 → `failed: true`，页面渲染错误态（可重试），**不用演示数据顶替** ——
 *   拿 fixture 冒充真实举报记录，就是让用户看到一条带「已处理 / 已驳回」的虚构结论。
 *
 * 演示构建（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关都要 —— 两个注入点
 * 可以单独打开，只认 MOCK_FALLBACK 会顶掉真实空态，判据与 `pages/favorites` 相同）
 * 请求失败时回退到 `features/reports/demo`，页面据 `demo` 渲染「演示数据」说明带。
 *
 * ## 分页
 *
 * 单页 50（契约上限），封顶 5 页（250 条）防 cursor 异常时无限循环 —— 与
 * `features/listing/api.ts` 的「我的发布」、`features/transaction` 同一封顶口径。
 * 正是这个封顶会让结果可能不完整，所以一并返回 `truncated`（`nextCursor` 仍非 null），
 * 页面据此决定要不要渲染「已经到底了」。
 */
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { MOCK_FALLBACK_ENABLED, reportFailure } from '@/features/load-failure'
import { fetchMyReportPage } from './api'
import { loadDemoReports, type ReportRecord } from './demo'
import { reportToRecord } from './map'

export const DEMO_REPORTS_ENABLED = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

/** `GET /reports/mine` 最多翻的页数（5 × 50 = 250 条），与「我的发布」同一封顶。 */
const MY_REPORTS_MAX_PAGES = 5

export type ReportsLoad = {
  items: ReportRecord[]
  /** 本次列表来自演示数据：页面据此渲染「演示数据」说明带 */
  demo: boolean
  failed: boolean
  /**
   * 翻到页数上限时**后面还有**（`nextCursor` 不为 null），也就是这份列表不是全部。
   *
   * 必须交给调用方：列表脚注的「已经到底了 · N 条」是对**这份列表**下的结论，
   * 列表不完整时它就是错的（`components/order-list` 对同一问题给了 `truncated` 并据此
   * 收口，本页同一口径）。
   */
  truncated: boolean
}

const emptyFailed = (): ReportsLoad => ({
  items: [],
  demo: false,
  failed: true,
  truncated: false,
})

/**
 * 「我的举报」：本人视角的全部举报（不分商品 / 用户），按最新排序翻页拉齐。
 *
 * **游标没前进就不收这一页**（与 `features/listing/api.ts` 的 `fetchMyListings` 同一判据）：
 * 服务端若重复给同一个 cursor，收下就等于把同一页叠 5 次，而且「仅显示最近 250 条」是句
 * 假话。按「列表不完整」返回，调用方就不会拿它的长度当总数。
 *
 * `nowMs` 由调用方传入（同一屏共用同一个现在，见 `./map` 的说明）。
 */
export async function loadMyReports(nowMs: number = Date.now()): Promise<ReportsLoad> {
  try {
    const items: ReportRecord[] = []
    let cursor: string | undefined
    for (let page = 0; page < MY_REPORTS_MAX_PAGES; page += 1) {
      const parsed = await fetchMyReportPage(cursor)
      const next = parsed.nextCursor
      if (next !== null && next === cursor)
        return { items, demo: false, failed: false, truncated: true }
      items.push(...parsed.items.map((report) => reportToRecord(report, nowMs)))
      if (next === null) return { items, demo: false, failed: false, truncated: false }
      cursor = next
    }
    // 走满页数上限还没见底：后面还有，只是本页不再往下拉
    return { items, demo: false, failed: false, truncated: true }
  } catch (error) {
    return fallbackReports(error)
  }
}

/**
 * 按编号取一条**当前用户自己的**举报记录（两个填写页的只读态用）。
 *
 * 契约**没有单条读取端点**（`REPORT_ROUTES` 只有 create / mine），所以从 `/reports/mine`
 * 翻页找：命中通常是第一次请求（列表页刚拉过，「我的举报」进来的这条就在第一页）。
 *
 * 找不到返回 `null` 而不是抛错：页面落「这条举报打不开」空态，那是正常的深链失效，
 * 不是错误态。请求本身失败也返回 `null`（已用 `reportFailure` 留痕）—— 只读态给不出
 * 重试按钮，抛出去只会变成未捕获异常。
 *
 * **演示构建不要调它**：演示记录同步可得，由 `resolveReportView` 直接读 `./demo`
 * （见 `./view`）。这里只走真实接口，调用方必须是真实构建。
 */
export async function loadReportRecord(
  id: string,
  nowMs: number = Date.now(),
): Promise<ReportRecord | null> {
  try {
    let cursor: string | undefined
    for (let page = 0; page < MY_REPORTS_MAX_PAGES; page += 1) {
      const parsed = await fetchMyReportPage(cursor)
      const hit = parsed.items.find((record) => record.id === id)
      if (hit !== undefined) return reportToRecord(hit, nowMs)
      const next = parsed.nextCursor
      if (next === null || next === cursor) return null
      cursor = next
    }
    return null
  } catch (error) {
    reportFailure('举报只读态读取', error, false)
    return null
  }
}

/**
 * 真实请求失败后的处理：演示构建回退到打包数据，其余落失败态。
 *
 * `reportFailure` 的第三个参数是**这次实际有没有兜底**（不是构建开关的口径）：
 * 真实构建下没兜，日志里就得写明「未回退 mock」，否则看日志的人会以为用户看到的又是演示数据。
 */
async function fallbackReports(error: unknown): Promise<ReportsLoad> {
  const demo = DEMO_REPORTS_ENABLED
  reportFailure('我的举报读取', error, demo)
  if (!demo) return emptyFailed()
  try {
    return { items: await loadDemoReports(), demo: true, failed: false, truncated: false }
  } catch (nested) {
    // 演示数据是常量数组 + 内存追加，失败理论不可能；留出口以防将来改数据源
    console.warn('[reports] 演示列表读取失败', nested)
    return emptyFailed()
  }
}
