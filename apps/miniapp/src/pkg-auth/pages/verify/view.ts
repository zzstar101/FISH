/**
 * verify 页账号作用域的生命周期判据（#170 判据 A/B/C）。
 *
 * 为什么抽出来：这些判据本身就是 #170 的修复点（冷启动不抢跑、换账号同步清场、
 * 迟到的发码 / 验码响应作废），但本页没有渲染测试基建 —— 判据留在 `index.tsx` 里就
 * 没有任何用例能在它们被改坏时变红。用例见 `apps/miniapp/tests/verify-lifecycle.test.ts`。
 *
 * 边界：这里只覆盖**判据**（给定状态算出该不该发请求 / 该不该写入），不覆盖组件接线
 * （effect 触发顺序、渲染期 setState、异步回调读 ref 的时机）。后者仍须在微信开发者
 * 工具里按 A/B/C 的时序实测，不能用本文件的用例代替端上验收。
 */
import type { VerificationStatus } from '@fish/contracts/auth/verification'

/** 页面阶段：填邮箱（发码前）→ 输 6 位码（发码后） */
export type VerifyStage = 'email' | 'code'

/**
 * 冷启动 `unknown` 不抢跑、未登录不发：`authStatus === 'authed'` 且拿到 `userId`
 * 才允许打 `GET /verification/status`。三个端点都挂 `requireAuth`，早发必然 401。
 */
export function canLoadStatus(authed: boolean, userId: string | null): boolean {
  return authed && userId !== null
}

/**
 * 数据属于哪个账号变了（`null ↔ id` 两个方向都算）。
 *
 * 用它在**渲染期**同步清场：`useEffect(() => setEmail(''), [userId])` 要等 commit
 * 之后才跑，那一帧 B 的身份已经渲染、画的却还是 A 的打码邮箱与输码阶段。
 */
export function ownerChanged(previous: string | null, next: string | null): boolean {
  return previous !== next
}

/** 页面里属于「当前账号」的字段：换号时必须逐项清空（见 `clearedScope`） */
export type ClearedScope = {
  stage: VerifyStage
  status: VerificationStatus | null
  email: string
  emailError: string
  code: string
  codeError: string
  left: number
  sending: boolean
  submitting: boolean
}

/**
 * 换号时账号作用域状态要清成什么样。
 *
 * 逐个字段显式列出（而不是「反正都会重挂」）：这些 state 分散在多个 `useState` 上，
 * 漏掉任何一项都会让 B 继承 A 的界面 —— 例如 `left` 倒计时会让 B 的「重新发送」变灰、
 * `sending` 会挡住 B 的第一次点击、`email`/`code` 会直接显示 A 的输入。
 * 用例按字段锁住这份清单。
 */
export function clearedScope(): ClearedScope {
  return {
    stage: 'email',
    status: null,
    email: '',
    emailError: '',
    code: '',
    codeError: '',
    left: 0,
    sending: false,
    submitting: false,
  }
}

/**
 * 一次在途写任务（发码 / 验码 / 收敛已认证）的凭据。
 *
 * `epoch` 只在**换账号**与**页面卸载**时前进，不随每次请求前进：发码与验码由 ref 锁
 * 串行，同账号内互相作废只会把结果丢掉。而 `ownerId` 单独比对又不够 ——
 * `A → B → A` 时当前账号又变回 A，A 的旧响应会被放进 A 的新会话；代次能把这一轮
 * 圈住（与 chat / mylist 的 loadEpoch 同一手法）。
 */
export type VerifyTask = { ownerId: string; epoch: number }

/** 以发请求那一刻的代次与账号为凭据 */
export function beginTask(epoch: number, ownerId: string): VerifyTask {
  return { ownerId, epoch }
}

/**
 * 响应落地前重新确认身份仍有效：任务属于当前账号，且这一轮还没被换号 / 卸载作废。
 *
 * 成功、失败与 `finally` 的解锁都要走它：只挡成功写入而让 finally 无条件跑，
 * A 的 finally 会把 B 已经点下的那一次发码 / 认证的锁提前解开。
 */
export function isTaskCurrent(
  task: VerifyTask,
  currentEpoch: number,
  currentOwnerId: string | null,
): boolean {
  return task.epoch === currentEpoch && task.ownerId === currentOwnerId
}
