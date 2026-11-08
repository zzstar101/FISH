import Taro, { useDidHide, useDidShow, useUnload } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { notifyTabbarRoute, resetTabTransition } from './tabbar-sync'

/**
 * 预热**下一个**页面的 WebView（#662）。
 *
 * Tab 页首次被 `switchTab` 创建时，WebView 初始化会先露出一帧纯白原生底（本机
 * devtools 实测约 100–250ms），页面 JS 挂载后才画内容；这就是「切 Tab 白屏闪烁」。
 *
 * 分工：
 * - **安卓**保留框架默认预加载（Tab 页配置不设 `handleWebviewPreload`），不重复建
 *   WebView；本 hook 在安卓直接跳过。
 * - **iOS / devtools 等**框架不自动预加载的平台，在页面显示后延迟 200ms 显式调用
 *   `Taro.preloadWebview()`：让开当前页首屏渲染与取数，再为下一次切 Tab 预热。
 * - 每次 onShow 重排一次，返回本页会补预热（预加载 WebView 可能被中途 `navigateTo`
 *   消费）；页面隐藏时若预热还没跑，立即补一次，尽量赶在目标页创建前。
 *
 * H5 没有该 API；低版本基础库不支持时打一条告警后跳过，不影响切页。
 */
export const PRELOAD_DELAY_MS = 200
let warnedNoPreload = false
let warnedPreloadFailure = false

function warnOnce(kind: 'missing' | 'failed'): void {
  if (kind === 'missing' && !warnedNoPreload) {
    warnedNoPreload = true
    console.warn('[miniapp] 当前基础库不支持 preloadWebview，Tab 首切可能闪白')
  }
  if (kind === 'failed' && !warnedPreloadFailure) {
    warnedPreloadFailure = true
    console.warn('[miniapp] preloadWebview 调用失败，Tab 首切可能闪白')
  }
}

/** 安卓由框架默认预加载；其他平台由本 hook 显式预热 */
function isAndroid(): boolean {
  try {
    return Taro.getSystemInfoSync().platform === 'android'
  } catch {
    return false
  }
}

function preloadNextWebview(): void {
  const preload = Taro.preloadWebview
  if (typeof preload !== 'function') {
    warnOnce('missing')
    return
  }
  try {
    const task = preload({})
    if (task && typeof task.catch === 'function') task.catch(() => warnOnce('failed'))
  } catch {
    warnOnce('failed')
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
    if (isAndroid()) return
    clearTimeout(preloadTimer.current)
    preloadTimer.current = setTimeout(() => {
      preloadTimer.current = undefined
      preloadNextWebview()
    }, PRELOAD_DELAY_MS)
  }
  useDidHide(() => {
    clearTimeout(timer.current)
    timer.current = undefined
    if (preloadTimer.current !== undefined) {
      // 切页已在途、等不到 200ms 了：立刻补一次，尽量赶在目标页创建前预热。
      clearTimeout(preloadTimer.current)
      preloadTimer.current = undefined
      preloadNextWebview()
    }
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
