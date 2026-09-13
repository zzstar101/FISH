import { ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChevronRight, Pencil } from 'lucide-react'
import { AuthBadge } from '../auth/auth-badge'
import { useLogout } from '../auth/queries'
import { AppShell } from '../navigation/app-shell'
import type { MyListType } from './mylist-page'
import { useProfileSummary, useResetDemoData } from './queries'

const VERSION = 'v0.1.0 · React + Vite'

export function ProfilePage() {
  const navigate = useNavigate()
  const summary = useProfileSummary()
  const reset = useResetDemoData()
  const logout = useLogout()

  if (summary.isPending) return <LoadingState />
  if (summary.isError) {
    return <ErrorState message="个人中心加载失败" onRetry={() => void summary.refetch()} />
  }
  if (!summary.data) return <ErrorState message="没有取到个人数据" />

  const { me, stats, orderInProgress, wishCount } = summary.data

  const signOut = () => {
    logout.mutate(undefined, {
      onSettled: () => void navigate({ to: '/login' }),
    })
  }

  return (
    <AppShell>
      <header className="bg-brand px-4 pt-6 pb-12 text-white">
        <div className="flex items-start gap-3">
          <UserAvatar
            avatarUrl={me.avatarUrl}
            className="shadow-[0_0_0_2px_rgba(255,255,255,0.45)]"
            emoji={me.nickname.slice(0, 1)}
            size="xl"
          />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2">
              <span className="truncate font-semibold text-xl">{me.nickname}</span>
              <AuthBadge status={me.authStatus} />
            </p>
            <p className="mt-1 truncate text-white/80 text-xs">
              {me.campus ? `${me.campus}校区` : '校区未填写'}
            </p>
            <button
              className="mt-2 rounded-md border border-dashed border-white/50 px-2 py-1 text-white/80 text-xs"
              type="button"
            >
              + 设置个性签名
            </button>
          </div>
          <button aria-label="编辑资料" className="text-white/90" type="button">
            <Pencil className="size-5" />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {/* authStatus 来自 Mock 教务 Provider（见 apps/api/src/app.ts 注释），
              只作为展示口径，不当作可信标识 —— 与 #5 的结论一致。 */}
          <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs">
            {me.authStatus === 'VERIFIED' ? '已实名' : '未实名'}
          </span>
          <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs">校内面交</span>
        </div>
      </header>

      <section className="relative mx-3 -mt-8 grid grid-cols-4 rounded-2xl bg-surface py-3 shadow-sm">
        {/* #12 工作项的四格统计：在售/愿望/买入/卖出。 */}
        <StatCell label="在售" type="active" value={stats.active} />
        <StatCell label="愿望" to="/wish" value={stats.wishes} />
        <StatCell label="买入" type="bought" value={stats.bought} />
        <StatCell label="卖出" type="sold" value={stats.sold} />
      </section>

      <section className="mt-4 px-3">
        <h2 className="mb-2 font-semibold text-[15px]">我的足迹</h2>
        <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface">
          <NavRow
            emoji="📄"
            label="我的订单"
            to="/orders"
            value={orderInProgress > 0 ? `${orderInProgress} 笔进行中` : undefined}
          />
          <NavRow emoji="☀️" label="我的愿望" to="/wish" value={`${wishCount} 条`} />
          <MylistRow emoji="🕐" label="浏览历史" type="history" />
          <MylistRow emoji="⭐" label="我的关注" type="follow" />
        </div>
      </section>

      <section className="mt-4 px-3 pb-6">
        <h2 className="mb-2 font-semibold text-[15px]">帮助与设置</h2>
        <div className="divide-y divide-line overflow-hidden rounded-2xl bg-surface">
          <StaticRow description="昵称 / 签名 / 学院 / 校区" emoji="👤" label="编辑个人资料" />
          <StaticRow description="校内面交、先验货后付款" emoji="🛡️" label="交易安全指南" />
          <StaticRow description="数据只保存在本机,不会上传" emoji="🔒" label="隐私设置" />
          <StaticRow description="问题反馈与功能建议" emoji="✉️" label="意见反馈" />
          <button
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
            onClick={() => reset.mutate()}
            type="button"
          >
            <RowIcon emoji="🧹" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px]">清除演示数据</span>
              <span className="mt-0.5 block text-ink-3 text-xs">清空本地收藏、浏览记录</span>
            </span>
            <ChevronRight className="size-[18px] shrink-0 text-ink-3" />
          </button>
          <button
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
            onClick={signOut}
            type="button"
          >
            <RowIcon emoji="🚪" />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-danger">退出登录</span>
              <span className="mt-0.5 block text-ink-3 text-xs">
                退出后需要重新登录才能继续使用
              </span>
            </span>
            <ChevronRight className="size-[18px] shrink-0 text-ink-3" />
          </button>
          <div className="flex items-center gap-3 px-4 py-3">
            <RowIcon emoji="ℹ️" />
            <span className="flex-1 text-[15px]">版本</span>
            <span className="text-ink-3 text-sm">{VERSION}</span>
          </div>
        </div>

        <p className="py-5 text-center text-ink-3 text-xs leading-relaxed">
          校园二手 · 让闲置在校园里流动起来
        </p>
      </section>
    </AppShell>
  )
}

function RowIcon({ emoji }: { emoji: string }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-lavender-soft text-lg">
      {emoji}
    </span>
  )
}

const cellClass = 'flex flex-col items-center gap-1 border-line border-l first:border-l-0'

/** 顶部四个统计格；除第一格外都带左分隔线。「愿望」没有对应的 mylist 分页，跳许愿池。 */
function StatCell(
  props:
    | { label: string; value: number; type: MyListType }
    | { label: string; value: number; to: '/wish' },
) {
  const content = (
    <>
      <span className="font-bold text-xl">{props.value}</span>
      <span className="text-ink-3 text-xs">{props.label}</span>
    </>
  )
  if ('to' in props) {
    return (
      <Link className={cellClass} to={props.to}>
        {content}
      </Link>
    )
  }
  return (
    <Link className={cellClass} search={{ type: props.type }} to="/mylist">
      {content}
    </Link>
  )
}

type RowContent = {
  emoji: string
  label: string
  description?: string
  value?: string
}

function RowBody({ emoji, label, description, value }: RowContent) {
  return (
    <>
      <RowIcon emoji={emoji} />
      <span className="min-w-0 flex-1">
        <span className="block text-[15px]">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-ink-3 text-xs">{description}</span>
        ) : null}
      </span>
      {value ? <span className="shrink-0 text-ink-3 text-sm">{value}</span> : null}
      <ChevronRight className="size-[18px] shrink-0 text-ink-3" />
    </>
  )
}

/** 跳转到一级/二级页面的设置行。 */
function NavRow({ to, ...content }: RowContent & { to: '/orders' | '/wish' }) {
  return (
    <Link className="flex items-center gap-3 px-4 py-3" to={to}>
      <RowBody {...content} />
    </Link>
  )
}

/** 尚未实现目标页的静态入口（#12 允许先做静态入口），不假装能跳转。 */
function StaticRow(content: RowContent) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <RowBody {...content} />
    </div>
  )
}

/** 跳转到「我的列表」指定分页的行。 */
function MylistRow({ type, ...content }: RowContent & { type: MyListType }) {
  return (
    <Link className="flex items-center gap-3 px-4 py-3" search={{ type }} to="/mylist">
      <RowBody {...content} />
    </Link>
  )
}
