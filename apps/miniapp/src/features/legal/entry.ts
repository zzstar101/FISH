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
