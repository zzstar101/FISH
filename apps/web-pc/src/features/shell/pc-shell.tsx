import { Outlet } from '@tanstack/react-router'
import { SideNav } from './side-nav'
import { TopBar } from './top-bar'

/** PC Web 应用外壳：顶栏 + 左侧导航 + 主内容。 */
export function PcShell() {
  return (
    <div className="min-h-dvh bg-bg">
      <TopBar />
      <div className="mx-auto grid w-full max-w-[1600px] grid-cols-[232px_minmax(0,1fr)] gap-7 px-8 py-7">
        <SideNav />
        <main className="min-w-0">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
