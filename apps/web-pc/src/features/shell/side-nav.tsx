import { LiquidGlassLayer } from '@fish/ui/liquid-glass'
import { Link } from '@tanstack/react-router'
import { Compass, Heart, Home, MessageCircle, Search, UserRound } from 'lucide-react'

const NAV_ITEMS = [
  { to: '/', label: '首页', Icon: Home, exact: true },
  { to: '/search', label: '搜索', Icon: Search, exact: false },
  { to: '/wish', label: '许愿墙', Icon: Heart, exact: false },
  { to: '/messages', label: '消息', Icon: MessageCircle, exact: false },
  { to: '/profile', label: '我的', Icon: UserRound, exact: false },
] as const

/** PC Web 左侧一级导航。只保留一级路由，不画移动端底部 TabBar。 */
export function SideNav() {
  return (
    <aside className="sticky top-24 self-start">
      {/*
       * 液态玻璃导航面板。`relative z-0` 只为建层叠上下文，让 warp 的 z-index:-1 待在面板
       * 内部；不能用 isolate，那会把面板变成 backdrop root、折射直接消失。
       *
       * 激活项用「亮玻璃胶囊 + 品牌蓝深档文字」表示当前位置，而不是靠单一颜色：
       * skill 的 nav-state-active 要求当前位置必须被明确高亮，而原写法 `text-brand-deep`
       * 指向一个**并不存在的令牌**（web-pc 没有 --color-brand-deep），激活项文字算出来和
       * 未激活项一模一样。这里换成确实定义了的 --color-lavender（styles.css:45，
       * 注释里就是为「当文字用仍有对比度」留的深档）。
       */}
      <div className="pc-glass relative z-0 rounded-2xl border border-white/55 bg-white/60 p-2.5">
        {/*
         * 磨砂比组件默认（24px）薄，因为这块面板背后是**稳定不动**的水层，没有内容会从它
         * 底下滚过去——liquid-glass.tsx 里警告的「把滚过的文字拖进边缘」在这里不成立。
         * 薄磨砂才留得住气泡边缘，折射才看得见（模糊一条平滑渐变等于没模糊）。
         * 顶栏相反：它底下有商品卡滚动，所以那边沿用默认的厚磨砂。
         */}
        <LiquidGlassLayer blurAmount={0.08} displacementScale={22} />
        <nav aria-label="主导航" className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ to, label, Icon, exact }) => (
            <Link
              activeOptions={{ exact }}
              className="flex h-11 items-center gap-3 rounded-xl px-3 text-ink-2 text-sm transition-colors hover:bg-white/55 hover:text-ink [&.active]:bg-white/80 [&.active]:font-semibold [&.active]:text-lavender"
              key={label}
              to={to}
            >
              <Icon className="size-5" />
              {label}
            </Link>
          ))}
        </nav>
      </div>

      <div className="mt-7 rounded-2xl border border-white/70 bg-white/72 p-4 backdrop-blur-md">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Compass className="size-4 text-brand" />
          当前进度
        </div>
        <p className="mt-2 text-ink-2 text-xs leading-5">
          当前已接通登录、PC Web
          外壳、首页商品流、搜索筛选、商品详情、消息中心、发布、通知、个人中心与订单、许愿墙与匹配、
          他人主页、举报与我的举报。
        </p>
      </div>
    </aside>
  )
}
