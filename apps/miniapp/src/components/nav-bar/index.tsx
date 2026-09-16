/**
 * 自绘导航栏。
 *
 * `app.config.ts` 里 `navigationStyle: 'custom'`，所有页面都用自绘导航 —— 设计稿的
 * 返回/分享按钮本身就是漂浮在内容之上的半透明圆形玻璃钮，原生栏放不下这个形态。
 *
 * 高度用 `Taro.getWindowInfo().statusBarHeight` 顶出状态栏，避免刘海遮挡。
 */
import { View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import type { ReactNode } from 'react'
import './index.scss'

type NavBarProps = {
  /** 是否显示返回钮（非 Tab 页默认 true） */
  back?: boolean
  /** 返回钮右侧的自定义动作区 */
  actions?: ReactNode
  /** 覆盖返回行为（默认 navigateBack，无上一页时 reLaunch 到首页） */
  onBack?: () => void
}

export default function NavBar({ back = true, actions, onBack }: NavBarProps) {
  const statusBarHeight = (() => {
    try {
      return Taro.getWindowInfo().statusBarHeight ?? 20
    } catch {
      return 20
    }
  })()

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
    <View className="navfloat" style={{ paddingTop: `${statusBarHeight}px` }}>
      {back ? (
        <View className="navfloat__btn" onClick={handleBack}>
          <View className="navfloat__chevron" />
        </View>
      ) : (
        <View className="navfloat__spacer" />
      )}
      {actions ? <View className="navfloat__actions">{actions}</View> : null}
    </View>
  )
}
