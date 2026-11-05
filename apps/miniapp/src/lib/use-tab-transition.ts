import { useDidHide, useDidShow, useUnload } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { notifyTabbarRoute, resetTabTransition } from './tabbar-sync'

/** 只重播内容的轻微不透明度变化，不重挂载页面/列表，不改取数或滚动。 */
export function useTabTransition(): string {
  const alternate = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [className, setClassName] = useState('')
  useEffect(() => () => clearTimeout(timer.current), [])
  useDidHide(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    setClassName('')
  })
  useDidShow(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    const motion = notifyTabbarRoute()
    if (!motion) {
      setClassName('')
      return
    }
    alternate.current = !alternate.current
    setClassName(`tab-content-enter-${alternate.current ? 'a' : 'b'}`)
    // 与 app.scss 的 140ms 窗口一致；鉴权/数据晚到时新挂载的容器不能补播旧动效。
    timer.current = setTimeout(() => {
      timer.current = undefined
      setClassName('')
    }, 140)
  })
  // 普通 switchTab 不卸载 Tab 页；reLaunch/销毁则不能留下旧页面栈的意图。
  useUnload(resetTabTransition)
  return className
}
