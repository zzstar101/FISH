import Taro, { useLoad, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useState } from 'react'
import AuthRequired from '@/components/auth-required'
import OrderList, { TOTOP_THRESHOLD } from '@/components/order-list'
import { useAuthGuard } from '@/features/auth/guard'
import { useOrderList } from '@/features/transaction/useOrderList'

/**
 * 我卖出的（订单页拆成的两页之一，另一页是 `pages/orders-buy`）。
 *
 * 与「我买到的」唯一的结构差异就是视角：卡尾主按钮的文案由 `role` 决定
 * （卖家「打开交易码」，买家「打开二维码」），在 `components/order-list` 里按 `item.role` 分。
 */
export default function OrdersSell() {
  const authStatus = useAuthGuard()
  const { items, loading, failed, truncated, reload } = useOrderList('seller')
  const [showTop, setShowTop] = useState(false)

  useLoad(() => {
    void reload()
  })

  usePullDownRefresh(() => {
    // keepList：系统已经拉出原生指示器，不把列表换成骨架屏（否则用户丢掉阅读位置）
    void reload({ keepList: true }).then(() => Taro.stopPullDownRefresh())
  })

  usePageScroll(({ scrollTop }) => setShowTop(scrollTop > TOTOP_THRESHOLD))

  /** 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**，避免跳转落地前先画一帧 */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  return (
    <OrderList
      items={items}
      loading={loading}
      failed={failed}
      truncated={truncated}
      showTop={showTop}
      onRetry={() => void reload()}
    />
  )
}
