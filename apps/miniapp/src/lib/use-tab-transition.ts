import Taro, { useDidHide, useDidShow, useReady, useUnload } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { notifyTabbarRoute, resetTabTransition } from './tabbar-sync'

/**
 * 预热**下一个**页面的 WebView（#662）。
 *
 * Tab 页首次被 `switchTab` 创建时，WebView 初始化会先露出一帧纯白原生底（本机
 * devtools 实测约 100–250ms），页面 JS 挂载后才画内容；这就是「切 Tab 白屏闪烁」。
 * 四个 Tab 页的 `index.config.ts` 都设了 `handleWebviewPreload: 'manual'`，由本 hook
 * 在页面显示后**延迟 200ms** 显式预热下一个页面：让开当前页首屏渲染与取数，也不会和
 * 框架默认的 onReady+200ms 自动预加载重复建 WebView。
 *
 * 每次 onShow / onReady 都会重新排一次：预热出来的 WebView 可能被中途的
 * `navigateTo`（如首页进商品详情再返回）消费，只在首次 ready 预热一次的话，之后再
 * 首访未打开过的 Tab 仍会白屏。
 *
 * H5 没有该 API；低版本基础库不支持时打一条告警后跳过，不影响切页。
 */
const PRELOAD_DELAY_MS = 200
let warnedNoPreload = false

function preloadNextWebview(): void {
  const preload = Taro.preloadWebview
  if (typeof preload !== 'function') {
    if (!warnedNoPreload) {
      warnedNoPreload = true
      console.warn('[miniapp] 当前基础库不支持 preloadWebview，Tab 首切可能闪白')
    }
    return
  }
  try {
    const task = preload({})
    if (task && typeof task.catch === 'function') task.catch(() => undefined)
  } catch {
    // 调用失败不阻断页面显示；manual 配置下这一次没有预热，下次显示会再排一次。
  }
}

/** 只重播内容的轻微不透明度变化，不重挂载页面/列表，不改取数或滚动。 */
export function useTabTransition(): string {
  const alternate = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const preloadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [className, setClassName] = useState('')
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      clearTimeout(preloadTimer.current)
    },
    [],
  )
  /** 让开当前页首屏渲染/取数后再预热下一次切 Tab 的 WebView */
  const schedulePreload = () => {
    clearTimeout(preloadTimer.current)
    preloadTimer.current = setTimeout(() => {
      preloadTimer.current = undefined
      preloadNextWebview()
    }, PRELOAD_DELAY_MS)
  }
  useReady(schedulePreload)
  useDidHide(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    clearTimeout(preloadTimer.current)
    preloadTimer.current = undefined
    setClassName('')
  })
  useDidShow(() => {
    schedulePreload()
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
