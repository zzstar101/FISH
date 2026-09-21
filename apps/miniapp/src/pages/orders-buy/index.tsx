import Taro, { useDidShow, usePageScroll, usePullDownRefresh } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import AuthRequired from '@/components/auth-required'
import OrderList, { TOTOP_THRESHOLD } from '@/components/order-list'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { useOrderList } from '@/features/transaction/useOrderList'

/**
 * 我买到的（订单页拆成的两页之一，另一页是 `pages/orders-sell`）。
 *
 * 拆分原因与形态（Owner 定版）：顶部改用**微信原生导航栏**（`index.config.ts` 的
 * `navigationStyle: 'default'`），标题就是「我买到的」；页内只保留 4 个状态 tab
 * （全部 / 待面交 / 已完成 / 已取消）+ 下面原有的区块标题行、排序开关、订单卡与到底提示。
 * 两个视角是两个页面，入口在「我的」页。
 *
 * 页面只负责 Taro 的**页面级 hook**（登录守卫、加载触发、下拉刷新、页面滚动）与数据；
 * 筛选、排序与全部渲染在共用的 `components/order-list` 里。
 *
 * ## 加载触发的口径（#89 审查收口）
 *
 * 请求**只由登录态与身份驱动**（`useEffect` on `[authed, userId]`），不在 `useLoad`
 * 里抢跑：冷启动 `authStatus` 还是 `unknown` 时就发 `GET /transactions`，会先以
 * 未登录身份失败（开发 / 预览构建还会被那次 401 回退成 mock），随后恢复 `authed`
 * 也不会自动重试 —— 页面停在错误态。改为 `authed` 后才发，`unknown → authed`
 * 自然触发首次加载；身份一变（换账号 / 退出）由 `useOrderList` 的渲染期重置清场。
 *
 * 从面交页返回由 `useDidShow` 补一次重拉（首次 show 跳过 —— 那次由登录态 effect
 * 负责，时点更准）：面交核销会把本单推进到已完成，返回后列表不能停在旧快照。
 */
export default function OrdersBuy() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const { items, loading, failed, truncated, reload } = useOrderList('buyer', userId)
  const [showTop, setShowTop] = useState(false)

  /** 登录态与身份驱动加载；依赖里带 `userId`，换账号自动重拉自己视角的订单 */
  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void reload()
  }, [authStatus, userId, reload])

  /**
   * 从面交页（或其它子页）返回时重拉。`authStatus` 走 ref 读最新值：
   * `useDidShow` 的回调注册一次，直接闭包会读到旧状态。
   */
  const authedRef = useRef(false)
  authedRef.current = authStatus === 'authed'
  useDidShow(() => {
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
