import type { CSSProperties, ReactNode } from 'react'

export type Tone = 'violet' | 'sky' | 'mint' | 'rose' | 'sand' | 'lilac' | 'blue' | 'warn'

/**
 * 图片位。**不是 shadcn/ui 组件**：它等价于商品图本身（无真实图片时的内容占位），
 * 不是可交互的 UI 原语，shadcn/ui 里没有对应物，因此保留为 FISH 自己的组件。
 *
 * 参考截图里没有真实图片，一律用柔和渐变 + emoji 还原。
 * 这里是**内容占位色**（等价于商品图本身），不是 UI 语义色，
 * 所以直接用字面 hex，不并入 `styles.css` 的 design tokens。
 */
export const TONE_CLASS: Record<Tone, string> = {
  violet: 'bg-gradient-to-br from-[#e9e7fa] to-[#d9d5f2]',
  sky: 'bg-gradient-to-br from-[#ddebf1] to-[#cde2ec]',
  mint: 'bg-gradient-to-br from-[#dcf1e0] to-[#cdebd7]',
  rose: 'bg-gradient-to-br from-[#f8dee9] to-[#f2cbdd]',
  sand: 'bg-gradient-to-br from-[#f2ecd9] to-[#e9dfc6]',
  lilac: 'bg-gradient-to-br from-[#e6def8] to-[#d8cdf2]',
  blue: 'bg-gradient-to-br from-[#d9e2f3] to-[#c7d5ee]',
  warn: 'bg-gradient-to-br from-[#fdf0d5] to-[#f6e2b6]',
}

type ThumbProps = {
  /** 省略时只留渐变底色（首页瀑布流要纯色块）。 */
  emoji?: string
  tone?: Tone
  /** Tailwind 尺寸/圆角类，例如 `size-24 rounded-2xl`。 */
  className?: string
  /** emoji 字号，默认跟随容器（`text-[2.4rem]`）。 */
  emojiClassName?: string
  /** 需要按数据决定尺寸时用的内联样式，例如瀑布流每张图的不同高度。 */
  style?: CSSProperties
  children?: ReactNode
}

export function Thumb({
  emoji,
  tone = 'violet',
  className = 'size-24 rounded-2xl',
  emojiClassName = 'text-[2.4rem]',
  style,
  children,
}: ThumbProps) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center ${TONE_CLASS[tone]} ${className}`}
      style={style}
    >
      {emoji ? <span className={`leading-none ${emojiClassName}`}>{emoji}</span> : null}
      {children}
    </div>
  )
}
