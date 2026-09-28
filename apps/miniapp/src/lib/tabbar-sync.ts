/**
 * 底栏选中态的**唯一**同步通道（Owner 2026-09-28 拍板：按页面路径显示高光，不做动画）。
 *
 * 为什么需要它：微信 custom-tab-bar 是**每个 Tab 页一个独立实例**，实例被复用显示时
 * 不会重新渲染，组件内部任何基于「挂载时算一次」的状态都会残留错位（实测：胶囊停在
 * 上一页的槽、蓝色文字对不上当前页）。
 *
 * 解法是 Taro 官方口径的 React 适配：每个 Tab 页在 `useDidShow`（onShow，此刻页面栈
 * 已就位）里广播一次，tab-bar 组件监听后按 `getCurrentPages()` 的真实 route 重新同步
 * 选中项。事件是全局广播 —— 所有实例都会收到并各自同步，**显示中的那个必然收到**，
 * 不可见实例同步成什么无所谓（它们下次显示前必有一次 onShow 广播修正）。
 */
import Taro from '@tarojs/taro'

export const TABBAR_ROUTE_EVENT = 'tabbar:route-changed'

/** Tab 页在 `useDidShow` 里调用；其余任何地方不要调。 */
export const notifyTabbarRoute = (): void => {
  Taro.eventCenter.trigger(TABBAR_ROUTE_EVENT)
}
