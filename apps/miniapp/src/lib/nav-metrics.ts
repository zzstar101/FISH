import Taro from '@tarojs/taro'

/**
 * 顶部固定栏的栅格常量：一律**设备 px**，不参与 rpx 缩放。
 *
 * 为什么不照抄设计稿的固定数值：设计稿（`D:\Downloads\1改\小程序1版*.html`）里的
 * `.mp-capsule` 是静态稿画出来的**假胶囊**，而真机上右上角胶囊由微信原生绘制 ——
 * 它的位置和大小每台机器都不同（状态栏 44~54 不等）。照抄 87×32 / top 51 这类数值
 * 一定会在部分机型上错位，且没有意义：真机上那个位置本来就画不了东西。
 *
 * 所以这里做的是**避让**而不是复刻：运行时读 `getMenuButtonBoundingClientRect()`
 * 反推「内容行应有的高度」与「右侧必须让出多少」，保证一级标题与原生胶囊同一行居中、
 * 中槽内容（搜索胶囊 / 输入框）不会滑到胶囊底下被盖住。
 *
 * 这些值用于内联 style（`padding-top: 47px` 这样）。Taro 的 pxtransform 只处理样式表，
 * 内联 px 会原样下发成 CSS px —— 正是我们要的「跟随设备、不缩放」。
 */
export type NavMetrics = {
  /** 状态栏高度 */
  statusBarHeight: number
  /** 导航内容行高度：与胶囊等高居中 */
  contentHeight: number
  /** 右侧必须避让的宽度（屏宽 − 胶囊左边 + 间距） */
  capsuleInset: number
  /** 整条栏占用的高度（状态栏 + 内容行） */
  totalHeight: number
}

/**
 * 设计栅格的内容行高：44pt（设计稿 `.navbar{height:44px}`）。
 *
 * 两个用途：
 * 1. 取不到胶囊信息时（h5 预览、老基础库）的**兜底**，至少不会塌成 0 高；
 * 2. 按胶囊反推出的行高的**下限** —— 反推值在部分机型上比稿矮（本机 40pt：
 *    胶囊上留白 4 × 2 + 胶囊高 32），而一级标题是 35rpx（≈17.5pt）的字，行太矮会挤。
 *
 * 注意：抬高的是**整条栏占用的高度**（`totalHeight`），`contentHeight` 仍是胶囊那一段 ——
 * 标题继续与原生胶囊同行居中，多出来的高度补在内容行下方（见 `components/top-bar`），
 * 而不是把标题往下压 2pt。
 */
const DESIGN_CONTENT_HEIGHT = 44
const FALLBACK_CAPSULE_INSET = 106
const FALLBACK_STATUS_BAR = 20

export function readNavMetrics(): NavMetrics {
  try {
    const info = Taro.getWindowInfo()
    const statusBarHeight = Math.round(info.statusBarHeight ?? FALLBACK_STATUS_BAR)

    let menu: { top: number; height: number; left: number } | null = null
    try {
      const rect = Taro.getMenuButtonBoundingClientRect()
      // h5 / 部分环境返回全 0 的矩形，这种要当「取不到」处理，否则行高会算成 0
      if (rect && rect.height > 0 && rect.left > 0) menu = rect
    } catch {
      menu = null
    }

    if (!menu) {
      return {
        statusBarHeight,
        contentHeight: DESIGN_CONTENT_HEIGHT,
        capsuleInset: FALLBACK_CAPSULE_INSET,
        totalHeight: statusBarHeight + DESIGN_CONTENT_HEIGHT,
      }
    }

    // 胶囊上下留白对称是微信的排布规则，所以行高 = 上留白 × 2 + 胶囊高
    const gap = Math.max(0, menu.top - statusBarHeight)
    const contentHeight = Math.round(gap * 2 + menu.height)
    // 屏宽 − 胶囊左边 = 从胶囊左边缘到屏幕右边的整段，再留 12px 缝
    const capsuleInset = Math.round(info.windowWidth - menu.left + 12)

    return {
      statusBarHeight,
      contentHeight,
      capsuleInset,
      totalHeight: statusBarHeight + Math.max(contentHeight, DESIGN_CONTENT_HEIGHT),
    }
  } catch {
    return {
      statusBarHeight: FALLBACK_STATUS_BAR,
      contentHeight: DESIGN_CONTENT_HEIGHT,
      capsuleInset: FALLBACK_CAPSULE_INSET,
      totalHeight: FALLBACK_STATUS_BAR + DESIGN_CONTENT_HEIGHT,
    }
  }
}
