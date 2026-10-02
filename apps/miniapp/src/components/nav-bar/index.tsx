/**
 * 自绘导航栏。
 *
 * `app.config.ts` 里 `navigationStyle: 'custom'`，所有页面都用自绘导航 —— 设计稿的
 * 返回/分享按钮本身就是漂浮在内容之上的半透明圆形玻璃钮，原生栏放不下这个形态。
 *
 * 高度用 `Taro.getWindowInfo().statusBarHeight` 顶出状态栏，避免刘海遮挡。
 */
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { backButtonGeometry, readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

type NavBarProps = {
  /** 是否显示返回钮（非 Tab 页默认 true） */
  back?: boolean
  /**
   * 页面标题（二级页用；不给就保持原样：只有返回钮）。
   *
   * 字符串渲染进 `Text`（与旧版完全一致，面交页等既有调用方逐像素不变）；
   * 其它节点渲染进 `View` —— 他人主页的居中标题是「昵称 + 认证徽章」，
   * 徽章是图标 + 文字，weapp 的 `text` 不能可靠容纳 `image` / `view` 子节点。
   */
  title?: ReactNode
  /**
   * 标题位置：
   * - `start`（默认）紧贴返回钮右侧（稿 `.navbar.has-back .navtitle{left:56px}`）；
   * - `center` 屏幕水平居中（稿 `.mp-title{left:50%;translate(-50%,-50%)}`）。
   */
  titleAlign?: 'start' | 'center'
  /**
   * 吸顶玻璃底：`position: fixed` + 整条磨砂底。
   *
   * 默认（不传）保持原来的**透明漂浮**形态 —— 只有返回钮/动作钮是实体、其余区域可穿透，
   * 压在页头渐变上；另有 10 个页面在用这个形态，不能改。
   *
   * 长页面（面交页、他人主页）的内容会从透明返回钮底下滚过去，这个变体把返回钮与
   * 标题**钉住**，并给一条玻璃底，让滚过去的内容从底下透出来
   * （数值与 `components/top-bar` 的 `.topbar--glass` 同一套材质）。
   */
  glass?: boolean
  /**
   * 返回钮常驻吸顶：`position: fixed` 钉在屏顶，底色仍透明（玻璃与否仍由 `glass` 决定）。
   *
   * 基类是 `position: absolute` —— 返回钮会跟着内容滚走。设置 / 匹配 / 想要的人 /
   * 许个愿这批页要的是「返回键先钉住，滚动后玻璃底和标题才浮现」：
   * `fixed` + `glass={滚动驱动}` + `title={滚动驱动}` 三件套（user 页 glassOn 的同款思路，
   * 区别只是未滚动时钮也钉住而不是滚走）。
   */
  fixed?: boolean
  /** 返回钮右侧的自定义动作区 */
  actions?: ReactNode
  /**
   * 覆盖返回行为。默认：有上一页 `navigateBack`；页面栈为空（冷启动分享 / 扫码直入）
   * 兜底回**语义父级 tab** —— 本组件默认首页，语义父级不是首页的页面用它覆盖
   * （如登录页回「我的」）。
   */
  onBack?: () => void
  /**
   * 栏下沿的阅读进度（0–1，稿 `.progress`）：**不传就不渲染**，既有调用方逐像素不变。
   *
   * 长文档页（用户协议 / 隐私政策）用 —— 稿的取舍是「长文档最缺的是还剩多少，
   * 比页码便宜且不占高度」。进度条画在栏的底边上，所以由本组件承担而不是页面自绘：
   * 页面对这条栏的真实高度（状态栏 + 内边距 + 钮高，且内联 px 与 rpx 混算）没有可靠口径，
   * 自绘必然在部分机型上错位。
   */
  progress?: number
}

export default function NavBar({
  back = true,
  title,
  titleAlign = 'start',
  glass = false,
  fixed = false,
  actions,
  onBack,
  progress,
}: NavBarProps) {
  // 栏位几何统一走 readNavMetrics：返回钮与右侧微信原生胶囊**等高、同一行居中**
  // （2026-10-02 拍板），行顶 = 状态栏 + 胶囊上留白，不再写死 padding。
  const metrics = useMemo(() => readNavMetrics(), [])
  const backGeo = backButtonGeometry(metrics.capsuleHeight)

  const handleBack = () => {
    if (onBack) {
      onBack()
      return
    }
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack()
    } else {
      // 兜底回**语义父级 tab**（2026-10-02 拍板）：页面栈为空只发生在冷启动经
      // 分享卡片 / 扫码直入二级页，此时回本组件的语义父级 —— 首页。语义父级
      // 不是首页的页面（会话页 → 消息、编辑资料 → 我的）由页面经 `onBack` 自行覆盖。
      void Taro.switchTab({ url: '/pages/home/index' })
    }
  }

  /**
   * 居中标题的垂直位置：`.navfloat` 的 `padding-top` 是行内 px（状态栏 + 胶囊上留白），
   * 绝对定位的**参照是 padding box（含状态栏）**，所以标题框 top 也要用同一原点
   * （状态栏 + 胶囊上留白）、框高用胶囊高 —— 与返回钮**同一行、同高、同轴**，
   * 而返回钮已与原生胶囊等高对齐。
   *
   * 这三个值都是设备 px，必须行内下发（pxtransform 只处理样式表；内联 px 原样下发）。
   * **不要在行内混样式表值**：混算曾让标题整行下移约 16px（见 `src/lib/nav-metrics.ts`）。
   */
  const centerTitleStyle =
    titleAlign === 'center'
      ? {
          top: `${metrics.statusBarHeight + metrics.capsuleGap}px`,
          height: `${metrics.capsuleHeight}px`,
        }
      : undefined

  const titleClass = `navfloat__title${titleAlign === 'center' ? ' navfloat__title--center' : ''}`

  /**
   * 进度条宽度用**百分比**行内下发：百分比不是长度单位，pxtransform 不参与，也不会被
   * 当成设备 px 误算（这正是本文件里唯一安全的行内写法）。夹到 [0,1] 是防页面算出
   * 负数或 >1（弱网下测量值可能滞后一帧）。
   */
  const progressWidth =
    typeof progress === 'number'
      ? `${Math.round(Math.min(1, Math.max(0, progress)) * 10000) / 100}%`
      : null

  return (
    <View
      className={`navfloat${fixed ? ' navfloat--fixed' : ''}${glass ? ' navfloat--glass' : ''}`}
      style={{ paddingTop: `${metrics.statusBarHeight + metrics.capsuleGap}px` }}
    >
      {back ? (
        <View className="navfloat__btn" style={backGeo.btnStyle} onClick={handleBack}>
          <View className="navfloat__chevron" style={backGeo.chevronStyle} />
        </View>
      ) : (
        <View className="navfloat__spacer" style={backGeo.btnStyle} />
      )}
      {title ? (
        typeof title === 'string' ? (
          <Text className={titleClass} style={centerTitleStyle}>
            {title}
          </Text>
        ) : (
          <View className={titleClass} style={centerTitleStyle}>
            {title}
          </View>
        )
      ) : null}
      {actions ? <View className="navfloat__actions">{actions}</View> : null}
      {progressWidth === null ? null : (
        <View className="navfloat__progress">
          <View className="navfloat__progress-bar" style={{ width: progressWidth }} />
        </View>
      )}
    </View>
  )
}
