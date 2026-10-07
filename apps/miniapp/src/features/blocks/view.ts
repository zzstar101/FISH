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

/** 读状态的归类结果：`failed` 带行内文案，页面不自己拼错误句。 */
export type BlockReadOutcome =
  | { kind: 'loaded'; blocked: boolean }
  | { kind: 'notFound' }
  | { kind: 'failed'; message: string }

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
 * 读拉黑状态的失败归类：404 `USER_NOT_FOUND` 单独成 `notFound`（降级「不可拉黑」），
 * 与网络 / 服务端失败分开——后者保留重试语义。两种都不能让入口假装成「未拉黑可点」。
 */
export function classifyBlockRead(error: unknown): BlockReadOutcome {
  const { code, status } = apiErrorShapeOf(error)
  if (status === 404 && code === 'USER_NOT_FOUND') return { kind: 'notFound' }
  return { kind: 'failed', message: describeBlockFailure(error) }
}

/**
 * 他人主页拉黑入口的 UI 状态推导（对齐 PC `blockButtonState` 的口径）。
 *
 * 与关注钮同一边界：**读到状态之前不渲染**（`visible: false`），读失败 / 目标不存在
 * 也不渲染 —— 绝不猜一个状态画上去。渲染后：blocked=true 是「解除拉黑」（恢复性动作，
 * 点击直接执行）；false 是「拉黑该用户」（点击先过确认弹窗）。
 */
export type BlockEntryView = {
  visible: boolean
  label: string
  busy: boolean
  blocked: boolean
}

export function blockEntryView(input: {
  read: BlockReadOutcome | null
  pending: boolean
}): BlockEntryView {
  if (input.read === null || input.read.kind !== 'loaded') {
    return { visible: false, label: '拉黑该用户', busy: false, blocked: false }
  }
  if (input.pending) {
    return {
      visible: true,
      label: input.read.blocked ? '解除中…' : '拉黑中…',
      busy: true,
      blocked: input.read.blocked,
    }
  }
  return {
    visible: true,
    label: input.read.blocked ? '解除拉黑' : '拉黑该用户',
    busy: false,
    blocked: input.read.blocked,
  }
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
