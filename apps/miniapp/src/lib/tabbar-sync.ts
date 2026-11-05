/**
 * 微信 custom-tab-bar 每页一实例：onShow 广播实际路由，选中态与显隐只认它。
 * #612 的共享状态仅描述装饰动画，不提前改选中项，也不延迟/代理页面栈。
 */
import Taro from '@tarojs/taro'
import { createTabTransition, type TabTransition } from './tab-transition'

export const TABBAR_ROUTE_EVENT = 'tabbar:route-changed'
const transition = createTabTransition()

export function currentTabRoute(): string {
  if (process.env.TARO_ENV === 'h5' && typeof window !== 'undefined') {
    return window.location.hash.replace(/^#\/?/, '').split('?')[0] ?? ''
  }
  try {
    const pages = Taro.getCurrentPages()
    return pages[pages.length - 1]?.route ?? ''
  } catch {
    return ''
  }
}

/** 仅由底栏点击发起；失败只撤销自己的意图，不触碰任何页面或取数状态。 */
export function switchTabWithTransition(url: string): void {
  const id = transition.begin(currentTabRoute(), url.replace(/^\//, ''), Date.now())
  void Taro.switchTab({ url }).catch(() => transition.cancel(id))
}

export function readTabTransition(): TabTransition | null {
  return transition.read(currentTabRoute(), Date.now())
}

export function resetTabTransition(): void {
  transition.reset()
}

/** Tab 页每次 onShow 调一次；意图只消费一次，挂载晚的底栏可 read 同一快照。 */
export function notifyTabbarRoute(): TabTransition | null {
  const motion = transition.arrive(currentTabRoute(), Date.now())
  Taro.eventCenter.trigger(TABBAR_ROUTE_EVENT)
  return motion
}
