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
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { ACCENT, MANIFEST, TONES, type Tone } from './manifest'

export const ICON_PX = 72

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
      const duo = tone === 'duo'
      const colored = svg
        .replace('stroke-width="1.75"', duo ? 'stroke-width="2"' : 'stroke-width="1.75"')
        .replaceAll('currentColor', TONES[tone])
        .replaceAll('accentColor', duo ? ACCENT : 'none')
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
 * \`Danger\` 警示红 / \`Duo\` 深色描边 + 品牌蓝填充（仅 TabBar 选中态）。页面与组件**只从这里取图标**，不要直接 import 具体 png。
 * 显示尺寸只用 24 / 32 / 40 / 48（SCSS px = rpx）四档。
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
