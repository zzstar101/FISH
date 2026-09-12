import { Badge } from '@fish/ui/badge'
import { GlassSurface, LiquidGlassHighlight } from '@fish/ui/liquid-glass'
import { Link, useLocation } from '@tanstack/react-router'
import { type PointerEvent as ReactPointerEvent, useRef } from 'react'
import { useNotificationBadge } from '../chat/queries'
import { TAB_ROUTES, TABS } from './tabs'
import { useOverlayOpen } from './use-overlay-open'

/**
 * 悬浮胶囊底部导航。
 *
 * - 胶囊体是 `GlassSurface`：真·液体玻璃——`LiquidGlassLayer` 用 SVG 位移 + 色散做折射，
 *   `backdrop-filter` 做磨砂（配方来自 D:\index\w25 的欢迎页导航）。四边留白悬浮；
 * - 中间的「出物」是实心球，垂直居中收在胶囊内部（52px，上下各留 5px），不向胶囊外凸出；
 * - 选中指示是 `LiquidGlassHighlight`，按当前一级页在 5 个槽位间滑动，并且高光光斑跟着指针走；
 * - 显示范围由 `TAB_ROUTES` 决定：只有登记过的一级页才出现，其余子页面整条不渲染；
 * - 底部弹层打开时整条导航下沉移出屏幕（`useOverlayOpen`）。
 */
export function TabBar() {
  const { pathname } = useLocation()
  const badge = useNotificationBadge()
  const overlayOpen = useOverlayOpen()
  const highlightRef = useRef<HTMLSpanElement>(null)

  /*
   * 高光里的径向光斑用 `--mx` / `--my` 定位，坐标要相对**高光自己的盒子**算，
   * 所以直接读它的 rect；写 DOM 变量而不是 setState，避免每次 pointermove 都重渲染。
   */
  const trackPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = highlightRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const clamp = (value: number) => `${Math.min(100, Math.max(0, value))}%`
    el.style.setProperty('--mx', clamp(((event.clientX - rect.left) / rect.width) * 100))
    el.style.setProperty('--my', clamp(((event.clientY - rect.top) / rect.height) * 100))
  }

  const resetPointer = () => {
    const el = highlightRef.current
    if (!el) return
    el.style.setProperty('--mx', '50%')
    el.style.setProperty('--my', '50%')
  }

  const active = TAB_ROUTES[pathname]
  // 没登记的路由（详情 / 聊天 / 发布…）不显示底部导航。
  if (!active) return null

  const activeIndex = TABS.findIndex((tab) => tab.key === active)
  const centerIndex = TABS.findIndex((tab) => tab.center)
  // 中间是凸出的实心球，它自己就是高亮，不再叠滑块。
  const highlightIndex = activeIndex === centerIndex ? -1 : activeIndex

  return (
    <nav
      aria-label="主导航"
      /*
       * 收起动画**只能用位移、不能用 opacity**：opacity < 1 会让导航变成 backdrop root，
       * `LiquidGlassLayer` 的 `backdrop-filter` 就只能采样胶囊内部的东西，折射会在淡出
       * 过程中直接崩掉（w25 的 CSS 里也专门写了这一条）。移出屏幕同样能藏干净。
       */
      className={`fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[430px] px-3 pb-floating-nav transition-transform duration-300 ease-out ${
        overlayOpen ? 'pointer-events-none translate-y-[150%]' : 'translate-y-0'
      }`}
    >
      <GlassSurface
        className="pointer-events-auto h-[62px]"
        onPointerLeave={resetPointer}
        onPointerMove={trackPointer}
      >
        {highlightIndex >= 0 ? (
          <LiquidGlassHighlight count={TABS.length} index={highlightIndex} ref={highlightRef} />
        ) : null}

        <ul className="relative flex h-full items-stretch">
          {TABS.map(({ key, label, to, Icon, center }, index) => {
            const isActive = index === activeIndex

            return (
              <li
                className={`flex flex-1 justify-center ${center ? 'relative' : 'items-center'}`}
                key={key}
              >
                {/* 球体整体收在胶囊内：52px 居中，上下各留 5px，不再向上凸出 */}
                {center ? (
                  <Link
                    aria-label={label}
                    className="absolute top-1/2 left-1/2 flex size-[52px] -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-full bg-brand text-white shadow-[0_6px_16px_rgba(81,119,186,0.42),inset_0_1px_0_rgba(255,255,255,0.5),inset_0_-8px_16px_rgba(0,0,0,0.22)] ring-[3px] ring-white/60 transition-transform duration-200 active:scale-95"
                    to={to}
                  >
                    {/* 球面高光：让实心球也是「玻璃球」而不是一个纯色圆片 */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-x-3 top-1 h-3 rounded-full bg-white/35 blur-[2px]"
                    />
                    <Icon className="size-[22px]" />
                    <span className="text-[10px] leading-none">{label}</span>
                  </Link>
                ) : (
                  <Link className="flex flex-col items-center gap-1" to={to}>
                    <span className="relative">
                      <Icon className={`size-5 ${isActive ? 'text-brand' : 'text-ink-3'}`} />
                      {key === 'message' && badge.data ? (
                        <Badge
                          className="absolute -top-1 -right-2 h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
                          shape="pill"
                          variant="destructive"
                        >
                          {badge.data}
                        </Badge>
                      ) : null}
                    </span>
                    <span
                      className={`text-[10px] leading-none ${
                        isActive ? 'font-semibold text-brand' : 'text-ink-2'
                      }`}
                    >
                      {label}
                    </span>
                  </Link>
                )}
              </li>
            )
          })}
        </ul>
      </GlassSurface>
    </nav>
  )
}
