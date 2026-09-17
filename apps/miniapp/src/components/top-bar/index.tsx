/**
 * 固定顶部栏（一级页面专用）。
 *
 * **为什么不复用 `@/components/nav-bar`**：那个组件是二级页面用的**漂浮导航**
 * （`position: absolute` + 圆形玻璃返回钮，浮在内容之上），被 12 个页面引用
 * （conversation / match / mylist / notifications / orders / sell / settings /
 * transaction-meetup / user / verify / watchers / listing-detail）。
 * 一级页面要的是另一种东西：**固定（`fixed`）+ 一级标题**，内容从它下方滚过。
 * 两种职责混进一个组件，任何一边的改动都会牵动另一边 —— 所以这里独立成组件，
 * `nav-bar` 保持原样、零改动。
 *
 * 与微信胶囊的对齐方式见 `@/lib/nav-metrics`：不画假胶囊，只按运行时读到的
 * 胶囊位置反推行高与右侧避让，保证标题与原生胶囊同行居中。
 *
 * `variant`：
 * - `plain`：透明底，靠页面自己的页头渐变（首页 / 许愿 / 消息）；
 * - `glass`：磨砂底 + 底部描边（搜索页，滚动时内容要从底下过）。
 */
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { type ReactNode, useMemo } from 'react'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

type TopBarVariant = 'plain' | 'glass'

type TopBarProps = {
  /** 一级标题（与 `titleEm` 拼成「许愿 + 墙」这种一段品牌色的写法） */
  title?: string
  /** 标题里走品牌色的尾段 */
  titleEm?: string
  /** 是否显示返回钮 */
  back?: boolean
  /** 覆盖返回行为（默认 navigateBack，无上一页时回首页） */
  onBack?: () => void
  /** 左槽：给了就整体替代「返回钮 + 标题」（首页的品牌 logo 走这里） */
  left?: ReactNode
  /** 中槽：撑满剩余宽度（首页搜索胶囊、搜索页输入框） */
  center?: ReactNode
  /** 右槽：动作区，排在胶囊避让区的左侧 */
  actions?: ReactNode
  variant?: TopBarVariant
  /**
   * 是否在栏下方留出等高占位块。
   *
   * **默认 false**：页面顶栏是 `fixed`、脱离文档流，不留占位的话内容会钻到它下面。
   * 但也不是所有页面都要 —— 首页的页头渐变本来就该从屏幕顶铺下来，内容顶格更对。
   * 所以由调用方按版式决定，而不是组件替它猜。
   */
  spacer?: boolean
}

export default function TopBar({
  title,
  titleEm,
  back = false,
  onBack,
  left,
  center,
  actions,
  variant = 'plain',
  spacer = false,
}: TopBarProps) {
  const metrics = useMemo(() => readNavMetrics(), [])

  const handleBack = () => {
    if (onBack) {
      onBack()
      return
    }
    const pages = Taro.getCurrentPages()
    if (pages.length > 1) {
      void Taro.navigateBack()
    } else {
      void Taro.switchTab({ url: '/pages/home/index' })
    }
  }

  return (
    <>
      <View className={`topbar topbar--${variant}`}>
        <View
          className="topbar__row"
          style={{
            paddingTop: `${metrics.statusBarHeight}px`,
            height: `${metrics.totalHeight}px`,
            // 胶囊是原生绘制、点不到也盖不住，只能把内容让出去
            paddingRight: `${metrics.capsuleInset}px`,
          }}
        >
          {left ?? (
            <>
              {back ? (
                <View className="topbar__back" onClick={handleBack}>
                  <View className="topbar__chevron" />
                </View>
              ) : null}
              {title ? (
                <Text className="topbar__title">
                  {title}
                  {titleEm ? <Text className="topbar__em">{titleEm}</Text> : null}
                </Text>
              ) : null}
            </>
          )}
          {center ? <View className="topbar__center">{center}</View> : null}
          {actions ? <View className="topbar__actions">{actions}</View> : null}
        </View>
      </View>
      {/*
        占位块与栏本身是**兄弟**：栏是 `fixed` 脱离文档流，占位块留在流里顶出等高留白。
        绝不能把占位块放进栏内部 —— 那会继承 `position: fixed`，页面顶部凭空多一条浮层。
      */}
      {spacer ? (
        <View className="topbar__spacer" style={{ height: `${metrics.totalHeight}px` }} />
      ) : null}
    </>
  )
}
