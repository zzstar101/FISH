import Taro, { useDidShow, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import AuthRequired from '@/components/auth-required'
import OrderList, { TOTOP_THRESHOLD } from '@/components/order-list'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { useOrderList } from '@/features/transaction/useOrderList'

/**
 * 我卖出的（订单页拆成的两页之一，另一页是 `pages/orders-buy`）。
 *
 * 与「我买到的」唯一的结构差异就是视角：卡尾主按钮的文案由 `role` 决定
 * （卖家「打开交易码」，买家「打开二维码」），在 `components/order-list` 里按 `item.role` 分。
 *
 * 加载触发的口径（#89 审查收口）见 `pages/orders-buy`：请求由登录态与身份驱动、
 * `unknown → authed` 自动补首载、从面交页返回 `useDidShow` 重拉。
 */
export default function OrdersSell() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const { items, loading, failed, truncated, reload } = useOrderList('seller', userId)
  const [showTop, setShowTop] = useState(false)

  /** 登录态与身份驱动加载；依赖里带 `userId`，换账号自动重拉自己视角的订单 */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void reload()
  }, [authStatus, userId, reload])

  /**
   * 从面交页（或其它子页）返回时重拉。
   *
   * 首次 show **跳过**（那次由上面的登录态 effect 负责，时点更准），不跳过就会刚进页打两次 ——
   * 每次 `loadOrders` 都要游标翻页取完整份列表。
   *
   * 回调里的 `authStatus` 走 ref 读（与 `pages/chat` 同款写法）。
   */
  const skipFirstShow = useRef(true)
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'
  useDidShow(() => {
    if (skipFirstShow.current) {
      skipFirstShow.current = false
      return
    }
    if (!authedRef.current) return
    void reload({ keepList: true })
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
