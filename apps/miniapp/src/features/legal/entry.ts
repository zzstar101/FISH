/**
 * 法务页的**入口来源**判定。
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
 * 「不同意」的决定要不要带回登录页（跨页**一次性**信号）。
 *
 * 为什么需要它：法务页吸底同意条上的「不同意」只能 `navigateBack()`，而登录页的协议勾选
 * 默认是**勾上**的（`pages/login/index.tsx` 的 `useState(true)`）—— 不把这个决定带回去，
 * 用户点了「不同意」回到登录页照样能一键登录，那句「未同意，无法继续使用」就是假的。
 *
 * 用法：法务页 `markDeclined()` → `navigateBack()`；登录页在 `useDidShow` 里 `takeDeclined()`，
 * 取到就取消勾选。**取走即清**，所以不会在之后每次返回登录页时反复取消用户的勾选。
 *
 * 用模块级单值而不是 `Taro.eventCenter`：这条链路只有一个发送方一个接收方，
 * 一次性语义明确，且这样本文件保持 Taro-free、可直接单测（见 `tests/legal-entry.test.ts`）。
 */
let declinedByUser = false

/** 标记「用户刚刚在法务页点了不同意」 */
export function markDeclined(): void {
  declinedByUser = true
}

/** 取走该标记（取到即清空），供登录页在 `useDidShow` 里消费 */
export function takeDeclined(): boolean {
  const value = declinedByUser
  declinedByUser = false
  return value
}
