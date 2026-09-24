/**
 * 「我的关注」取到的到底是什么（纯函数，不读构建开关、不 import Taro）。
 *
 * ## 后端现状（本轮的**核心事实**，不要绕过它发明端点）
 *
 * 关注关系三层都没有：
 * - **契约**：无 follows 端点，且注释明确写着「`following`（是否已关注）：没有 follows 表，
 *   关注关系未拆 Domain，#122 明确不做」（`packages/contracts/src/users/schema.ts:22`）。
 *   公开用户读模型只有 `GET /users/:userId/public` 与 `GET /users/:userId/listings`
 *   （`packages/contracts/src/users/routes.ts`），**没有任何「我关注了谁」的入口**。
 * - **API**：`apps/api/src/modules/` 下没有 follows 模块。
 * - **DB**：`packages/db/src/schema/` 下没有 follows 表。
 *
 * 所以本页只有两种可能的结果，没有第三种：
 * - `demo`：**演示构建**（调用方传 `MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED`，口径与
 *   「我的」页 `fetchers.ts` 的 `loadProfile` 回退一致）→ 照稿摆 5 个人，
 *   页面上另有「演示数据」说明行，用户能辨认这不是 TA 的真实关注。
 *   只看 `MOCK_FALLBACK_ENABLED` 会把 `dev:weapp` 的日常开发也顶成演示态，所以必须两个都开。
 * - `empty`：**其它一切情况**（含真实构建）→ 空态 + 一句如实的缺口说明。
 *   这**不是**错误态（本页没有任何请求可发、也没有东西加载失败），更不是假列表。
 *
 * 开关由调用方（页面）读出来后**显式传进来**：本模块因此不依赖 Taro 运行时，
 * 可以直接被 `bun test` 加载，把「哪种开关组合得到哪一种界面」钉成回归用例。
 */
import { FOLLOW_DEMO, type FollowingPerson } from './demo'

export type FollowingLoad =
  /** 演示构建：照稿的演示数据（页面上有演示说明行） */
  | { kind: 'demo'; people: FollowingPerson[] }
  /** 真实构建：三层都没有关注关系，没有数据可读 —— 空态 + 缺口说明 */
  | { kind: 'empty' }

/**
 * 是否演示构建。页面另用它决定「要不要先摆骨架屏」：
 * 真实构建的结果同步可知（没有端点可发），摆一帧「正在读取关注列表…」是在演一个
 * 并不存在的读取过程。
 */
export function isFollowingDemo(mockFallback: boolean, demoAuth: boolean): boolean {
  return mockFallback && demoAuth
}

export function followingLoadOf(mockFallback: boolean, demoAuth: boolean): FollowingLoad {
  if (isFollowingDemo(mockFallback, demoAuth)) return { kind: 'demo', people: FOLLOW_DEMO }
  return { kind: 'empty' }
}

/**
 * 演示态读取的模拟延迟（毫秒），与 `src/mock/api.ts` 的 `LATENCY` 同口径。
 *
 * 只用于演示分支：那里的数据本来就是 fixture，走一点延迟才能让骨架屏（稿第 04 帧）
 * 在评审时看得见。**真实分支不加延迟**。
 */
export const FOLLOW_DEMO_LATENCY_MS = 120
