import type { ComponentType, SVGProps } from 'react'
import { TabHomeIcon, TabMessageIcon, TabProfileIcon, TabSellIcon, TabWishIcon } from './tab-icons'

export type TabKey = 'home' | 'wish' | 'sell' | 'message' | 'profile'

/**
 * 统一信息架构（architecture.md §1 / #4）：首页 / 许愿 / 卖闲置 / 消息 / 我的。
 * 中间「出物」是视觉中心的大圆按钮，点击进入发布页。
 *
 * 图标是自绘的「开口一笔画圆角线条」SVG（tab-icons.tsx，按品牌图标组件规范），
 * 线宽与颜色由 tab-bar 按高亮/初始状态传入。
 */
export const TABS: {
  key: TabKey
  label: string
  to: '/' | '/wish' | '/publish' | '/message' | '/profile'
  Icon: ComponentType<SVGProps<SVGSVGElement>>
  center?: boolean
}[] = [
  { key: 'home', label: '首页', to: '/', Icon: TabHomeIcon },
  { key: 'wish', label: '许愿', to: '/wish', Icon: TabWishIcon },
  { key: 'sell', label: '出物', to: '/publish', Icon: TabSellIcon, center: true },
  { key: 'message', label: '信息', to: '/message', Icon: TabMessageIcon },
  { key: 'profile', label: '我的', to: '/profile', Icon: TabProfileIcon },
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
