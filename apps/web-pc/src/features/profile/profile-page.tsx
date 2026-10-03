import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link } from '@tanstack/react-router'
import {
  Bookmark,
  ChevronRight,
  CircleDollarSign,
  Flag,
  Heart,
  History,
  MessageSquare,
  PackageCheck,
  PackageOpen,
  Pencil,
  ShoppingBag,
  Tags,
  UsersRound,
} from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../auth/auth-provider'
import { useLogout } from '../auth/queries'
import { useFavoritesTotal } from '../favorites/queries'
import { useViewHistoryTotal } from '../view-history/queries'
import { historyCountLabel } from '../view-history/view'
import { ProfileEditDialog } from './profile-edit'
import { useProfile } from './queries'

export function ProfilePage() {
  const { me } = useAuth()
  if (!me) return null
  return <ProfileContent key={me.id} ownerId={me.id} />
}

function ProfileContent({ ownerId }: { ownerId: string }) {
  const { me } = useAuth()
  const profile = useProfile(ownerId)
  // 收藏计数与收藏列表同源：读 `GET /me/favorites` 的全量 total，读不到显示未知而非 0
  // （不用 profileStats.favoriteCount——#190 已冻结不加字段，也保证两个数字同表同向）。
  const favoritesTotal = useFavoritesTotal(ownerId)
  // 足迹计数与浏览记录列表同源（`GET /me/view-history` 的 total），不用旁路 count。
  const viewHistoryTotal = useViewHistoryTotal(ownerId)
  const logout = useLogout()
  const [editOpen, setEditOpen] = useState(false)
  const [logoutError, setLogoutError] = useState<string | null>(null)

  if (profile.isPending) return <LoadingState label="正在加载个人中心…" />
  if (profile.isError) {
    return <ErrorState message="个人中心加载失败" onRetry={() => void profile.refetch()} />
  }

  const user = profile.data.user
  const stats = profile.data.stats

  async function handleLogout() {
    setLogoutError(null)
    try {
      await logout.mutateAsync()
      window.location.assign('/pc/login')
    } catch {
      setLogoutError('退出登录失败，请稍后重试')
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的</h1>
          <p className="mt-1.5 text-ink-3 text-sm">账号资料、发布与交易入口。</p>
        </div>
        <p className="text-ink-3 text-xs">{user.id === me?.id ? '真实 API · 当前账号' : ''}</p>
      </div>

      <Card className="gap-0 border border-line p-6">
        <div className="flex items-center gap-6">
          <UserAvatar
            avatarUrl={user.avatarUrl}
            className="size-20"
            emoji={user.nickname.slice(0, 1)}
            fallbackClassName="text-2xl"
            size="xl"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="truncate font-semibold text-2xl">{user.nickname}</h2>
              {/* 徽章本身就是认证入口（#380）：未认证时点它去 /verify 完成教育邮箱验证。 */}
              <Link
                aria-label={user.authStatus === 'VERIFIED' ? '查看校园认证' : '去完成校园认证'}
                className="inline-flex items-center gap-1"
                to="/verify"
              >
                {user.authStatus === 'VERIFIED' ? (
                  <Badge variant="success">已认证</Badge>
                ) : (
                  <Badge shape="pill" variant="secondary">
                    未认证 · 去认证
                  </Badge>
                )}
                <ChevronRight className="size-3.5 text-ink-3" />
              </Link>
            </div>
            <p className="mt-2 text-ink-3 text-sm">
              {user.phoneBound ? `手机号 ${user.maskedPhone ?? '已绑定'}` : '未绑定手机号'}
            </p>
          </div>
          <Button onClick={() => setEditOpen(true)} variant="outline">
            <Pencil className="size-4" />
            编辑资料
          </Button>
        </div>
      </Card>

      <section aria-label="我的统计" className="grid grid-cols-6 gap-4">
        <StatCard icon={PackageOpen} label="在售商品" value={stats.activeListings} to="/mylist" />
        <StatCard icon={Heart} label="活跃愿望" value={stats.activeWishes} to="/wish" />
        <StatCard
          icon={PackageCheck}
          label="完成交易"
          value={stats.completedTransactions}
          to="/orders"
        />
        <StatCard
          icon={Bookmark}
          label="收藏"
          to="/favorites"
          value={favoritesTotal.isError ? '未知' : (favoritesTotal.data ?? '未知')}
        />
        <StatCard icon={UsersRound} label="关注" to="/following" value={stats.followingCount} />
        <StatCard
          icon={History}
          label="足迹"
          // 与浏览记录列表同源（`GET /me/view-history` 的 total，同一张表同一个 30 天窗口）；
          // 读不到显示「未知」而不是 0 —— 0 是"确实没看过"，与"不知道"是两件事。
          value={historyCountLabel(viewHistoryTotal.data, viewHistoryTotal.isError)}
          to="/history"
        />
      </section>

      <section className="grid grid-cols-2 gap-4">
        <ShortcutCard
          description="查看全部发布、在售及已售出商品，管理上下架"
          icon={Tags}
          title="我的发布"
          to="/mylist"
        />
        <ShortcutCard
          description="查看我买入的订单，确认面交或取消交易"
          icon={ShoppingBag}
          search={{ role: 'buyer' }}
          title="买入订单"
          to="/orders"
        />
        <ShortcutCard
          description="查看我卖出的订单，跟踪面交流程"
          icon={CircleDollarSign}
          search={{ role: 'seller' }}
          title="卖出订单"
          to="/orders"
        />
        <ShortcutCard
          description="查看我发布的求购愿望与匹配结果"
          icon={Heart}
          title="我的许愿"
          to="/wish"
        />
      </section>

      <Link to="/comments">
        <Card className="gap-0 border border-line p-5 transition-colors hover:border-brand/40 hover:bg-brand-soft/30">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-brand">
                <MessageSquare className="size-5" />
              </span>
              <div>
                <h2 className="font-semibold">我的评论</h2>
                <p className="mt-0.5 text-ink-3 text-sm">查看你发过的商品留言与交易评价</p>
              </div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-ink-3" />
          </div>
        </Card>
      </Link>

      <Link to="/reports">
        <Card className="gap-0 border border-line p-5 transition-colors hover:border-brand/40 hover:bg-brand-soft/30">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-xl bg-surface-2 text-brand">
                <Flag className="size-5" />
              </span>
              <div>
                <h2 className="font-semibold">我的举报</h2>
                <p className="mt-0.5 text-ink-3 text-sm">查看你提交过的举报与处理进度</p>
              </div>
            </div>
            <ChevronRight className="size-4 shrink-0 text-ink-3" />
          </div>
        </Card>
      </Link>

      <Card className="gap-0 border border-line p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="font-semibold">退出登录</h2>
            <p className="mt-1 text-ink-3 text-sm">退出后需要重新登录才能继续使用 PC 端。</p>
          </div>
          <Button
            disabled={logout.isPending}
            onClick={() => void handleLogout()}
            variant="destructive"
          >
            {logout.isPending ? '正在退出…' : '退出登录'}
          </Button>
        </div>
        {logoutError !== null ? <p className="text-danger text-sm">{logoutError}</p> : null}
      </Card>

      <ProfileEditDialog onOpenChange={setEditOpen} open={editOpen} />
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  to,
}: {
  icon: typeof PackageOpen
  label: string
  value: number | string
  to: '/mylist' | '/wish' | '/orders' | '/favorites' | '/following' | '/history'
}) {
  return (
    <Link to={to}>
      <Card className="gap-0 border border-line p-5 transition-colors hover:border-brand/40 hover:bg-brand-soft/30">
        <div className="flex items-center justify-between">
          <span className="grid size-10 place-items-center rounded-xl bg-brand-soft text-brand">
            <Icon className="size-5" />
          </span>
          <ChevronRight className="size-4 text-ink-3" />
        </div>
        <p className="mt-5 font-bold text-3xl tabular-nums">{value}</p>
        <p className="mt-1 text-ink-3 text-sm">{label}</p>
      </Card>
    </Link>
  )
}

function ShortcutCard({
  icon: Icon,
  title,
  description,
  to,
  search,
}: {
  icon: typeof PackageOpen
  title: string
  description: string
  to: '/mylist' | '/wish' | '/orders'
  search?: { role: 'buyer' | 'seller' }
}) {
  return (
    <Link search={search} to={to}>
      <Card className="h-full gap-0 border border-line p-5 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md">
        <div className="flex items-start gap-4">
          <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-brand">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">{title}</h3>
            <p className="mt-1.5 text-ink-3 text-sm leading-6">{description}</p>
          </div>
          <ChevronRight className="mt-1 size-4 shrink-0 text-ink-3" />
        </div>
      </Card>
    </Link>
  )
}
