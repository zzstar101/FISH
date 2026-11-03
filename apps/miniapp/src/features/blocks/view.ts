/**
 * 拉黑域的**纯**展示逻辑（#473）。
 *
 * 本模块不 import Taro、不发请求 —— `bun test` 直接锁（页面接线另有源码文本钉）。
 * 错误判别用**形状**（`name`/`code`/`status` 三特征）而不是 `lib/request` 的
 * `isApiError`：那个守卫在 request 模块里，import 它会把 Taro 拖进纯模块
 * （`features/following/load.ts` 的「不读运行时」口径同款）。三特征同时成立才算，
 * 与 `isApiError` 的形状兜底一致 —— 小程序按页面分 chunk 打包后 `instanceof` 会
 * 静默为 false，形状判别是这里的唯一可靠依据。
 */

function apiErrorShapeOf(error: unknown): { code?: string; status?: number } {
  if (typeof error !== 'object' || error === null) return {}
  const shaped = error as { name?: unknown; code?: unknown; status?: unknown }
  if (shaped.name !== 'ApiError') return {}
  return {
    code: typeof shaped.code === 'string' ? shaped.code : undefined,
    status: typeof shaped.status === 'number' ? shaped.status : undefined,
  }
}

/**
 * 域内错误码 → 行内文案；域外（网络 / 未识别码）一律「操作失败，请重试」。
 * 401 `UNAUTHENTICATED` 不在这里兜：守卫组件已在跳登录，调用方不应再弹它的文案。
 */
export function describeBlockFailure(error: unknown): string {
  const { code } = apiErrorShapeOf(error)
  if (code === 'USER_NOT_FOUND') return '用户不存在或不可见'
  if (code === 'CANNOT_BLOCK_SELF') return '不能拉黑自己'
  return '操作失败，请重试'
}

/**
 * 他人主页拉黑入口的 UI 状态推导（对齐 PC `blockButtonState` 的口径）。
 *
 * 与关注钮同一边界：**读到状态之前不渲染**（`visible: false`），读失败也不渲染
 * （页面 catch 里保持 `read: null`，不猜一个状态画上去）。渲染后：blocked=true 是
 * 「解除拉黑」（恢复性动作，点击直接执行）；false 是「拉黑该用户」（点击先过确认弹窗）。
 */
export type BlockEntryView = {
  visible: boolean
  label: string
  busy: boolean
  blocked: boolean
}

/**
 * 读到的拉黑态**带着它属于谁**（`key` = 账号|页主，与关注钮同一把钥匙）。
 *
 * 这是 #484 审查第 ① 条的修复：状态原本不带归属，换账号 / 换页主后 `null` 要等
 * effect 到下一帧才写回，中间那一帧会拿**上一个页主**的 `blocked` 画出按钮 ——
 * 于是在 A 的主页点了「解除拉黑」，实际发出的是对 B 的解除。带 key 后归属不符
 * 就当没读到（不渲染、不可操作），不依赖 effect 的先后。
 */
export type BlockRead = { key: string; blocked: boolean }

/** 读到的状态是否仍属于当前 owner；不属于 ⇒ 视作「没读到」（`null`）。 */
export function blockReadOf(read: BlockRead | null, key: string): { blocked: boolean } | null {
  if (read === null || read.key !== key) return null
  return { blocked: read.blocked }
}

export function blockEntryView(input: {
  read: BlockRead | null
  key: string
  pending: boolean
}): BlockEntryView {
  const current = blockReadOf(input.read, input.key)
  if (current === null) {
    return { visible: false, label: '拉黑该用户', busy: false, blocked: false }
  }
  if (input.pending) {
    return {
      visible: true,
      label: current.blocked ? '解除中…' : '拉黑中…',
      busy: true,
      blocked: current.blocked,
    }
  }
  return {
    visible: true,
    label: current.blocked ? '解除拉黑' : '拉黑该用户',
    busy: false,
    blocked: current.blocked,
  }
}

/**
 * 黑名单页的一屏数据（在纯模块里定义，落地判据才能单测）。
 *
 * `gen` 是**这份快照属于哪一代**：解除成功会让本地快照换代（见 `nextBlocksLoad`），
 * 于是解除前发出的首屏回包即便后到，也塞不回那一行。
 */
export type BlockedRow = {
  id: string
  nickname: string
  avatarUrl: string | null
  blockedAt: string
}

export type BlocksLoad =
  | { kind: 'loading' }
  | { kind: 'ready'; rows: BlockedRow[]; nextCursor: string | null; gen: number }
  | { kind: 'error' }

/**
 * 首屏回包落地判据（#484 审查第 ② 条）。
 *
 * 竞态：解除**成功**摘掉了那一行，而解除之前发出的首屏回包随后到达 —— 那份快照里
 * 还带着这个人，直接落地就把刚解除的行塞回列表（用户看到「解除成功」却没少一行，
 * 再点一次会打一个已经不存在的拉黑）。判据：快照代次比当前旧就不落地，
 * 让本地已摘行的状态赢。
 */
export function nextBlocksLoad(prev: BlocksLoad, next: BlocksLoad): BlocksLoad {
  if (prev.kind === 'ready' && next.kind === 'ready' && next.gen < prev.gen) return prev
  return next
}

/**
 * 「加载更多」的回包与收尾是否仍由发起者持有（#484 审查第 ③ 条）。
 *
 * 竞态：`pendingMore` 会被 `runLoad`（下拉刷新 / 重进页）取消并重新登记，两次请求
 * 都能走到 `finally`；谁的 `finally` 都去清 `loadingMore` / 写页脚错误，后到的收尾
 * 就会把**新请求**的加载态提前熄掉，或把新请求的失败算到旧请求头上。判据：代次
 * 一致 **且** 令牌仍是自己那一枚，才有权清位与写错误。
 */
export function moreReplyLanded(input: {
  gen: number
  genNow: number
  token: symbol
  tokenNow: symbol | null
}): boolean {
  return input.gen === input.genNow && input.token === input.tokenNow
}

/**
 * 拉黑确认弹窗（weapp 原生 `Taro.showModal`）。后果说明与 PC 站确认弹窗同文：
 * 双向拦截、既有会话一并冻结、交易与面交不受影响、历史保留、可随时解除（单方）。
 */
export function blockConfirmModal(nickname: string): {
  title: string
  content: string
  confirmText: string
} {
  return {
    title: `拉黑「${nickname}」？`,
    content:
      '拉黑后，你们双方都无法再发消息、也无法新建会话（既有会话一并冻结）；' +
      '交易系统通知与面交流程不受影响，历史消息保留可见、可随时解除。' +
      '解除是单方的：对方若也拉黑了你，需对方一并解除后才恢复。',
    confirmText: '确认拉黑',
  }
}
