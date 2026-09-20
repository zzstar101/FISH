/**
 * 预览运行时：把 Taro 组件与 API 映射到浏览器 DOM，让页面代码可以原样在浏览器里跑。
 *
 * 这不是「模拟器」，只是把 5 个原语映射过去，用来做设计稿比对截图：
 *   View → div      Text → span     Image → img（带 object-fit）
 *   ScrollView → div（overflow: auto）     Input → input
 *   Button → div
 *
 * 已知差异（截图时心里有数）：
 * - 小程序用 rpx 等比缩放，浏览器没有 rpx；预览帧写成 750 CSS 像素宽（= 750rpx），
 *   所以 `Npx`（= Nrpx）在预览里就是 N 个 CSS 像素，与真机等比。
 * - backdrop-filter / 字体回退与真机不完全一致。
 */

import type { CSSProperties, ReactNode } from 'react'
import { createElement, useEffect, useRef, useState } from 'react'

export type StyleLike = CSSProperties | string | undefined

/** 把 Taro 的 style 写法（对象或字符串）转成 React 可用的对象 */
function toStyle(style: StyleLike): CSSProperties | undefined {
  if (!style) return undefined
  if (typeof style === 'string') {
    const out: Record<string, string> = {}
    for (const part of style.split(';')) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      const key = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (!key) continue
      out[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value
    }
    return out as CSSProperties
  }
  return style
}

/**
 * 预览里的尺寸换算。
 *
 * 约定：**预览帧宽固定 750 CSS 像素，等价于小程序的 750rpx**，也就是 CSS 里的
 * 1 个数值 = 1 个 CSS 像素 = 1rpx（Taro designWidth 750 + pxtransform 就是这个语义）。
 *
 * 所以这里只需要把 `rpx` 单位**去掉**（浏览器不认识 rpx），不做任何缩放：
 * 任何额外的缩放都会让宽度被折两次，最后表现为「尺寸属性整片失效」。
 */
function normalizeStyleValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  return value.replace(/(-?[\d.]+)rpx/g, '$1px')
}

function normalizeStyle(style: StyleLike): CSSProperties | undefined {
  const base = toStyle(style)
  if (!base) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(base)) {
    out[key] = normalizeStyleValue(value)
  }
  return out as CSSProperties
}

type BaseProps = {
  children?: ReactNode
  className?: string
  style?: StyleLike
  onClick?: (event: unknown) => void
  id?: string
  [key: string]: unknown
}

/** Taro 的 onXxx 事件名 → React 事件名 */
function mapEvents(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on') && typeof value === 'function') {
      out[key] = value
    } else if (key === 'hoverClass' || key === 'hoverStartTime' || key === 'hoverStayTime') {
    } else {
      out[key] = value
    }
  }
  return out
}

function makeComponent(tag: string, extra?: (props: BaseProps) => Record<string, unknown>) {
  const Component = (props: BaseProps) => {
    const { children, className, style, ...rest } = props
    const mapped = mapEvents(rest as Record<string, unknown>)
    const finalProps: Record<string, unknown> = {
      ...mapped,
      className,
      style: normalizeStyle(style),
      // extra 最后展开，允许它补充/覆盖属性（例如 ScrollView 的 overflow）
      ...(extra ? extra(props) : {}),
    }
    return createElement(tag, finalProps, children as ReactNode)
  }
  Component.displayName = `Taro(${tag})`
  return Component
}

export const View = makeComponent('div')
export const Text = makeComponent('span')
export const Button = makeComponent('div')
export const ScrollView = makeComponent('div', (props) => ({
  'data-scroll-view': '',
  // 小程序 ScrollView 自带滚动容器语义，浏览器里要显式给 overflow，否则横向内容会把整页撑宽
  style: {
    overflowX: 'auto',
    overflowY: 'hidden',
    width: '100%',
    ...normalizeStyle(props.style),
  },
}))
export const Block = ({ children }: { children?: ReactNode }) =>
  createElement('div', { style: { display: 'contents' } }, children)

