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
 * 字形在画布里的位置与占比由**逐字形光学归一**决定（文字见 `OPTICAL_D` / `MAX_LONG`）。
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import { ACCENT_OPACITY, MANIFEST, TONES, type Tone } from './manifest'

export const ICON_PX = 72

/**
 * 光学归一（#660）：每个字形单独测量墨迹，再决定 viewBox 窗口与描边宽度。
 *
 * 旧做法是全库一个 `GLYPH_ZOOM`（1.2）把 viewBox 收成居中的 20 单位方窗 —— 一刀切，
 * 治不了「字形自己画得偏、画得小」：实测 32 个 brand 字形的墨迹最长边 84.7%–93.1%
 * （极差 8.3pp），瘦字形（`cat-beauty` 宽 44%）与扁字形（`check-double` 高 55%）在方形
 * 容器里更显小，居中偏移最大 2.5px（`tab-home`）。现在改成逐字形三步：
 *
 * 1. 先按原 viewBox 渲一次，量出墨迹 bbox（`measureInk`）；
 * 2. 窗口以 bbox 中心为中心 —— 解决「不居中」；
 * 3. 窗口边长按 bbox 的**等效边长** `sqrt(w·h)` 定：目标占画布 `OPTICAL_D`，即按**面积**
 *    而不是最长边配平 —— 扁/瘦字形靠长边换面积，不会因为短边短就在容器里显小；
 *    长边另受 `MAX_LONG` 约束（留白 ≥ 2px），细长字形按长边收，不会被切。
 *
 * 描边宽度按归一后的比例**逐字形折算**（`STROKE_VISUAL / scale`），让所有图标在画布上的
 * 视觉线宽一致，而不是「字形放大几倍、线就跟着粗几倍」（DESIGN.md 里挂着的那个待办）。
 */
export const OPTICAL_D = 0.9167
export const MAX_LONG = 0.94
/** 量墨迹用的渲染分辨率：12px / 网格单位（24 单位 → 288px） */
export const MEASURE_PX = 288
/** 画布上的目标视觉线宽（网格单位）= 1.75 × 1.2，与 #513 之后的观感一致 */
export const STROKE_VISUAL = 2.1
/** 带填充块的 brand 变体（TabBar 选中态 / entry-*）描边更重一档 */
export const STROKE_VISUAL_BOLD = 2.4

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
 * 把字形 SVG 的 `viewBox="0 0 24 24"` 换成本字形自己的方窗（见 `opticalViewBox`）。
 */
function applyViewBox(svg: string, viewBox: string): string {
  const next = svg.replace('viewBox="0 0 24 24"', `viewBox="${viewBox}"`)
  if (next === svg) throw new Error('字形 SVG 缺少 viewBox="0 0 24 24"')
  return next
}

let ready: Promise<void> | undefined
function init() {
  ready ??= (async () => {
    const wasm = Bun.resolveSync('@resvg/resvg-wasm/index_bg.wasm', import.meta.dir)
    await initWasm(await Bun.file(wasm).arrayBuffer())
  })()
  return ready
}

async function renderRaw(svg: string, px: number) {
  await init()
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: px },
    font: { loadSystemFonts: false },
  })
  const img = resvg.render()
  const pixels = new Uint8Array(img.pixels)
  img.free()
  resvg.free()
  return { pixels, size: px }
}

/** alpha > 0 的外接框（含抗锯齿边缘）。`size` 为渲染边长 */
export function inkBoxOf(pixels: Uint8Array, size: number) {
  let x0 = size
  let y0 = size
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if ((pixels[(y * size + x) * 4 + 3] ?? 0) === 0) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) throw new Error('空字形：没有任何墨迹')
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** 量字形墨迹：返回 24×24 网格单位下的中心与尺寸 */
export async function measureInk(svg: string) {
  // 探针渲染：颜色无关（全黑）、填充块不参与（只量描边轮廓）
  const probe = svg
    .replaceAll('currentColor', '#000000')
    .replaceAll('fill="accentColor"', 'fill="none"')
  const { pixels, size } = await renderRaw(probe, MEASURE_PX)
  const b = inkBoxOf(pixels, size)
  const unit = size / 24
  return {
    cx: (b.x0 + b.x1 + 1) / 2 / unit,
    cy: (b.y0 + b.y1 + 1) / 2 / unit,
    w: b.w / unit,
    h: b.h / unit,
  }
}

/**
 * 由墨迹 bbox 算出 viewBox 方窗与放大倍数：窗口中心 = 墨迹中心，
 * 边长取「等效边长 sqrt(w·h) 达标」与「长边不越界」两者中更紧的那个。
 */
export function opticalViewBox(ink: { cx: number; cy: number; w: number; h: number }) {
  const d = Math.sqrt(ink.w * ink.h)
  const long = Math.max(ink.w, ink.h)
  const scale = Math.min((OPTICAL_D * 24) / d, (MAX_LONG * 24) / long)
  const side = 24 / scale
  const x = (ink.cx - side / 2).toFixed(3)
  const y = (ink.cy - side / 2).toFixed(3)
  const s = side.toFixed(3)
  return { viewBox: `${x} ${y} ${s} ${s}`, scale }
}

export async function renderAll(): Promise<RenderedIcon[]> {
  await init()
  const out: RenderedIcon[] = []
  for (const [glyph, tones] of Object.entries(MANIFEST)) {
    const svg = await Bun.file(join(GLYPH_DIR, `${glyph}.svg`)).text()
    // 每个字形量一次墨迹：几何与 tone 无关，同一个字形所有语义色共用同一个 viewBox
    const { viewBox, scale } = opticalViewBox(await measureInk(svg))
    const base = applyViewBox(svg, viewBox)
    for (const tone of tones) {
      // 带填充块的 TabBar 字形：brand = 选中态（描边加粗 + 半透明错位填充），其它 = 线稿
      const accent = tone === 'brand' && svg.includes('accentColor')
      // 描边：折算回「画布上的视觉线宽」恒定（见 STROKE_VISUAL 注释）
      const stroke = ((accent ? STROKE_VISUAL_BOLD : STROKE_VISUAL) / scale).toFixed(3)
      const colored = base
        .replace('stroke-width="1.75"', `stroke-width="${stroke}"`)
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
 * 显示尺寸只用 24 / 32 / 40 / 48（SCSS px = rpx）四档；每个字形在 72px 画布里按自己的
 * 墨迹做过光学归一（等比边长 ≈ 画布的 ${Math.round(OPTICAL_D * 100)}%、长边 ≤ ${Math.round(MAX_LONG * 100)}%、居中、
 * 视觉线宽恒定），所以想要更大的图标请调 \`OPTICAL_D\` 重出图，不要抬高显示尺寸。
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
