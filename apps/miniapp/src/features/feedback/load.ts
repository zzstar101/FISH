/**
 * 「我的反馈」取数包装（`pkg-legal/pages/my-feedback` 消费）。
 *
 * ## 口径：先试真实接口，只有演示构建才回退
 *
 * `GET /feedback/mine` 已经接线（#463），所以真实构建**先发请求**：
 * - 成功 → `demo: false` 的真实记录；
 * - 失败 → `failed: true`，页面渲染错误态（可重试），**不用演示数据顶替** ——
 *   拿 fixture 冒充真实反馈记录，就是让用户看到一条带「已回复」的虚构结论。
 *
 * 演示构建（`MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，两个开关都要 —— 两个注入点
 * 可以单独打开，只认 MOCK_FALLBACK 会顶掉真实空态，判据与 `features/reports/load.ts` 相同）
 * 请求失败时回退到 `./demo`，页面据 `demo` 渲染「演示数据」说明带。
 *
 * ## 分页
 *
 * 单页 20（契约默认），封顶 5 页（100 条）防 cursor 异常时无限循环 —— 与举报、浏览记录
 * 同一封顶口径。正是这个封顶会让结果可能不完整，所以一并返回 `truncated`
 * （`nextCursor` 仍非 null），页面据此决定要不要渲染「已经到底了」。
 */
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { MOCK_FALLBACK_ENABLED, reportFailure } from '@/features/load-failure'
import { fetchMyFeedbackPage } from './api'
import { type FeedbackRecord, loadDemoFeedback } from './demo'
import { feedbackToRecord } from './map'

export const DEMO_FEEDBACK_ENABLED = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

/** `GET /feedback/mine` 最多翻的页数（5 × 20 = 100 条），与「我的举报」同一封顶。 */
const MY_FEEDBACK_MAX_PAGES = 5

export type FeedbackLoad = {
  items: FeedbackRecord[]
  /** 本次列表来自演示数据：页面据此渲染「演示数据」说明带 */
  demo: boolean
  failed: boolean
  /** 翻到页数上限时**后面还有**（`nextCursor` 不为 null），这份列表不是全部 */
  truncated: boolean
}

const emptyFailed = (): FeedbackLoad => ({
  items: [],
  demo: false,
  failed: true,
  truncated: false,
})

/**
 * 「我的反馈」：本人视角的全部反馈，最新在前翻页拉齐。
 *
 * **游标没前进就不收这一页**（与 `features/reports/load.ts` 同一判据）：服务端若重复给
 * 同一个 cursor，收下就等于把同一页叠 5 次，而且「仅显示最近 100 条」是句假话。
 *
 * `nowMs` 由调用方传入（同一屏共用同一个现在，见 `./map` 的说明）。
 */
export async function loadMyFeedback(nowMs: number = Date.now()): Promise<FeedbackLoad> {
  try {
    const items: FeedbackRecord[] = []
    let cursor: string | undefined
    for (let page = 0; page < MY_FEEDBACK_MAX_PAGES; page += 1) {
      const parsed = await fetchMyFeedbackPage(cursor)
      const next = parsed.nextCursor
      if (next !== null && next === cursor)
        return { items, demo: false, failed: false, truncated: true }
      items.push(...parsed.items.map((feedback) => feedbackToRecord(feedback, nowMs)))
      if (next === null) return { items, demo: false, failed: false, truncated: false }
      cursor = next
    }
    // 走满页数上限还没见底：后面还有，只是本页不再往下拉
    return { items, demo: false, failed: false, truncated: true }
  } catch (error) {
    return fallbackFeedback(error)
  }
}

/**
 * 真实请求失败后的处理：演示构建回退到打包数据，其余落失败态。
 *
 * `reportFailure` 的第三个参数是**这次实际有没有兜底**（不是构建开关的口径）：
 * 真实构建下没兜，日志里就得写明「未回退 mock」。
 */
async function fallbackFeedback(error: unknown): Promise<FeedbackLoad> {
  const demo = DEMO_FEEDBACK_ENABLED
  reportFailure('我的反馈读取', error, demo)
  if (!demo) return emptyFailed()
  try {
    return { items: await loadDemoFeedback(), demo: true, failed: false, truncated: false }
  } catch (nested) {
    // 演示数据是常量数组 + 内存追加，失败理论不可能；留出口以防将来改数据源
    console.warn('[feedback] 演示列表读取失败', nested)
    return emptyFailed()
  }
}