/**
 * Swiper / SwiperItem：只够预览对照用 —— 横向平移 + 只显示当前页，
 * `onChange` 仍然按小程序的 `{ detail: { current } }` 形状回调。
 *
 * `current` 是受控属性：页面点圆点时 setState → 本组件重渲染 → 位移跟着变。
 * 页面里没有起作用的 `setSlide` 时（预览里 useLoad 只跑一次）滑动手势不会真的翻页，
 * 这是预览壳的已知限制，不影响小程序端。
 */
export const Swiper = (props: BaseProps) => {
  const { children, className, style, current, onChange, onClick, ...rest } = props
  const items = (Array.isArray(children) ? children : [children]).filter(Boolean)
  const index = typeof current === 'number' ? current : 0
  void rest
  // 预览里没有手势翻页，点一下内容区就当「滑到下一条」，好验证圆点高亮与图片联动
  const tap = () => {
    if (typeof onClick === 'function') onClick({} as never)
    if (typeof onChange === 'function' && items.length > 0) {
      ;(onChange as (e: unknown) => void)({ detail: { current: (index + 1) % items.length } })
    }
  }
  return createElement(
    'div',
    {
      className,
      'data-swiper': '',
      onClick: tap,
      style: {
        overflow: 'hidden',
        position: 'relative',
        ...normalizeStyle(style),
      },
    },
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          width: '100%',
          height: '100%',
          transform: `translateX(-${index * 100}%)`,
          transition: 'transform .26s ease',
        },
      },
      items,
    ),
  )
}

export const SwiperItem = (props: BaseProps) => {
  const { children, className, style } = props
  return createElement(
    'div',
    {
      className,
      'data-swiper-item': '',
      style: { flex: '0 0 100%', width: '100%', height: '100%', ...normalizeStyle(style) },
    },
    children,
  )
}

export const Image = (props: BaseProps) => {
  const { src, mode, className, style, children, ...rest } = props
  void children
  const fit = mode === 'aspectFit' ? 'contain' : mode === 'aspectFill' ? 'cover' : 'fill'
  const heightFix = mode === 'heightFix'
  return createElement('img', {
    ...mapEvents(rest as Record<string, unknown>),
    src: typeof src === 'string' ? src : '',
    className,
    style: {
      // heightFix = 定高、按原比例定宽（小程序语义），预览里用 contain + width:auto 等价实现
      objectFit: heightFix ? 'contain' : fit,
      ...(heightFix ? { width: 'auto', height: '100%', maxWidth: 'none', flexShrink: 0 } : {}),
      ...normalizeStyle(style),
    },
  })
}

export const Input = (props: BaseProps) => {
  const { value, placeholder, className, style, onInput, onConfirm, ...rest } = props
  void onConfirm
  return createElement('input', {
    ...mapEvents(rest as Record<string, unknown>),
    value: typeof value === 'string' ? value : '',
    placeholder: typeof placeholder === 'string' ? placeholder : '',
    className,
    style: normalizeStyle(style),
    onChange: (event: { target: { value: string } }) => {
      if (typeof onInput === 'function') onInput({ detail: { value: event.target.value } })
    },
  })
}

/**
 * Textarea：多行输入（会话页输入栏用它）。
 *
 * 小程序专有的 `autoHeight` / `disableDefaultPadding` / `placeholderClass` 在浏览器里
 * 没有对应物（高度与 placeholder 配色由 CSS 管），显式丢掉以免 React 报未知属性；
 * `maxlength`（小程序写法，全小写）映射成 DOM 的 `maxLength`。事件映射与 `Input` 同款。
 */
export const Textarea = (props: BaseProps) => {
  const {
    value,
    placeholder,
    maxlength,
    className,
    style,
    onInput,
    autoHeight,
    disableDefaultPadding,
    placeholderClass,
    ...rest
  } = props
  void autoHeight
  void disableDefaultPadding
  void placeholderClass
  return createElement('textarea', {
    ...mapEvents(rest as Record<string, unknown>),
    value: typeof value === 'string' ? value : '',
    placeholder: typeof placeholder === 'string' ? placeholder : '',
    maxLength: typeof maxlength === 'number' ? maxlength : undefined,
    className,
    style: normalizeStyle(style),
    onChange: (event: { target: { value: string } }) => {
      if (typeof onInput === 'function') onInput({ detail: { value: event.target.value } })
    },
  })
}

