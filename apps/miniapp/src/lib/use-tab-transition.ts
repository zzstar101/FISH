import { useDidShow, useUnload } from '@tarojs/taro'
import { useRef, useState } from 'react'
import { notifyTabbarRoute, resetTabTransition } from './tabbar-sync'

/** 只重播内容的轻微不透明度变化，不重挂载页面/列表，不改取数或滚动。 */
export function useTabTransition(): string {
  const alternate = useRef(false)
  const [className, setClassName] = useState('')
  useDidShow(() => {
    const motion = notifyTabbarRoute()
    if (!motion) {
      setClassName('')
      return
    }
    alternate.current = !alternate.current
    setClassName(`tab-content-enter-${alternate.current ? 'a' : 'b'}`)
  })
  // 普通 switchTab 不卸载 Tab 页；reLaunch/销毁则不能留下旧页面栈的意图。
  useUnload(resetTabTransition)
  return className
}
