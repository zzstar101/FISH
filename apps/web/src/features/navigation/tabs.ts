import type { LucideIcon } from 'lucide-react'
import { Camera, House, MessageCircle, Star, User } from 'lucide-react'

export type TabKey = 'home' | 'wish' | 'sell' | 'message' | 'profile'

/**
 * 统一信息架构（architecture.md §1 / #4）：首页 / 许愿 / 卖闲置 / 消息 / 我的。
 * 中间「出物」是视觉中心的大圆按钮，点击进入发布页。
 *
 * 图标来自 shadcn/ui 指定的 `lucide-react`（替换掉原来的自研 SVG 图标集）。
 */
export const TABS: {
  key: TabKey
  label: string
  to: '/' | '/wish' | '/publish' | '/message' | '/profile'
  Icon: LucideIcon
  center?: boolean
}[] = [
  { key: 'home', label: '首页', to: '/', Icon: House },
  { key: 'wish', label: '许愿', to: '/wish', Icon: Star },
  { key: 'sell', label: '出物', to: '/publish', Icon: Camera, center: true },
  { key: 'message', label: '消息', to: '/message', Icon: MessageCircle },
  { key: 'profile', label: '我的', to: '/profile', Icon: User },
]

/**
 * 底部导航的显示范围：只有这里登记的路由才挂导航，其余（详情 / 聊天 / 分类 /
 * 发布 / 搜索 / 订单…）都是二级页，导航整条不渲染。
 *
 * 中间「出物」的落点 `/publish` 故意不登记——发布页自带底部提交栏，挂导航会撞在一起。
 */
export const TAB_ROUTES: Record<string, TabKey> = {
  '/': 'home',
  '/wish': 'wish',
  '/message': 'message',
  '/profile': 'profile',
}
