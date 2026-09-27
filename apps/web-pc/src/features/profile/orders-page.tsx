import type {
  TransactionDto,
  TransactionRole,
  TransactionStatus,
} from '@fish/contracts/transactions/schema'
import { Badge } from '@fish/ui/badge'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { UserAvatar } from '@fish/ui/user-avatar'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowRight, Clock, ShoppingBag, Store } from 'lucide-react'
import { ListingThumb } from '../../components/listing-thumb'
import { formatPrice, formatRelativeTimeAt } from '../../lib/format'
import { useAuth } from '../auth/auth-provider'
import type { OrderStatusFilter } from './api'
import { useOrders } from './queries'

const ROLE_TABS: ReadonlyArray<{
  value: TransactionRole
  label: string
  Icon: typeof ShoppingBag
}> = [
  { value: 'buyer', label: '我买入的', Icon: ShoppingBag },
  { value: 'seller', label: '我卖出的', Icon: Store },
]

const STATUS_FILTERS: ReadonlyArray<{ value: OrderStatusFilter; label: string }> = [
  { value: 'ALL', label: '全部状态' },
  { value: 'PENDING_MEETUP', label: '待面交' },
  { value: 'COMPLETED', label: '已完成' },
  { value: 'CANCELLED', label: '已取消' },
]

export function OrdersPage({
  role,
  status,
}: {
  role: TransactionRole
  status?: TransactionStatus
}) {
  const { me } = useAuth()
  if (!me) return null
  return <OrdersContent key={me.id} ownerId={me.id} role={role} status={status} />
}

function OrdersContent({
  ownerId,
  role,
  status,
}: {
  ownerId: string
  role: TransactionRole
  status?: TransactionStatus
}) {
  const navigate = useNavigate()
  const orders = useOrders(ownerId, role, status ?? 'ALL')

  function updateSearch(nextRole: TransactionRole, nextStatus?: TransactionStatus) {
    void navigate({ to: '/orders', search: { role: nextRole, status: nextStatus } })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-6">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">我的订单</h1>
          <p className="mt-1.5 text-ink-3 text-sm">买卖订单由服务端按角色与状态筛选。</p>
        </div>
        <p className="text-ink-3 text-xs">真实 API · 每页 50 条</p>
      </div>

      <section className="flex items-center justify-between gap-5 rounded-2xl border border-line bg-surface p-3">
        <div className="flex gap-2">
          {ROLE_TABS.map(({ value, label, Icon }) => {
            const active = role === value
            return (
              <button
                aria-pressed={active}
                className={`inline-flex h-10 items-center gap-2 rounded-xl px-4 font-medium text-sm transition-colors ${
                  active ? 'bg-brand text-white' : 'text-ink-2 hover:bg-brand-soft hover:text-brand'
                }`}
                key={value}
                onClick={() => updateSearch(value, status)}
                type="button"
              >
                <Icon className="size-4" />
                {label}
              </button>
            )
          })}
        </div>

        <label className="flex items-center gap-2 text-ink-2 text-sm">
          状态
          <select
            className="h-10 rounded-xl border border-line bg-surface-2 px-3 text-sm outline-none focus:ring-3 focus:ring-brand/15"
            onChange={(event) => {
              const next = STATUS_FILTERS.find((item) => item.value === event.target.value)
              updateSearch(role, next?.value === 'ALL' ? undefined : next?.value)
            }}
            value={status ?? 'ALL'}
          >
            {STATUS_FILTERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {orders.isPending ? <LoadingState label="正在加载订单…" /> : null}
      {orders.isError ? (
        <ErrorState message="订单加载失败" onRetry={() => void orders.refetch()} />
      ) : null}
      {orders.isSuccess && orders.data.items.length === 0 ? (
        <EmptyState
          description={role === 'buyer' ? '你还没有买入订单' : '你还没有卖出订单'}
          emoji="🧾"
          title="暂无订单"
        />
      ) : null}
      {orders.data !== undefined && orders.data.items.length > 0 ? (
        <div className="grid grid-cols-2 gap-4">
          {orders.data.items.map((order) => (
            <OrderCard order={order} key={order.id} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function OrderCard({ order }: { order: TransactionDto }) {
  const statusView = orderStatusView(order.status)

  return (
    <Link
      params={{ transactionId: order.id }}
      search={{ role: order.role }}
      to="/orders/$transactionId"
    >
      <Card className="h-full gap-0 border border-line p-5 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <Badge variant={statusView.variant}>{statusView.label}</Badge>
          <span className="flex items-center gap-1 text-ink-3 text-xs">
            <Clock className="size-3.5" />
            {formatRelativeTimeAt(order.createdAt)}
          </span>
        </div>

        <div className="mt-4 flex gap-4">
          <ListingThumb
            alt={order.listing.title}
            className="size-24 rounded-2xl"
            coverUrl={order.listing.coverUrl}
            listingId={order.listingId}
          />
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 font-semibold leading-6">{order.listing.title}</h2>
            <p className="mt-2 font-bold text-xl text-danger">{formatPrice(order.amountCents)}</p>
            <div className="mt-3 flex items-center gap-2">
              <UserAvatar
                avatarUrl={order.counterpart.avatarUrl}
                className="size-7"
                emoji={order.counterpart.nickname.slice(0, 1)}
                fallbackClassName="text-xs"
                size="sm"
              />
              <span className="truncate text-ink-3 text-xs">
                {order.role === 'buyer' ? '卖家' : '买家'}：{order.counterpart.nickname}
              </span>
            </div>
          </div>
          <ArrowRight className="mt-9 size-4 shrink-0 text-ink-3" />
        </div>
      </Card>
    </Link>
  )
}

export function orderStatusView(status: TransactionStatus): {
  label: string
  variant: 'warn' | 'success' | 'secondary'
} {
  if (status === 'PENDING_MEETUP') return { label: '待面交', variant: 'warn' }
  if (status === 'COMPLETED') return { label: '已完成', variant: 'success' }
  return { label: '已取消', variant: 'secondary' }
}
