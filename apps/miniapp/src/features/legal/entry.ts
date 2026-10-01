/**
 * 法务页的**入口来源**判定与**同意决定**的跨页回传。
 *
 * 稿的取舍 ⑦：吸底同意条（`.agree-bar`）**只在从登录/注册流程进入时**出现 ——
 * 从设置页进来是纯阅读，给同意条等于让用户对一个已经生效的协议再点一次「同意」，
 * 语义是错的。
 *
 * 所以入口方必须把自己的来源写进 query，页面据此决定要不要渲染同意条：
 * `pages/login` 的两个协议链分别带 `?from=login`。没有这个参数（设置页 / 关于页进来）
 * 就是纯阅读态。
 */
export function isEntryFromAuth(params: { from?: string }): boolean {
  return params.from === 'login' || params.from === 'register'
}

/**
 * 用户在同意条上的决定。**两个方向都要回传**，只做一半会造出自相矛盾的界面：
 *
 * - `declined` 不回传 → 登录页的协议勾选默认是勾上的（`pages/login/index.tsx` 的
 *   `useState(true)`），用户点了「不同意」回到登录页照样能一键登录，那句
 *   「未同意，无法继续使用」就是假的；
 * - `agreed` 不回传 → 用户先取消勾选、再进协议页点「同意并继续」，回到登录页勾选**仍是空的**，
 *   CTA 仍是禁用态 —— 用户刚在屏上按过「同意」，界面却否认，而同意条自己写着
 *   「点击即表示你已阅读并同意」。
 *
 * 用模块级单值而不是 `Taro.eventCenter`：这条链路只有一个发送方（法务页）一个接收方
 * （登录页），**取走即清**的一次性语义明确，且这样本文件保持 Taro-free、可直接单测
 * （见 `tests/legal-entry.test.ts`）。
 */
export type ConsentDecision = 'agreed' | 'declined'

let pendingConsent: ConsentDecision | null = null

/** 记下用户刚在同意条上做的决定（法务页调用，随后 `navigateBack`） */
export function markConsent(decision: ConsentDecision): void {
  pendingConsent = decision
}

/** 取走该决定（取到即清空），供登录页在 `useDidShow` 里消费；没有待处理的决定时返回 `null` */
export function takeConsent(): ConsentDecision | null {
  const value = pendingConsent
  pendingConsent = null
  return value
}

/**
 * 把决定应用到登录页**当前**的勾选态上；`null`（没有待处理的决定）保持原值。
 *
 * 单独摘成纯函数是为了让它可测：登录页那一行 `setAgreed` 被删掉时，
 * typecheck / lint / 现有测试都不会红，而这条正是「同意并继续」有没有落地的唯一凭据
 * （见 `tests/legal-entry.test.ts`）。
 */
export function applyConsent(decision: ConsentDecision | null, current: boolean): boolean {
  if (decision === 'agreed') return true
  if (decision === 'declined') return false
  return current
}
