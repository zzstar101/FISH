/**
 * 底栏「显示时刷新未读」（#170 判据 D）的判据。
 *
 * 抽成纯函数是为了能被单测锁住：底栏是框架渲染的独立自定义组件
 * （`app.config.ts` 的 `tabBar.custom` + `src/custom-tab-bar/`），本仓没有组件渲染
 * 测试基建，组件本身在测试里跑不起来。
 *
 * 与 `pages/profile/view.ts`、`pages/match/view.ts` 的 `shouldRefreshOnShow` 只差一点：
 * 那两处跳过「首次显示」，因为它们的挂载 effect 必定为首屏发一次请求。底栏不能照抄 ——
 * 自定义 tabBar 由框架挂在页面里，每个 Tab 页各有一份实例，实例的「首次显示」就是
 * 该页第一次被打开；而挂载期补数在「本账号已有快照」时直接返回（`hydrateUnread`），
 * 跳过首次显示就等于「第一次打开这个 Tab 不刷新」。不跳也不会与挂载期补数双发：
 * 同账号在途时 store 的在途去重会让后到的那次直接返回（谁先谁注册）。
 *
 * 返回「该为哪个账号刷新」（不需要刷新时 `null`）而不只是布尔值：调用方拿到非空
 * 账号后就完成了类型收窄，不必在组件里再写一遍 `userId` 判空。
 */
export function refreshTargetOnShow(input: {
  authed: boolean
  userId: string | null
  /** 当前路由不渲染底栏（「出物」页） */
  hiddenRoute: boolean
}): string | null {
  if (input.hiddenRoute) return null
  if (!input.authed) return null
  return input.userId
}
