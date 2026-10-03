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
  /** 微信原生胶囊的真实高度（设备 px）；取不到时用典型值兜底 */
  capsuleHeight: number
  /** 胶囊顶部距状态栏的留白（设备 px），上下对称 */
  capsuleGap: number
}

/**
 * 左上角返回钮的规格（2026-10-02 拍板）：**与右侧微信原生胶囊等高、同一行居中**。
 *
 * 不再沿用设计稿的两档固定值（漂浮钮 36pt / 栏内钮 32pt）—— 那两档与胶囊都不严格
 * 等高（iPhone 胶囊 32pt，安卓机型各异），只有按运行时胶囊矩形下发行内 px 才能在
 * 所有机型上精确等高对齐。箭头按 0.28 钮径比（延续 64px 钮配 18px 箭头的原比例）。
 */
const BACK_BTN_CHEVRON_RATIO = 0.28
/** 描边随钮径等比（原 64px 钮 4px 描边） */
const BACK_BTN_CHEVRON_BORDER_RATIO = 4 / 64

export function backButtonGeometry(capsuleHeight: number) {
  const size = Math.round(capsuleHeight)
  const chevron = Math.round(size * BACK_BTN_CHEVRON_RATIO)
  const chevronBorder = Math.max(2, Math.round(size * BACK_BTN_CHEVRON_BORDER_RATIO))
  const chevronShift = Math.round((chevron / 6) * 2) / 2
  return {
    size,
    chevron,
    chevronBorder,
    chevronShift,
    /** 返回钮的行内 style（width/height，设备 px） */
    btnStyle: { width: `${size}px`, height: `${size}px` },
    /** 标准圆钮内 CSS 箭头的行内 style（几何随胶囊高等比） */
    chevronStyle: {
      width: `${chevron}px`,
      height: `${chevron}px`,
      borderLeftWidth: `${chevronBorder}px`,
      borderBottomWidth: `${chevronBorder}px`,
      borderRadius: '1px',
      transform: `translateX(${chevronShift}px) rotate(45deg)`,
    },
  }
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
/** 取不到胶囊矩形时的典型胶囊高（iPhone 机型实测档） */
const FALLBACK_CAPSULE_HEIGHT = 32
/** 取不到时按 44pt 行高对称推：上下留白 (44 − 32) / 2 */
const FALLBACK_CAPSULE_GAP = (DESIGN_CONTENT_HEIGHT - FALLBACK_CAPSULE_HEIGHT) / 2

export function readNavMetrics(): NavMetrics {
  try {
    const info = Taro.getWindowInfo()
    const statusBarHeight = Math.round(info.statusBarHeight ?? FALLBACK_STATUS_BAR)

    let menu: { top: number; height: number; left: number } | null = null
    try {
      const rect = Taro.getMenuButtonBoundingClientRect()
      // h5 / 部分环境返回全 0 的矩形，这种要当「取不到」处理，否则行高会算成 0；
      // 高度小得离谱（<24）的矩形同样不可信 —— 按它下发行内尺寸会画出退化箭头
      if (rect && rect.height > 0 && rect.height >= 24 && rect.left > 0) menu = rect
    } catch {
      menu = null
    }

    if (!menu) {
      return {
        statusBarHeight,
        contentHeight: DESIGN_CONTENT_HEIGHT,
        capsuleInset: FALLBACK_CAPSULE_INSET,
        totalHeight: statusBarHeight + DESIGN_CONTENT_HEIGHT,
        capsuleHeight: FALLBACK_CAPSULE_HEIGHT,
        capsuleGap: FALLBACK_CAPSULE_GAP,
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
      capsuleHeight: Math.round(menu.height),
      capsuleGap: gap,
    }
  } catch {
    return {
      statusBarHeight: FALLBACK_STATUS_BAR,
      contentHeight: DESIGN_CONTENT_HEIGHT,
      capsuleInset: FALLBACK_CAPSULE_INSET,
      totalHeight: FALLBACK_STATUS_BAR + DESIGN_CONTENT_HEIGHT,
      capsuleHeight: FALLBACK_CAPSULE_HEIGHT,
      capsuleGap: FALLBACK_CAPSULE_GAP,
    }
  }
}
