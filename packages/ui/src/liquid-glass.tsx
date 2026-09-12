import { type CSSProperties, type Ref, useId } from 'react'
import { cn } from './lib/utils'

/**
 * 液体玻璃（Liquid Glass）三件套：折射材质层 + 磨砂玻璃表面 + 会滑动的选中高光。
 *
 * ## 材质层 LiquidGlassLayer
 *
 * 移植自 D:\index\w25 的 `src/shared/ui/LiquidGlassLayer.tsx`（那个项目是欢迎页导航在用，
 * 里面 Vue 版的注释更详细）。做法是**真折射**而不是纯 CSS 磨砂：
 *
 * ```
 * surface（position: fixed + z-index；背景半透明；内容 z-index:1）
 *   ├─ <LiquidGlassLayer/>        fragment
 *   │   ├─ <svg><filter>…</svg>   feTurbulence 噪声图 + 三次 feDisplacementMap（位移）
 *   │   └─ .lg-warp               absolute inset:0; z-index:-1
 *   │                               backdrop-filter: blur() saturate()
 *   │                               filter: url(#…)  ← 引用兄弟节点的 def
 *   └─ …原有内容…                  不受位移影响
 * ```
 *
 * 三个从 w25 抄来的硬约束，破一个效果就没了：
 *
 * 1. **filter def 必须是 warp 的兄弟节点**，不能嵌在 warp 里面——元素无法引用自己内部的
 *    def，引用会被忽略，折射静默失效。所以这里 `GlassFilter` 和 warp 是并列的两个节点。
 * 2. **表面上不要出现 `isolation: isolate` / `opacity < 1` / `will-change: opacity` / `filter`**：
 *    它们会把表面变成 backdrop root，warp 的 `backdrop-filter` 就只能采样表面内部的东西，
 *    于是折射消失。（这也意味着导航的隐藏动画不能靠 opacity，见 tab-bar.tsx。）
 *    表面自己的层叠上下文靠 `position` + `z-index` 建立就够了。
 * 3. **`backdrop-filter` 是主效果**：SVG 位移只是在磨砂之上补一层边缘扭曲 + 色散。
 *    即使 `filter: url()` 没解析（旧浏览器 / 非 Chromium），也只会退化成普通磨砂，不会坏。
 */

export type LiquidGlassLayerProps = {
  /** 折射强度。 */
  displacementScale?: number
  /** 额外磨砂量，最终 blur = (overLight ? 12 : 4) + blurAmount * 32。 */
  blurAmount?: number
  /** 背景饱和度，让透过来的颜色更"活"。 */
  saturation?: number
  /** 色散强度：三个通道用略微不同的位移量，再 screen 叠回去。 */
  aberrationIntensity?: number
  /** 浅色背景（FISH 是浅色，默认开）。 */
  overLight?: boolean
  /** 材质层层级，负值保证它待在内容后面；表面自身仍需是层叠上下文。 */
  zIndex?: number
}

function GlassFilter({
  id,
  displacementScale,
  aberrationIntensity,
}: {
  id: string
  displacementScale: number
  aberrationIntensity: number
}) {
  const scale = -Math.max(1, displacementScale)
  // 色散越大，末端的高斯模糊越小，避免糊成一团。
  const stdDev = Math.max(0.1, 0.5 - aberrationIntensity * 0.1)

  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 size-full">
      <defs>
        <filter
          id={id}
          x="-35%"
          y="-35%"
          width="170%"
          height="170%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008 0.008"
            numOctaves={3}
            seed={2}
            result="DISPLACEMENT_MAP"
          />
          {/* 红通道：满量位移 */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            scale={scale}
            xChannelSelector="R"
            yChannelSelector="B"
            result="RED_DISPLACED"
          />
          <feColorMatrix
            in="RED_DISPLACED"
            type="matrix"
            values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="RED_CHANNEL"
          />
          {/* 绿、蓝通道：位移量略微递减 → 边缘散出彩边 */}
          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            scale={scale - aberrationIntensity * 0.05}
            xChannelSelector="R"
            yChannelSelector="B"
            result="GREEN_DISPLACED"
          />
          <feColorMatrix
            in="GREEN_DISPLACED"
            type="matrix"
            values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            result="GREEN_CHANNEL"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="DISPLACEMENT_MAP"
            scale={scale - aberrationIntensity * 0.1}
            xChannelSelector="R"
            yChannelSelector="B"
            result="BLUE_DISPLACED"
          />
          <feColorMatrix
            in="BLUE_DISPLACED"
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            result="BLUE_CHANNEL"
          />
          <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
          <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />
          <feGaussianBlur in="RGB_COMBINED" stdDeviation={stdDev} result="ABERRATED_BLURRED" />
        </filter>
      </defs>
    </svg>
  )
}

/**
 * 默认参数是从 w25 那套调下来的（w25 是 `blurAmount=0.0625` / `displacementScale=22`，
 * 对应模糊 14px）。FISH 的背景不是图片而是一屏文字，14px 模糊挡不住位移，会把上一条
 * 卡片的文字"拖"进胶囊边缘，放大看像鬼影。实测把磨砂加到 24px、位移收到 18：
 * 文字不再成形，但边缘还能吃到背后内容的颜色（那才是"玻璃"的观感来源）。
 */
