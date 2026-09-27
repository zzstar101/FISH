import { Link } from '@tanstack/react-router'
import { Compass, Heart, Home, MessageCircle, Search, UserRound } from 'lucide-react'

const NAV_ITEMS = [
  { to: '/', label: '首页', Icon: Home, exact: true },
  { to: '/search', label: '搜索', Icon: Search, exact: false },
  { to: '/wish', label: '许愿墙', Icon: Heart, exact: false },
  { to: '/messages', label: '消息', Icon: MessageCircle, exact: false },
  { to: '/profile', label: '我的', Icon: UserRound, exact: false },
] as const

/** PC Web 左侧一级导航。骨架阶段只保留一级路由，不画移动端底部 TabBar。 */
export function SideNav() {
  return (
    <aside className="sticky top-24 self-start">
      <nav aria-label="主导航" className="flex flex-col gap-1">
        {NAV_ITEMS.map(({ to, label, Icon, exact }) => (
          <Link
            activeOptions={{ exact }}
            className="flex h-11 items-center gap-3 rounded-xl px-3 text-ink-2 text-sm transition-colors hover:bg-surface hover:text-ink [&.active]:bg-brand-soft [&.active]:font-semibold [&.active]:text-brand-deep"
            key={label}
            to={to}
          >
            <Icon className="size-5" />
            {label}
          </Link>
        ))}
      </nav>

      <div className="mt-7 rounded-2xl border border-line bg-surface p-4">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Compass className="size-4 text-brand" />
          骨架阶段
        </div>
        <p className="mt-2 text-ink-2 text-xs leading-5">
          当前已接通登录、PC Web 外壳、首页商品流、搜索筛选和商品详情。发布、消息、我的仍是占位页。
        </p>
      </div>
    </aside>
  )
}
