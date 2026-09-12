import { NavBar } from '@fish/ui/nav-bar'
import { EmptyState, LoadingState } from '@fish/ui/states'
import { Tabs, TabsList, TabsTrigger } from '@fish/ui/tabs'
import { useState } from 'react'
import { OrderCard } from '../transaction/order-card'
import { useOrders } from '../transaction/queries'

const ROLES = [
  { value: 'buy', label: '我买入的' },
  { value: 'sell', label: '我卖出的' },
] as const

/** 我的订单（#12 聚合 + #11 交易状态机）。 */
export function OrdersPage() {
  const [role, setRole] = useState<'buy' | 'sell'>('buy')
  const orders = useOrders(role)

  /** Radix 只回传 string：拿它反查 ROLES 收窄成买入/卖出，避免写类型断言。 */
  const changeRole = (next: string) => {
    const picked = ROLES.find((item) => item.value === next)
    if (picked) setRole(picked.value)
  }

  return (
    <div className="min-h-dvh bg-bg pb-8">
      <div className="sticky top-0 z-20 bg-surface">
        <NavBar onBack={() => window.history.back()} title="我的订单" />
        <div className="px-4 pb-3">
          <Tabs onValueChange={changeRole} value={role}>
            <TabsList>
              {ROLES.map((item) => (
                <TabsTrigger key={item.value} value={item.value}>
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      <div className="space-y-2.5 px-3 pt-3">
        {orders.isPending ? <LoadingState /> : null}
        {orders.data?.length === 0 ? (
          <EmptyState description="还没有交易,去和同学聊聊吧" emoji="📄" />
        ) : null}
        {orders.data?.map((order) => (
          <OrderCard key={order.id} order={order} />
        ))}
      </div>

      <p className="px-6 py-4 text-center text-ink-3 text-xs leading-relaxed">
        交易成功后,建议在图书馆、食堂等校内公共区域当面验货交割
      </p>
    </div>
  )
}
