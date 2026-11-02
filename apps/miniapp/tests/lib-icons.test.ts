/**
 * #513：图标契约。真源 = `tools/icons/glyphs/*.svg` × `tools/icons/manifest.ts`，
 * 产物 = `src/assets/lib-icons/*.png` + `src/assets/lib-icons.ts`（生成器写，不手改）。
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ICONS } from '@/assets/lib-icons'
import {
  ENTRY,
  entrySource,
  GLYPH_DIR,
  ICON_PX,
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

/** 字形墨迹（alpha > 0）的外接框与最大 alpha */
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
  return { w, h, margin, maxAlpha }
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

  test('只有 TabBar 选中态（tab-*-brand）带半透明错位填充', () => {
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
    expect(withFill.sort()).toEqual(
      Object.keys(MANIFEST)
        .filter((glyph) => glyph.startsWith('tab-'))
        .map((glyph) => `${glyph}-brand@3x.png`)
        .sort(),
    )
  })

  test('24pt 网格：字形 48–56px、四周留白 ≥ 8px、最深处不发虚（alpha ≥ 200）', () => {
    for (const icon of icons) {
      const { w, h, margin, maxAlpha } = inkBox(icon.pixels)
      const size = Math.max(w, h)
      expect({ file: icon.file, size: size >= 48 && size <= 56, margin, maxAlpha }).toMatchObject({
        file: icon.file,
        size: true,
      })
      expect(margin).toBeGreaterThanOrEqual(8)
      expect(maxAlpha).toBeGreaterThanOrEqual(200)
    }
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
