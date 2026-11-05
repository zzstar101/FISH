/**
 * 图标生成器：`tools/icons/glyphs/*.svg` × `manifest.ts` → `src/assets/lib-icons/*.png`
 * + 唯一出口 `src/assets/lib-icons.ts`。
 *
 *   bun run --filter @fish/miniapp icons
 *
 * 小程序 `<Image>` 不能渲染 SVG、PNG 也不能被 WXSS 可靠染色，所以颜色在出图这一刻烘焙。
 * 光栅化用 `@resvg/resvg-wasm`：WASM 在任何平台上逐字节一致，CI 才能用
 * 「重出图后 `git status --porcelain apps/miniapp/src/assets` 为空」守住产物与真源一致。
 *
 * 出图规格：72×72（= 24pt@3x）。页面显示尺寸只用 24/32/40/48rpx 四档，均 ≤ 24pt，不拉伸。
 * 字形在画布里的占比由 `GLYPH_ZOOM` 决定（文字见该常量）。
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { ACCENT_OPACITY, MANIFEST, TONES, type Tone } from './manifest'

export const ICON_PX = 72

/**
 * 字形放大系数：显示尺寸四档（24/32/40/48rpx）一个都不动，只把字形在 24×24 网格里的
 * 占比放大 —— 等效于把 `viewBox` 从 `0 0 24 24` 收成居中的 `24/GLYPH_ZOOM` 方窗。
 * 1.2 与 40→48rpx 那一档的体量相当；实测重出图后字形最长边 60–67px（占画布 83%–93%），
 * 四周最小留白 2–5px（最紧的是 `entry-onsale-brand`），0 张切边。
 */
export const GLYPH_ZOOM = 1.2

const ROOT = join(import.meta.dir, '..', '..')
export const GLYPH_DIR = join(import.meta.dir, 'glyphs')
export const OUT_DIR = join(ROOT, 'src', 'assets', 'lib-icons')
export const ENTRY = join(ROOT, 'src', 'assets', 'lib-icons.ts')

export interface RenderedIcon {
  /** 文件名，如 `chevron-right-muted@3x.png` */
  file: string
  /** 出口键，如 `chevronRightMuted` */
  key: string
  glyph: string
  tone: Tone
  png: Uint8Array
  /** RGBA，ICON_PX × ICON_PX */
  pixels: Uint8Array
}

const camel = (s: string) => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

export const iconKey = (glyph: string, tone: Tone) =>
  camel(glyph) + tone[0]?.toUpperCase() + tone.slice(1)

/**
 * 把字形 SVG 的 `viewBox="0 0 24 24"` 收紧成居中的方窗，字形据此等比放大 `zoom` 倍；
 * 描边也随之一并放大（放大字号的自然结果）。字形真源与画布尺寸都不改。
 */
export function zoomViewBox(svg: string, zoom: number): string {
  if (zoom === 1) return svg
  const side = (24 / zoom).toFixed(3)
  const inset = ((24 - 24 / zoom) / 2).toFixed(3)
  return svg.replace('viewBox="0 0 24 24"', `viewBox="${inset} ${inset} ${side} ${side}"`)
}

let ready: Promise<void> | undefined
function init() {
  ready ??= (async () => {
    const wasm = Bun.resolveSync('@resvg/resvg-wasm/index_bg.wasm', import.meta.dir)
    await initWasm(await Bun.file(wasm).arrayBuffer())
  })()
  return ready
}

export async function renderAll(): Promise<RenderedIcon[]> {
  await init()
  const out: RenderedIcon[] = []
  for (const [glyph, tones] of Object.entries(MANIFEST)) {
    const svg = await Bun.file(join(GLYPH_DIR, `${glyph}.svg`)).text()
    for (const tone of tones) {
      // 带填充块的 TabBar 字形：brand = 选中态（描边加粗 + 半透明错位填充），其它 = 线稿
      const accent = tone === 'brand' && svg.includes('accentColor')
      const colored = zoomViewBox(svg, GLYPH_ZOOM)
        .replace('stroke-width="1.75"', accent ? 'stroke-width="2"' : 'stroke-width="1.75"')
        .replaceAll(
          'fill="accentColor"',
          accent ? `fill="${TONES.brand}" fill-opacity="${ACCENT_OPACITY}"` : 'fill="none"',
        )
        .replaceAll('currentColor', TONES[tone])
      const resvg = new Resvg(colored, {
        fitTo: { mode: 'width', value: ICON_PX },
        font: { loadSystemFonts: false },
      })
      const img = resvg.render()
      out.push({
        file: `${glyph}-${tone}@3x.png`,
        key: iconKey(glyph, tone),
        glyph,
        tone,
        png: img.asPng(),
        pixels: new Uint8Array(img.pixels),
      })
      img.free()
      resvg.free()
    }
  }
  return out
}

export function entrySource(icons: RenderedIcon[]): string {
  const sorted = [...icons].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const imports = sorted.map((i) => `import ${i.key} from '@/assets/lib-icons/${i.file}'`)
  const keys = [...icons].map((i) => `  ${i.key},`)
  return `/**
 * 图标资产出口（唯一入口）。**本文件由 \`tools/icons/build.ts\` 生成，不要手改。**
 *
 * 真源：\`tools/icons/glyphs/*.svg\`（字形）× \`tools/icons/manifest.ts\`（每个字形用到的语义色）。
 * 重出图：\`bun run --filter @fish/miniapp icons\`。
 *
 * 命名 = 字形 + 语义色：\`Brand\` 品牌蓝 / \`Fg\` 主文字 / \`Muted\` 次要灰 / \`White\` 反白 /
 * \`Danger\` 警示红；\`tab*Brand\`（TabBar 选中态）与 \`entry*Brand\`（「我的」交易入口）是加粗描边 + 半透明错位填充。页面与组件**只从这里取图标**，不要直接 import 具体 png。
 * 显示尺寸只用 24 / 32 / 40 / 48（SCSS px = rpx）四档；字形在 72px 画布里按 \`GLYPH_ZOOM\`
 * 放大到占满画布的 83%–93%，所以想要更大的图标请改 \`GLYPH_ZOOM\` 重出图，不要抬高显示尺寸。
 */
${imports.join('\n')}

export const ICONS = {
${keys.join('\n')}
} as const

export type IconName = keyof typeof ICONS
`
}

if (import.meta.main) {
  const icons = await renderAll()
  const keep = new Set(icons.map((i) => i.file))
  for (const f of readdirSync(OUT_DIR)) {
    if (!keep.has(f)) unlinkSync(join(OUT_DIR, f))
  }
  for (const i of icons) await Bun.write(join(OUT_DIR, i.file), i.png)
  await Bun.write(ENTRY, entrySource(icons))
  console.log(`icons: ${icons.length} png → ${OUT_DIR}`)
}
