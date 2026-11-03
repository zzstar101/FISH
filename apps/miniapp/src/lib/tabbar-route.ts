/**
 * 「这个路由该不该渲染底栏」—— 底栏显隐的唯一判据（纯函数，无 Taro 依赖）。
 *
 * 唯一不渲染底栏的 Tab 页是出物页：设计稿该页（`小程序第1版。发布闲置publish-listing.html`）
 * **根本没有画底栏**（全文 grep `tabbar` 零命中）—— 发布表单要占满屏高，
 * 底栏浮在上面会压住提交区（Owner 2026-09-28 二次确认维持此设计）。
 *
 * `TAB_ITEMS` / `tabBar.list` 里**保留** sell 项：`switchTab` 仍需要它作为合法路由，
 * 隐藏只发生在底栏组件的渲染层。代价是该页只剩左上返回钮一个出口，
 * 所以 `pages/sell/index.tsx` 必须显示返回钮。
 *
 * 为什么判据单独成文件：底栏的显隐**不能**在渲染期现读 `getCurrentPages()`
 * （#562 根因 2）—— 底栏实例在被别的页面压住期间仍会因未读/身份等异步源重渲染，
 * 那时栈顶已不是自己，现读会把整条底栏画进一个看不见的页面，回到本页时又没人重新求值，
 * 于是「底栏卡在出物页上」。显隐必须跟着**页面 onShow 广播**进来的路由走（见
 * `lib/tabbar-sync`），而「路由 → 是否隐藏」这一小段在这里，便于用例直接钉住。
 *
 * 与 `features/auth/guard.ts` 第 2 条那派「Tab 页不能用 `redirectTo`」的说法**不矛盾**：
 * guard 讲的是**把 Tab 页从栈里换掉之后还要回来**的场景（登录页压在 Tab 页上，登录成功
 * `switchTab` 回首页，Tab 结构必须原样留着），所以那里必须 `navigateTo`。出物页发布成功
 * 是另一回事：目标页是非 Tab 的详情页，本页表单已 `resetForm()`、也**不该**再回到一张被
 * 清空的表单上 —— 换掉它正是我们要的效果（顺带让本页那个常驻底栏实例一起销毁）。
 * 判断标准是「换掉当前页之后，用户还需要回到它吗」，不是「当前页是不是 Tab 页」。
 */

/** 隐藏底栏的页面路由（`getCurrentPages()` 最后一项的 route，无前导斜杠） */
export const TABBAR_HIDDEN_ROUTE = 'pages/sell/index'

/**
 * `route` 是否为「不渲染底栏」的页面。
 *
 * 用 `includes` 而不是全等：真机上 route 可能带查询串（`pages/sell/index?id=…`），
 * 与底栏选中态匹配 `TAB_ITEMS` 的口径一致。空路由（栈还没就绪）按「不隐藏」处理 ——
 * 宁可先画出来让 onShow 广播纠正，也不要在真正的 Tab 页上留一片空白。
 */
export function isTabbarHiddenRoute(route: string): boolean {
  return route.includes(TABBAR_HIDDEN_ROUTE)
}
