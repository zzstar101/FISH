import { expect, test } from 'bun:test'

/**
 * `--color-ink-3` 是当**正文**用的弱化文字令牌（卡片 meta、时间戳、计数、表单 placeholder），
 * 必须满足 WCAG AA 正文的 4.5:1。这里直接读真实样式表算对比度：只断言十六进制字面量的话，
 * 把令牌改浅、或把页面底色压暗到破线，测试都不会红。
 */
const styles = await Bun.file(new URL('./styles.css', import.meta.url)).text()

function token(name: string): string {
  // 行首锚定，避免匹配到 `var(--color-ink-3)` 这类引用。
  const value = new RegExp(`^\\s*${name}:\\s*(#[0-9a-fA-F]{6});`, 'm').exec(styles)?.[1]
  if (value === undefined) throw new Error(`styles.css 里找不到令牌 ${name}`)
  return value
}

function channel(digits: string, offset: number): number {
  const value = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(hex: string): number {
  const digits = hex.slice(1)
  return 0.2126 * channel(digits, 0) + 0.7152 * channel(digits, 2) + 0.0722 * channel(digits, 4)
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05)
}

/** 弱化文字实际落在的四处浅色背衬；最坏的是 brand-soft（AI 润色候选面板里的说明文字）。 */
const backdrops = [
  '--color-surface',
  '--color-bg',
  '--color-surface-2',
  '--color-brand-soft',
] as const

test('--color-ink-3 在四处浅色背衬上都满足 WCAG AA 正文 4.5:1', () => {
  const ink3 = token('--color-ink-3')
  for (const name of backdrops) {
    expect(contrast(ink3, token(name))).toBeGreaterThanOrEqual(4.5)
  }
})

test('ink / ink-2 / ink-3 三级层级在页面底色上仍严格递减', () => {
  const bg = token('--color-bg')
  const [ink, ink2, ink3] = ['--color-ink', '--color-ink-2', '--color-ink-3'].map((name) =>
    contrast(token(name), bg),
  )
  // 对比度越低 = 视觉越弱；三级必须严格递减，不能并档。
  expect(ink).toBeGreaterThan(ink2 ?? 0)
  expect(ink2).toBeGreaterThan(ink3 ?? 0)
})

test('shadcn 桥接的 --muted-foreground 仍指向 --color-ink-3', () => {
  expect(styles).toContain('--muted-foreground: var(--color-ink-3)')
})
