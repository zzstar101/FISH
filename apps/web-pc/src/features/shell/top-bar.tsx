import { Button } from '@fish/ui/button'
import { Input } from '@fish/ui/input'
import { LiquidGlassLayer } from '@fish/ui/liquid-glass'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { Bell, MessageCircle, Plus, Search } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import { useUnreadNotificationCount } from '../notifications/queries'

/** PC Web 顶栏：品牌、全局搜索、发布入口、通知 / 消息、当前用户。 */
export function TopBar() {
  const navigate = useNavigate()
  const { me } = useAuth()
  const unread = useUnreadNotificationCount(me !== null)
  const [keyword, setKeyword] = useState('')
  const unreadCount = unread.data ?? 0

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const q = keyword.trim()
    void navigate({ to: '/search', search: q.length > 0 ? { q } : {} })
  }

  return (
    /*
     * 液态玻璃顶栏。原来的 `bg-surface/95 backdrop-blur` 必须去掉：`backdrop-filter`
     * 会让这里变成 backdrop root，把 <LiquidGlassLayer/> 的折射直接压没（磨砂改由
     * 它自己的 warp 提供）。`sticky z-30` 同时负责建层叠上下文，让 warp 的
     * z-index:-1 老实待在玻璃内部。见 styles.css 的 .pc-glass。
     *
     * 磨砂用组件默认值（blurAmount 0.375 → 24px），**不调薄**：顶栏是 sticky 的，
     * 商品卡会从它底下滚过去，正是 liquid-glass.tsx 里「14px 挡不住位移、会把文字拖进
     * 边缘像鬼影」那个实测场景。玻璃要透得好看的地方在侧栏（见 side-nav）。
     * 白度 /72 由那行 --color-ink-3 的副标题「广应科校内二手」倒推：它直接落在玻璃上，
     * 必须让对比度不低于原来的 2.91。`saturation` 也要从默认的 180 收到 120 —— 180 会把
     * 水层的青放大到蓝通道接近饱和（实测底色 rgb(200,230,253)），亮度掉下来，那行副标题
     * 就只有 2.47；120 下回到约 2.98。
     */
    <header className="pc-glass sticky top-0 z-30 h-16 border-b border-white/55 bg-white/72">
      <LiquidGlassLayer saturation={120} />
      <div className="mx-auto flex h-full max-w-[1600px] items-center gap-7 px-8">
        <Link className="flex min-w-[220px] items-center gap-2.5" to="/">
          <img alt="鱼小应" className="size-8 object-contain" src="/pc/brand-fish.png" />
          <span className="font-bold text-[17px] tracking-[-0.02em]">鱼小应</span>
          <span className="text-ink-3 text-xs">广应科校内二手</span>
        </Link>

        <form className="flex max-w-[640px] flex-1" onSubmit={submit}>
          <div className="flex h-11 w-full items-center gap-2.5 rounded-xl bg-surface-2 px-3.5 focus-within:ring-3 focus-within:ring-brand/15">
            <Search className="size-4 shrink-0 text-ink-3" />
            <Input
              aria-label="搜索商品"
              className="h-auto min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              maxLength={50}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜校园好物，如 自行车 / 考研资料"
              value={keyword}
            />
          </div>
        </form>

        <div className="ml-auto flex items-center gap-2">
          <Button asChild className="h-10 px-4">
            <Link to="/publish">
              <Plus className="size-4" />
              发布闲置
            </Link>
          </Button>
          <Link
            aria-label={unreadCount > 0 ? `通知，${unreadCount} 条未读` : '通知'}
            className="relative grid size-10 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            to="/notifications"
          >
            <Bell className="size-5" />
            {unreadCount > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-coral px-1 font-semibold text-[10px] text-white leading-none">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            ) : null}
          </Link>
          <Link
            aria-label="消息"
            className="grid size-10 place-items-center rounded-lg text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            to="/messages"
          >
            <MessageCircle className="size-5" />
          </Link>
          <Link aria-label="我的" className="ml-1" to="/profile">
            <UserAvatar
              avatarUrl={me?.avatarUrl ?? null}
              emoji={me?.nickname.slice(0, 1) ?? '鱼'}
              fallbackClassName="text-sm"
              size="default"
            />
          </Link>
        </div>
      </div>
    </header>
  )
}
