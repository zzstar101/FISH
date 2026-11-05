import type { UserPresence } from '@fish/contracts/users/schema'
import { Text, View } from '@tarojs/components'
import { usePresenceNow } from './use-presence-now'
import { presenceView } from './view'

type PresenceBadgeProps = {
  /** 服务端给的那次判定；缺失（老服务端 / fixture 兜底）时本组件整块不渲染 */
  presence: UserPresence | null | undefined
  /**
   * 外壳类名（各展示位自己的 BEM 块，如 `detail__presence`）。
   * 绿点是 `${className}-dot`、文案是 `${className}-tx` —— 两处展示位的类名都与这个
   * 规律一致（`detail__presence-dot` / `detail__presence-tx`、`uhome__presence-dot` /
   * `uhome__presence-tx`），样式表因此一个字节都不用改。
   */
  className: string
}

/**
 * 在线态徽标：绿点 + 一句「在线 / 12 分钟前活跃 / 离线」（#359 第五点）。
 *
 * ## 为什么单独抽成一个组件（性能）
 *
 * 这段是页面上**唯一**需要跟着「现在」前进而重算的东西：端上按 `PRESENCE_ONLINE_TTL_MS`
 * 本地过期（见 `./view`），所以每 30s 要重算一次。改动前那个 30s 一跳的 `useState`
 * 挂在页面组件里，每跳把**整个页面**重渲染一遍（商品详情页上千节点、他人主页整屏列表）。
 *
 * 现在把「读现在」这件事关在这个小组件里：`usePresenceNow()` 订阅的是 `./tick` 的
 * 模块时钟，每跳只重渲染这一个绿点，页面主体一次都不重算。渲染出来的节点与类名和
 * 抽出来之前完全一致（同样的外壳 + dot + 文案），所以视觉、时序、样式零变化。
 *
 * 「现在」由页面通过 `usePresenceClock()` 报前台起停 —— 页面被盖住时表就停了，
 * 这里不会在后台白烧渲染。
 */
export function PresenceBadge({ presence, className }: PresenceBadgeProps) {
  const nowMs = usePresenceNow()
  const view = presenceView(presence, nowMs)
  // 拿不到在线态就整块不渲染：把「拿不到」画成「离线」是在编造一个结论（同 `./view`）
  if (!view) return null

  return (
    <View className={`${className}${view.online ? ' is-online' : ''}`}>
      <View className={`${className}-dot`} />
      <Text className={`${className}-tx`}>{view.text}</Text>
    </View>
  )
}
