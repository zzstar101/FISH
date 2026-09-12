import type { ReactNode } from 'react'
import { TabBar } from './tab-bar'

/**
 * 一级页面的外壳：内容下方悬浮着底部导航。
 *
 * 这里不再接收「当前是哪个 Tab」——导航自己按路由判断（`TAB_ROUTES`），
 * 于是二级页即使误用了 AppShell 也不会冒出导航。
 *
 * 底部留白用 `pb-tabbar`：让最后一条内容不被悬浮导航胶囊压住。
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh pb-tabbar">
      {children}
      <TabBar />
    </div>
  )
}