/**
 * Camera：预览里没有相机硬件，渲染一个带标记的空容器（透明），
 * 页面取景底自己的占位渐变会透出来；onScanCode / onError 不会触发。
 */
export const Camera = (props: BaseProps) => {
  const { className, style } = props
  return createElement('div', { className, 'data-camera': '', style: normalizeStyle(style) })
}

/* --------------------------------------------------------------- Taro API */

type Router = { path: string; params: Record<string, string> }

function parseHash(): Router {
  const raw = window.location.hash.replace(/^#/, '') || '/pages/home/index'
  const [path, query = ''] = raw.split('?')
  const params: Record<string, string> = {}
  for (const pair of query.split('&')) {
    if (!pair) continue
    const [k, v = ''] = pair.split('=')
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v)
  }
  return { path: path ?? '/pages/home/index', params }
}

const listeners = new Set<() => void>()

function navigate(url: string, kind: 'push' | 'replace') {
  const clean = url.startsWith('/') ? url : `/${url}`
  const next = `#${clean}`
  if (kind === 'replace') window.history.replaceState(null, '', next)
  else {
    history.pushState(null, '', next)
  }
  for (const listener of listeners) listener()
  window.scrollTo(0, 0)
}

export function useRouterState(): Router {
  const [router, setRouter] = useState<Router>(() => parseHash())
  useEffect(() => {
    const sync = () => setRouter(parseHash())
    listeners.add(sync)
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => {
      listeners.delete(sync)
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
  return router
}

export function useRouter(): Router {
  return useRouterState()
}

const noop = () => undefined

const Taro = {
  navigateTo: ({ url }: { url: string }) => {
    navigate(url, 'push')
    return Promise.resolve()
  },
  redirectTo: ({ url }: { url: string }) => {
    navigate(url, 'replace')
    return Promise.resolve()
  },
  switchTab: ({ url }: { url: string }) => {
    navigate(url, 'push')
    return Promise.resolve()
  },
  navigateBack: () => {
    history.back()
    return Promise.resolve()
  },
  reLaunch: ({ url }: { url: string }) => {
    navigate(url, 'replace')
    return Promise.resolve()
  },
  showToast: ({ title }: { title: string }) => {
    window.dispatchEvent(new CustomEvent('preview:toast', { detail: title }))
    return Promise.resolve()
  },
  hideToast: noop,
  stopPullDownRefresh: noop,
  /**
   * 页面滚动到指定位置。`scrollTop` 是**逻辑 px**（不参与 rpx 缩放），原样交给滚动容器。
   *
   * 滚动容器是外层 `.page-frame`（定高 + `overflow-y: auto`），不是窗口：
   * 页面内容都在它里面，窗口那条滚动条动的是整个帧的位置，不是页面内容的位置。
   * 只有帧自己滚不动时（内容比帧矮）才退到窗口。
   *
   * ⚠️ 与 `usePageScroll` **不同源**：那个桩监听的是 `window`，所以滚「帧」时
   * 回调用 `catsPinned` 这类靠滚动位置的分支在预览里不会变（首页吸顶文字条因此看不到）。
   * 真机上两者都是页面级、口径一致，这个偏差只影响预览。桩里缺本方法的话，
   * 用到它的页面（首页切分类回顶、消息页回顶）在预览里会直接抛 `TypeError`。
   */
  pageScrollTo: ({ scrollTop = 0 }: { scrollTop?: number; duration?: number }) => {
    const frame = document.querySelector('.page-frame')
    if (frame && frame.scrollHeight > frame.clientHeight) frame.scrollTo({ top: scrollTop })
    else window.scrollTo(0, scrollTop)
    return Promise.resolve()
  },
  getCurrentPages: () => [{}, {}],
  /**
   * 窗口信息。`windowWidth` 必须**跟着预览视口**走：
   * 顶栏的右侧避让 = `windowWidth − 胶囊左边`，写死 390 的话，
   * 预览视口一旦不是 390（例如按 750 宽取真机比例），算出来的避让就会偏大。
   */
  getWindowInfo: () => {
    const w = window.innerWidth || 390
    const h = window.innerHeight || 844
    return {
      statusBarHeight: 44,
      windowWidth: w,
      windowHeight: h,
      screenHeight: h,
      safeArea: { top: 44, bottom: h - 34, height: h - 78 },
    }
  },
  getSystemInfoSync: () => ({
    statusBarHeight: 44,
    windowWidth: 390,
    windowHeight: 844,
    platform: 'devtools',
  }),
  /**
   * 微信胶囊（右上角）的布局信息。
   *
   * 真机由微信给出；预览里按 iPhone 14 的比例合成一份：
   * 胶囊宽 87 / 高 32 / 距右边 7 —— 关键是 `left` 要**跟着视口宽度算**，
   * 不能写死。写死 278 的话，一旦预览视口不是 390（比如按 750 宽取真实比例），
   * `readNavMetrics()` 推出的右侧避让就会偏大，顶栏的搜索胶囊会被截短。
   *
   * 行高由这些值反推：上留白 (51 − 44) = 7 → 7 × 2 + 32 = 46。
   */
  getMenuButtonBoundingClientRect: () => {
    const width = 87
    const right = 7
    const left = (window.innerWidth || 390) - right - width
    return { top: 51, bottom: 83, left, right: left + width, width, height: 32 }
  },
  setNavigationBarTitle: noop,
  hideTabBar: noop,
  showTabBar: noop,
  /**
   * 节点查询。预览是 H5，用 `document.querySelector` + `getBoundingClientRect` 桩出
   * 小程序那套链式 API —— 只实现页面在用的 `select(...).boundingClientRect().exec()`。
   * 少一个方法，用到它的页面在预览里会直接抛 `TypeError`（不是白屏但整页废掉）。
   */
  createSelectorQuery: () => {
    let selector = ''
    let rect: { top: number; left: number; width: number; height: number } | null = null
    const query = {
      select: (sel: string) => {
        selector = sel
        return query
      },
      boundingClientRect: (cb?: (res: typeof rect) => void) => {
        const el = selector ? document.querySelector(selector) : null
        if (el) {
          const box = el.getBoundingClientRect()
          rect = { top: box.top, left: box.left, width: box.width, height: box.height }
        } else {
          rect = null
        }
        if (cb) cb(rect)
        return query
      },
      exec: (cb?: (res: (typeof rect)[]) => void) => {
        if (cb) cb([rect])
        return query
      },
    }
    return query
  },
  /** 扫码页（#114）用的授权接口：预览没有真机权限体系，返回「已授权」的空结果 */
  getSetting: () => Promise.resolve({ authSetting: {} }),
  openSetting: () => Promise.resolve({ authSetting: {} }),
}

export default Taro

/* --------------------------------------------------------------- Taro hooks */

export function useLoad(callback: () => void) {
  // 用 ref 保存回调：effect 依赖数组因此可以是空的，语义仍是「挂载时跑一次」，
  // 与小程序 useLoad 一致（把 callback 放进依赖会让它每次渲染都重跑）。
  const latest = useRef(callback)
  latest.current = callback
  useEffect(() => {
    latest.current()
  }, [])
}

export function useReady(callback: () => void) {
  useLoad(callback)
}

export function useDidShow(callback: () => void) {
  useLoad(callback)
}

export function usePullDownRefresh(callback: () => void) {
  const ref = useRef(callback)
  ref.current = callback
}

export function useDidHide(callback: () => void) {
  void callback
}

export function useUnload(callback: () => void) {
  void callback
}

export function useShareAppMessage() {
  return noop
}

/**
 * 页面滚动。预览是 H5，页面滚动就是窗口滚动，所以直接监听 `window`；
 * 回调签名与小程序一致（`{ scrollTop }`）。挂载时先主动报一次当前滚动位置，
 * 免得「进来时页面已经滚过一段」的路径漏掉。
 */
export function usePageScroll(callback: (res: { scrollTop: number }) => void) {
  const latest = useRef(callback)
  latest.current = callback
  useEffect(() => {
    const onScroll = () => latest.current({ scrollTop: window.scrollY || 0 })
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
}
