/**
 * 「回到顶部」悬浮钮（1版稿 `.totop`）—— 全应用唯一的一份实现。
 *
 * 为什么是**纯 UI**：滚动源的机制天然分叉 —— 列表页是页面级滚动（`usePageScroll`），
 * 订单页（order-list）是内部滚动容器；出现与否还可能叠加页面自己的条件（如收藏页
 * 的管理态）。所以本组件不监听滚动：页面按自己的滚动源与阈值算好 `show`，点击后
 * 由页面自己滚回顶部（页面级 `Taro.pageScrollTo(0)` 或容器的 scrollTo），这里只负责
 * 这枚钮的视觉、浮现过渡与点击态。阈值常量 `BACK_TOP_THRESHOLD` 也随组件走，
 * 页面不要再各写一个数字。
 *
 * 箭头用**单枚**向上折角（45° 折角，CSS 画法；Owner 拍板：不要双箭头/竖杆变体）。
 * 原生组件的返回按钮（顶栏那类）与本组件无关，不在统一范围。
 */
import { View } from '@tarojs/components'
import './index.scss'

/** 出现阈值（逻辑 px = 设计稿 pt，**不是** rpx，不 ×2）：滚过约一屏后浮现 */
export const BACK_TOP_THRESHOLD = 380

type Props = {
  /** 是否浮现（页面按自己的滚动源与阈值算好再传） */
  show: boolean
  /** 点击回调：页面自己滚回顶部 */
  onTop: () => void
  /**
   * 距视口底的距离。⚠️ **内联样式不走 pxtransform**：请直接传 `rpx` 字符串
   * （传 `px` 会按 CSS px 生效、数值等于翻倍）。各页设计稿取值不同随页传入：
   * Tab 页 `'145rpx'` 抬到底栏正上方，默认 28pt + 安全区（无稿可依的新页面用）。
   */
  bottom?: string
  /**
   * 距视口右的距离。默认 36px（贴近右缘但不贴死，Owner 拍板「别贴边」）；
   * 特殊页面可传 rpx 字符串覆盖。
   */
  right?: string
}

export default function BackTop({ show, onTop, bottom, right }: Props) {
  return (
    <View
      className={`backtop${show ? ' is-show' : ''}`}
      style={{ ...(bottom ? { bottom } : {}), ...(right ? { right } : {}) }}
      onClick={onTop}
    >
      <View className="backtop__arrow" />
    </View>
  )
}
