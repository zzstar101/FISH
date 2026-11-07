/**
 * #513：图标契约。真源 = `tools/icons/glyphs/*.svg` × `tools/icons/manifest.ts`，
 * 产物 = `src/assets/lib-icons/*.png` + `src/assets/lib-icons.ts`（生成器写，不手改）。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ICONS } from '@/assets/lib-icons'
import {
  ENTRY,
  entrySource,
  GLYPH_DIR,
  ICON_PX,
  MAX_LONG,
  OUT_DIR,
  type RenderedIcon,
  renderAll,
} from '../tools/icons/build'
import { ACCENT_OPACITY, MANIFEST, TONES } from '../tools/icons/manifest'

const icons: RenderedIcon[] = await renderAll()

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('')}`

/** 不透明像素里出现最多的颜色 */
function dominantColor(px: Uint8Array): string {
  const count = new Map<string, number>()
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] !== 255) continue
    const c = hex(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0)
    count.set(c, (count.get(c) ?? 0) + 1)
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none'
}

/** 字形墨迹（alpha > 0）的外接框、中心与最大 alpha */
function inkBox(px: Uint8Array) {
  let x0 = ICON_PX
  let y0 = ICON_PX
  let x1 = -1
  let y1 = -1
  let maxAlpha = 0
  for (let y = 0; y < ICON_PX; y++) {
    for (let x = 0; x < ICON_PX; x++) {
      const a = px[(y * ICON_PX + x) * 4 + 3] ?? 0
      if (a === 0) continue
      maxAlpha = Math.max(maxAlpha, a)
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const margin = Math.min(x0, y0, ICON_PX - 1 - x1, ICON_PX - 1 - y1)
  // 墨迹中心（像素坐标，画布中心是 ICON_PX / 2）
  const cx = (x0 + x1 + 1) / 2
  const cy = (y0 + y1 + 1) / 2
  return { w, h, margin, maxAlpha, cx, cy }
}

describe('产物与真源一致（改了 svg / manifest 要重跑 `bun run --filter @fish/miniapp icons`）', () => {
  test('lib-icons/ 下的文件恰好是清单里的那些，且逐字节等于重新出图的结果', async () => {
    expect(readdirSync(OUT_DIR).sort()).toEqual(icons.map((i) => i.file).sort())
    for (const icon of icons) {
      const disk = new Uint8Array(await Bun.file(join(OUT_DIR, icon.file)).arrayBuffer())
      expect({ file: icon.file, same: Buffer.compare(disk, icon.png) === 0 }).toEqual({
        file: icon.file,
        same: true,
      })
    }
  })

  test('唯一出口 lib-icons.ts 是生成的', async () => {
    expect(await Bun.file(ENTRY).text()).toBe(entrySource(icons))
  })

  test('每个 svg 都登记在清单里，且沿用同一套网格与描边', async () => {
    const glyphs = readdirSync(GLYPH_DIR).map((f) => f.replace(/\.svg$/, ''))
    expect(glyphs.sort()).toEqual(Object.keys(MANIFEST).sort())
    for (const g of glyphs) {
      const svg = await Bun.file(join(GLYPH_DIR, `${g}.svg`)).text()
      expect({ g, ok: svg.startsWith(SVG_ROOT) }).toEqual({ g, ok: true })
    }
  })
})

const SVG_ROOT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">'

describe('图标契约', () => {
  test('语义色取自设计令牌（--brand / --fg / --muted / --danger）+ 反白，不含旧库的杂色蓝', async () => {
    const tokens = await Bun.file(join(import.meta.dir, '..', 'src/styles/_token-vars.scss')).text()
    const token = (name: string) =>
      new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`).exec(tokens)?.[1]?.toUpperCase()
    expect({ ...TONES }).toEqual({
      brand: token('brand') ?? 'missing',
      fg: token('fg') ?? 'missing',
      muted: token('muted') ?? 'missing',
      white: '#FFFFFF',
      danger: token('danger') ?? 'missing',
    })
    const banned = ['#397AFA', '#2377F4', '#0F4DC8', '#146BED', '#A8C5FA']
    expect(
      icons.filter((i) => banned.includes(dominantColor(i.pixels))).map((i) => i.file),
    ).toEqual([])
  })

  test('名字里的语义色就是烘焙色（只有 Brand / Fg / Muted / White / Danger）', () => {
    // 旧库的 -ink / -accent / -line 后缀说不清颜色，已全部换成语义名
    expect(Object.keys(ICONS).filter((k) => !/(Brand|Fg|Muted|White|Danger)$/.test(k))).toEqual([])
    for (const icon of icons) {
      const tone = icon.file
        .replace(/@3x\.png$/, '')
        .split('-')
        .at(-1) as keyof typeof TONES
      expect({ file: icon.file, color: dominantColor(icon.pixels) }).toEqual({
        file: icon.file,
        color: TONES[tone],
      })
    }
  })

  /**
   * 允许带「半透明错位填充块」的字形**白名单**。
   *
   * 期望集不能从 manifest / svg 自身推导 —— 那样只要新加 `accentColor` 的字形恰好有
   * brand tone，期望集就跟着一起变大，断言恒绿（等于只验证「渲染 == 声明」这条恒等式，
   * 没验证「哪些字形允许这么画」）。这里写死，新增必须显式登记。
   */
  const ACCENT_GLYPHS = [
    'entry-bought',
    'entry-onsale',
    'entry-report',
    'entry-review',
    'entry-sold',
    'tab-home',
    'tab-me',
    'tab-message',
    'tab-wish',
  ] as const

  test('只有带填充块的字形（TabBar / 「我的」交易入口）在 brand 下出半透明错位填充', () => {
    const fillAlpha = Math.round(ACCENT_OPACITY * 255)
    const withFill = icons
      .filter((icon) => {
        let n = 0
        for (let i = 3; i < icon.pixels.length; i += 4) {
          if (Math.abs((icon.pixels[i] ?? 0) - fillAlpha) <= 3) n += 1
        }
        return n >= 50
      })
      .map((icon) => icon.file)
    expect(withFill.sort()).toEqual(ACCENT_GLYPHS.map((glyph) => `${glyph}-brand@3x.png`).sort())
    // 反向：白名单里的字形必须真的声明并画出填充块（丢了也算回归）
    for (const glyph of ACCENT_GLYPHS) {
      expect({
        glyph,
        declaresAccent: readFileSync(join(GLYPH_DIR, `${glyph}.svg`), 'utf8').includes(
          'accentColor',
        ),
      }).toEqual({ glyph, declaresAccent: true })
      expect({ glyph, painted: withFill.includes(`${glyph}-brand@3x.png`) }).toEqual({
        glyph,
        painted: true,
      })
    }
  })

  /**
   * 光学归一（#660）：字形不再靠全库一个 `GLYPH_ZOOM` 一刀切放大，而是**逐字形**量墨迹后
   * 定 viewBox —— 中心对齐画布中心、按等效边长 `sqrt(w·h)` 做面积配平、长边不超过 `MAX_LONG`。
   *
   * 这条守三个不变量：
   * - **长边落在 91%–96.5%**（实测 91.7%–95.8%）。区间两端各是一类字形：
   *   正方形/近正方形由 `OPTICAL_D` 定（91.7%），扁长形由 `MAX_LONG` 定（90.2px）+ 1px
   *   抗锯齿边缘 → 95.8%。上限留到 96.5% 是因为 96px 画布的量化步长是 1.04pp，不能贴着 94% 卡；
   *   「真的没切边」由下面的留白 ≥ 2px 断言守。
   * - **面积配平**：等效边长 ≥ 90%，或者长边已经顶到 `MAX_LONG` 上限 —— 后者是扁字形
   *   （`check-double` 高 55%、`cat-sports` 高 56%）的几何极限：再放大就会切边，
   *   用长边换面积已经是它能到的最大光学尺寸。
   * - **居中**：墨迹中心与画布中心偏差 ≤ 1px（实测 ≤ 0.5px；归一前最大偏 2.5px，`tab-home`）。
   *
   * 另外沿用的硬底线：四周留白 ≥ 2px、最深处 alpha ≥ 200（不发虚）。
   */
  test('光学归一：长边 91%–96.5%、面积配平（等效边长 ≥90% 或长边顶到上限）、留白 ≥2px、居中偏差 ≤1px、不发虚', () => {
    for (const icon of icons) {
      const { w, h, margin, maxAlpha, cx, cy } = inkBox(icon.pixels)
      const longRatio = Math.max(w, h) / ICON_PX
      const dRatio = Math.sqrt(w * h) / ICON_PX
      expect({ file: icon.file, longBand: longRatio >= 0.91 && longRatio <= 0.965 }).toMatchObject({
        file: icon.file,
        longBand: true,
      })
      expect({
        file: icon.file,
        optical: dRatio >= 0.9 || longRatio >= MAX_LONG - 0.005,
      }).toMatchObject({ file: icon.file, optical: true })
      expect({ file: icon.file, margin }).toMatchObject({ file: icon.file })
      expect(margin).toBeGreaterThanOrEqual(2)
      expect(maxAlpha).toBeGreaterThanOrEqual(200)
      expect(Math.abs(cx - ICON_PX / 2)).toBeLessThanOrEqual(1)
      expect(Math.abs(cy - ICON_PX / 2)).toBeLessThanOrEqual(1)
    }
  })

  /**
   * 绝对下限（防回归）：上面那条守的是「归一之后的形态」，这条守「真的被放大了」——
   * 不用任何常量换算，直接要求最长边 ≥ 画布的 90%。它会红的三种情况：归一被退回一刀切
   * 小系数、`opticalViewBox` 失效（viewBox 没被收紧）、新字形画得太小没量到。
   */
  test('字形最长边占画布 ≥ 90%（锁住「字形确实被放大」）', () => {
    for (const icon of icons) {
      const { w, h } = inkBox(icon.pixels)
      const ratio = Math.max(w, h) / ICON_PX
      expect({ file: icon.file, ok: ratio >= 0.9, pct: Math.round(ratio * 100) }).toMatchObject({
        file: icon.file,
        ok: true,
      })
    }
  })

  test('同族极差：32 个 brand 字形的长边占比极差 ≤ 5pp（光学大小一致）', () => {
    const ratios = icons
      .filter((i) => i.tone === 'brand')
      .map((i) => {
        const { w, h } = inkBox(i.pixels)
        return Math.max(w, h) / ICON_PX
      })
    const spread = Math.max(...ratios) - Math.min(...ratios)
    // 实测 4.2pp（91.7% ↔ 95.8%），逐字形归一小前是 8.3pp。5pp 是「两类字形的目标值之差 +
    // 一个量化步长」：`OPTICAL_D` 那批 91.7%，`MAX_LONG` 那批 95.8%，96px 画布步长 1.04pp。
    expect({
      n: ratios.length,
      spread: Number(spread.toFixed(4)),
      ok: spread <= 0.05,
    }).toMatchObject({
      ok: true,
    })
  })

  test('没有字节完全相同的两张图', () => {
    const seen = new Map<string, string>()
    for (const icon of icons) {
      const digest = new Bun.CryptoHasher('sha256').update(icon.png).digest('hex')
      expect({ file: icon.file, dup: seen.get(digest) }).toEqual({
        file: icon.file,
        dup: undefined,
      })
      seen.set(digest, icon.file)
    }
  })

  test('导出的每个图标都有页面在用（`ICONS.x` 或类型为 IconName 的字面量）', async () => {
    const src = join(import.meta.dir, '..', 'src')
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    let code = ''
    for await (const f of glob.scan(src)) {
      if (f.startsWith('assets/lib-icons')) continue
      code += await Bun.file(join(src, f)).text()
    }
    const unused = icons
      .map((i) => i.key)
      .filter((k) => !new RegExp(`ICONS\\.${k}\\b|'${k}'`).test(code))
    expect(unused).toEqual([])
  })
})
