/**
 * 「我的评论」的取数口径。
 *
 * **本页不发任何请求**：契约没有「我发过的留言」聚合端点，交易域连评价事件都没有
 * （完整证据清单见 `./mine` 的文件头）。所以这里没有 try/catch、没有 mock 回退 ——
 * 没有可失败的东西。演示数据不是「失败兜底」，而是**唯一的**数据来源，
 * 开关口径与「我的」页的回退一致：
 *
 * ```text
 * MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED
 * ```
 *
 * 两条都不能少：
 * - 只认 `MOCK_FALLBACK_ENABLED` → `dev:weapp` 的日常开发也满足它（`__ALLOW_MOCK_FALLBACK__`
 *   含 `NODE_ENABLED === 'development'`），演示数据会顶掉真实空态；
 * - 只认 `DEMO_AUTH_ENABLED` → 演示登录态开着但真起了后端时，看不出「真实构建长什么样」。
 *
 * ## 演示数据不得覆盖真实结果
 *
 * 现在没有真实结果可覆盖（一条都读不到），所以这条是**为将来立的规矩**：等聚合端点
 * 落地时，把 `load()` 改成「先请求、失败才回演示」，并由 `demo` 标志决定要不要打
 * 「演示数据」角标 —— 那时真实数据路径天然优先。当前的实现方向相反（只读演示），
 * 是因为真实路径**还不存在**；`load()` 的返回值形状已经按「真实优先」设计好，
 * 到时候只改这一个函数体，页面不用动。
 */
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { DEMO_MY_COMMENTS, demoCommentsEnabled, type MyComment } from './mine'

export type MyCommentsResult = {
  items: MyComment[]
  /** `true` = 这批是演示数据，页面必须让用户能看出来（角标 / 说明行） */
  demo: boolean
}

/**
 * 演示数据开关（见文件头两段理由）。
 *
 * 判定体在 `./mine` 的 `demoCommentsEnabled`（纯函数，`tests/comments.test.ts` 直接覆盖
 * 四种组合）；这里只把两个构建期开关喂进去。
 */
export const DEMO_COMMENTS_ENABLED = demoCommentsEnabled(MOCK_FALLBACK_ENABLED, DEMO_AUTH_ENABLED)

/**
 * 取「我发过的评论」。
 *
 * 当前实现：演示构建给 fixture，真实构建给空数组 —— 两者都**不是错误态**，
 * 页面按 `demo` 决定摆哪套空态文案（见 `./mine` 的 `NO_SOURCE_COPY`）。
 */
export async function loadMyComments(): Promise<MyCommentsResult> {
  if (!DEMO_COMMENTS_ENABLED) return { items: [], demo: false }
  return { items: DEMO_MY_COMMENTS, demo: true }
}
