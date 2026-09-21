import Taro, { useLoad, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useState } from 'react'
import AuthRequired from '@/components/auth-required'
import OrderList, { TOTOP_THRESHOLD } from '@/components/order-list'
import { useAuthGuard } from '@/features/auth/guard'
import { useOrderList } from '@/features/transaction/useOrderList'

/**
 * 我买到的（订单页拆成的两页之一，另一页是 `pages/orders-sell`）。
 *
 * 拆分原因与形态（Owner 定版）：顶部改用**微信原生导航栏**（`index.config.ts` 的
 * `navigationStyle: 'default'`），标题就是「我买到的」；页内只保留 4 个状态 tab
 * （全部 / 待面交 / 已完成 / 已取消）+ 下面原有的区块标题行、排序开关、订单卡与到底提示。
 * 两个视角是两个页面，入口在「我的」页。
 *
 * 页面只负责 Taro 的**页面级 hook**（登录守卫、首次加载、下拉刷新、页面滚动）与数据；
 * 筛选、排序与全部渲染在共用的 `components/order-list` 里。
 */
export default function OrdersBuy() {
  const authStatus = useAuthGuard()
  const { items, loading, failed, truncated, reload } = useOrderList('buyer')
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
