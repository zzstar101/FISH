import type { AiPolishCandidate, AiPolishProvider } from '@fish/contracts/ai/schema'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { PickedPhoto } from '@/features/upload/api'
import type { SellFieldErrors } from './form'
import type { PolishCooldown } from './polish'

/**
 * 出物页的**账号作用域模型**（#170 判据 C）。
 *
 * 出物是常驻的 Tab 页实例，页面级 state 与四条异步链（编辑目标 / 图片上传 / 提交 /
 * AI 润色）都可能跨过一次换号：`authed(A) → authed(B)` 或 `authed → anonymous`。
 * 只按「当前登录的是谁」判断挡不住 `A → B → A`（账号又变回 A 时 A 的**旧**响应会被
 * 写进 A 的新会话），所以任务带上**代次**：代次只在换号与卸载时前进，不随每次请求前进。
 *
 * 判据都在本模块，页面只做接线。边界：本模块不覆盖组件接线（渲染期 setState 的时机、
 * 异步回调读 ref 的时机、卸载 effect 的注册）—— 那部分按 A/B/C 时序在微信开发者工具
 * 实测（`docs/miniapp-dev-workflow.md` §5）。
 */

/**
 * 已选图片。`url` 是本地临时路径（预览用）；**选中即上传**，`status` 是这一张自己的上传状态。
 *
 * 每张带自己的 `id`：同一张图可以被选两次（本地路径可能相同），
 * 拿 `url` 当 key / 当删除判据会撞 key 并一次删掉两张。
 */
export type SelectedPhoto = PickedPhoto & {
  id: string
  url: string
  status: 'uploading' | 'done' | 'failed'
  objectKey: string | null
  error: string | null
}

/** 编辑态加载结果。`idle` 含「新建」与「编辑内容已就绪」两种正常态。 */
export type EditLoadState = 'idle' | 'loading' | 'notfound' | 'failed'

/** 成色（与 `CONDITIONS` 的 key 同源）。 */
export type SellCondition = 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR'

/**
 * AI 润色状态机。
 *
 * `ready` 带上 `provider` / `redacted`：它们只有响应回来才知道，角标与脱敏说明就靠它们渲染，
 * 不在页面里另存一份。`failed` 只带 `code`（429 另带秒数），文案由 `./polish` 推出来。
 */
export type PolishState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | {
      phase: 'ready'
      candidates: AiPolishCandidate[]
      index: number
      provider: AiPolishProvider
      redacted: boolean
    }
  | { phase: 'failed'; code: string; retryAfterSeconds?: number }

/**
 * 换号时要清掉的全部页面级 state。
 *
 * 清单必须与页面里**所有**账号作用域的 state 一一对应：漏一项就会让新账号继承上一个账号
 * 的表单、图片（`photos` 里带着上一个账号上传得到的 `objectKey`）、编辑目标、润色候选、
 * 冷却与字段级错误。`resetForm()` 只管「这一份表单」，这里管「这个账号」—— 后者还包含
 * 编辑目标、冷却与提交结果。
 */
export type ClearedSellScope = {
  editId: string | null
  title: string
  description: string
  price: string
  category: ListingCategory | null
  condition: SellCondition
  free: boolean
  urgent: boolean
  negotiable: boolean
  photos: SelectedPhoto[]
  existingImages: string[]
  editState: EditLoadState
  polish: PolishState
  cooldown: PolishCooldown | null
  fieldErrors: SellFieldErrors
  blockMessage: string
  submitting: boolean
  pendingReviewId: string | null
}

export function clearedSellScope(): ClearedSellScope {
  return {
    editId: null,
    title: '',
    description: '',
    price: '',
    category: null,
    condition: 'LIKE_NEW',
    free: false,
    urgent: false,
    negotiable: true,
    photos: [],
    existingImages: [],
    editState: 'idle',
    polish: { phase: 'idle' },
    cooldown: null,
    fieldErrors: {},
    blockMessage: '',
    submitting: false,
    pendingReviewId: null,
  }
}

/** 换账号（含退出到 `null`）才算换号；同一账号的普通广播不算 */
export function ownerChanged(previous: string | null, next: string | null): boolean {
  return previous !== next
}

/**
 * 编辑目标是否该现在取。
 *
 * `GET /listings/:id` 挂 `requireAuth`：冷启动 `authStatus === 'unknown'`（会话恢复中）
 * 时发出去必然 401，所以先只记下目标、等身份就绪再补（见页面里的 `pendingEditRef`）。
 */
export function canLoadEditTarget(authed: boolean, userId: string | null): boolean {
  return authed && userId !== null
}

/**
 * 换号清场时，是否该丢掉「待交接的编辑目标」。
 *
 * `null → 已登录`不一定是换号：冷启动时身份先从 `unknown` 解析出来，页面在身份未就绪的
 * 窗口里收到的编辑目标（`?id=` / `takeSellHandoff()`）必须先记下来、等身份就绪再交接
 * （见 `canLoadEditTarget`）。这时把它当成上一个账号的残留清掉，就会静默退回空表单。
 *
 * 真正的换号（退出、切到别人）都从**已知账号**出发，那时残留才确实属于上一个账号。
 */
export function shouldDropPendingTarget(previous: string | null): boolean {
  return previous !== null
}

/** 一次写操作的身份：属于哪个账号、属于哪一轮 */
export type SellTask = { ownerId: string; epoch: number }

export function beginTask(epoch: number, ownerId: string): SellTask {
  return { ownerId, epoch }
}

/**
 * 这个任务是否仍然「活着」——可以写页面、可以解锁自己的 loading。
 *
 * 两个条件缺一不可：代次相同（没有被换号 / 卸载作废）且账号相同（就是当前这个人）。
 */
export function isTaskCurrent(
  task: SellTask,
  currentEpoch: number,
  currentOwnerId: string | null,
): boolean {
  return task.epoch === currentEpoch && task.ownerId === currentOwnerId
}
