/**
 * 设计令牌的运行时读取与派生。
 *
 * 配色只在 `styles.css` 的 `@theme` 里定义一处；这里从 CSS 变量读取后再派生，
 * 不在 TS 里抄第二份色值——改令牌时不会漏改。
 */

/** 与白色混合的比例：`0.4` = 结果中白色占 40%。 */
const WHITE_MIX_RATIO = 0.4

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const WHITE_CHANNEL = 255

function parseHex(hex: string): [number, number, number] | null {
  if (!HEX_COLOR.test(hex)) return null
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** 单个通道与白色线性混合。 */
function mixChannel(channel: number, ratio: number): number {
  return channel + (WHITE_CHANNEL - channel) * ratio
}

/** 按比例与白色线性混合。非 `#rrggbb` 输入原样返回。 */
export function mixWhite(hex: string, ratio = WHITE_MIX_RATIO): string {
  const rgb = parseHex(hex)
  if (rgb === null) return hex

  const [r, g, b] = rgb
  return toHex([mixChannel(r, ratio), mixChannel(g, ratio), mixChannel(b, ratio)])
}

/**
 * 读取 `styles.css` 的 CSS 变量。拿不到（SSR、变量不存在）或写法不是 hex 时用 `fallback`——
 * 令牌将来换成 `oklch()` 也不会静默出错，只是退回默认色。
 */
export function readTokenColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback

  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim()
  return HEX_COLOR.test(value) ? value : fallback
}

/** 令牌色 + 40% 白。背景类元素用它，保证深色正文与磨砂玻璃卡片上的对比度。 */
export function tokenWhiteMix(variable: string, fallback: string): string {
  return mixWhite(readTokenColor(variable, fallback))
}