export function LiquidGlassLayer({
  displacementScale = 18,
  blurAmount = 0.375,
  saturation = 180,
  aberrationIntensity = 2,
  overLight = true,
  zIndex = -1,
}: LiquidGlassLayerProps) {
  // useId 里带冒号等字符，直接拼进 url(#…) 会解析失败，先洗一遍。
  const filterId = `fish-lg-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const blurPx = (overLight ? 12 : 4) + blurAmount * 32

  const warpStyle: CSSProperties = {
    zIndex,
    backdropFilter: `blur(${blurPx}px) saturate(${saturation}%)`,
    WebkitBackdropFilter: `blur(${blurPx}px) saturate(${saturation}%)`,
    filter: `url(#${filterId})`,
  }

  return (
    <>
      <GlassFilter
        aberrationIntensity={aberrationIntensity}
        displacementScale={displacementScale}
        id={filterId}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
        style={warpStyle}
      />
    </>
  )
}

/**
 * 磨砂玻璃表面：半透明的底 + 上下缘的偏移内阴影。
 *
 * 注意这里**没有** `isolate`（也不该加）：它是 backdrop root 的成因，会让
 * `LiquidGlassLayer` 的折射直接失效。层叠上下文由 `relative z-0` 建立，
 * 这样 warp 的 `z-index:-1` 才会乖乖待在表面内部、内容后面。
 */
const GLASS_SURFACE =
  'relative z-0 rounded-full border border-white/40 bg-white/25 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.24),inset_1.5px_2px_0_-1.5px_rgba(255,255,255,0.7),inset_-1.5px_-1.5px_0_-1.5px_rgba(255,255,255,0.5),0_8px_28px_rgba(17,17,26,0.14)]'

export type GlassSurfaceProps = React.ComponentProps<'div'>

export function GlassSurface({ className, children, ...props }: GlassSurfaceProps) {
  return (
    <div className={cn(GLASS_SURFACE, className)} {...props}>
      <LiquidGlassLayer />
      {children}
    </div>
  )
}

export type LiquidGlassHighlightProps = {
  /** 高亮项的下标（0 起），超出范围时调用方不要渲染。 */
  index: number
  /** 槽位总数，用来算单个槽的宽度。 */
  count: number
  className?: string
  /** 调用方把指针位置写成 `--mx` / `--my`（相对本元素的百分比）来驱动径向高光。 */
  ref?: Ref<HTMLSpanElement>
}

/**
 * 选中高光：跟着当前项滑动的玻璃片。
 *
 * 高光配方与 w25 的 `.welcome-route-nav__glow` 一致，核心是两条：
 *
 * 1. **偏移 + 负 spread 的内阴影**做边缘高光，而不是画一整圈均匀描边：
 *    `inset 1.8px 3px 0 -2px` 让白光往左下收成一道弧，`inset -2px -2px 0 -2px` 在反侧补一条，
 *    这样光有明确方向、还自动跟着圆角走（描边版看起来就是"贴纸"）。
 * 2. **跟指针的径向高光**：`--mx` / `--my` 由调用方按指针在自身盒子里的百分比写入。
 *    没有指针（触屏 / 指针不在导航上）时默认落在**左上方**而不是正中——正中会把品牌色洗白，
 *    左上等于给这块玻璃一个固定的光源方向，观感更稳。
 *
 * 与 w25 的差异是填充：w25 的导航浮在深色/彩色背景上，纯白玻璃很好看；FISH 浮在
 * 浅灰白页面上，纯白会和胶囊糊成一片，所以填一层品牌紫 → 品牌蓝微调的玻璃拉开层次。
 */
export function LiquidGlassHighlight({ index, count, className, ref }: LiquidGlassHighlightProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute top-0 bottom-0 left-0 transition-transform duration-[620ms] ease-[cubic-bezier(0.23,1,0.32,1.05)] motion-reduce:transition-none',
        className,
      )}
      ref={ref}
      style={{ transform: `translateX(${index * 100}%)`, width: `${100 / count}%` }}
    >
      <span
        className="absolute inset-x-1.5 inset-y-[9px] overflow-hidden rounded-full border border-white/50"
        style={{
          background: [
            // 跟指针的镜面光斑（无指针时停在左上，当固定光源）
            'radial-gradient(110px circle at var(--mx,32%) var(--my,4%), rgba(255,255,255,0.5), transparent 60%)',
            // 玻璃本体：品牌紫 → 品牌蓝微调 → 品牌紫
            'linear-gradient(180deg, rgba(230,236,247,0.92) 0%, rgba(81,119,186,0.16) 58%, rgba(230,236,247,0.8) 100%)',
          ].join(', '),
          backdropFilter: 'blur(4px) saturate(160%)',
          WebkitBackdropFilter: 'blur(4px) saturate(160%)',
          boxShadow: [
            // 左上打过来的主光 + 右下反光，负 spread 收成贴边的弧
            'inset 1.8px 3px 0 -2px rgba(255,255,255,0.85)',
            'inset -2px -2px 0 -2px rgba(255,255,255,0.6)',
            // 再补一对更长的对角弧光，凑出玻璃厚度
            'inset 3px 9px 1px -6px rgba(255,255,255,0.35)',
            'inset -3px -9px 1px -6px rgba(255,255,255,0.5)',
            // 底缘压暗 + 一条极弱的贴边亮线
            'inset 0 -1px 6px rgba(16,17,20,0.14)',
            'inset 0 0 0 1px rgba(255,255,255,0.2)',
            // 贴地 + 抬升
            '0 8px 22px rgba(0,10,40,0.16)',
          ].join(', '),
        }}
      />
    </span>
  )
}
