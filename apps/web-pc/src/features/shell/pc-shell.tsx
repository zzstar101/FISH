import { Outlet } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { SideNav } from './side-nav'
import { TopBar } from './top-bar'

/**
 * PC Web 应用外壳：顶栏 + 左侧导航 + 主内容。
 *
 * 根节点刻意**不给** `bg-*`、也不加 `isolate`：背景主题（「深水层」，见 styles.css 的
 * body 规则）挂在 body 上，顶栏与侧栏要透过液态玻璃折射它。`bg-*` 会把水层整个盖掉；
 * `isolate` 会把这里变成 backdrop root，让子元素里的折射静默失效。
 */
export function PcShell({ children }: { children?: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-[232px_minmax(0,1fr)] gap-7 px-8 py-7">
        <SideNav />
        <main className="min-w-0">{children === undefined ? <Outlet /> : children}</main>
      </div>
    </div>
  )
}
