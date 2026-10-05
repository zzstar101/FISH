/**
 * 「我的评论」的取数口径。
 *
 * **#195 接线后本页有了真数据源**：真实构建（含 `dev:weapp`）直接走
 * `features/comments/api.ts` 的 `GET /me/comments`（分页 / 分段计数 / 删除都在页面层编排）；
 * 只有演示构建（两个开关同时开，见下）才读 fixture —— 演示不是「失败兜底」，
 * 而是显式获准模式下的替代数据源，界面上有「演示数据」角标。
 *
 * ```text
 * MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED
 * ```
 *
 * 两条都不能少：
 * - 只认 `MOCK_FALLBACK_ENABLED` → `dev:weapp` 的日常开发也满足它（`__ALLOW_MOCK_FALLBACK__`
 *   含 `NODE_ENV === 'development'`），演示数据会顶掉真实接口 —— 而真实路径现在存在，
 *   必须让它优先；
 * - 只认 `DEMO_AUTH_ENABLED` → 演示登录态开着但真起了后端时，看不出「真实构建长什么样」。
 *
 * 真实构建的请求失败**不回演示**：失败态由页面展示错误与重试（#195 冻结口径：
 * 不把「失败回演示」当生产策略）。
 */
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { demoCommentsEnabled } from './mine'

/**
 * 演示数据开关（见文件头两段理由）。
 *
 * 判定体在 `./mine` 的 `demoCommentsEnabled`（纯函数，`tests/comments.test.ts` 直接覆盖
 * 四种组合）；这里只把两个构建期开关喂进去。页面据此决定整页走演示数据还是真实接口。
 */
export const DEMO_COMMENTS_ENABLED = demoCommentsEnabled(MOCK_FALLBACK_ENABLED, DEMO_AUTH_ENABLED)
