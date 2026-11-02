/**
 * 品牌资产生成器（#513 根因 6 / 修复建议 5、7）：`bun run --filter @fish/miniapp brand`
 *
 * 唯一母版 `tools/brand/lockup-master.png`（原 `src/assets/brand/logo.png`）：
 * 1128×268、纯 `--brand #4285FF` 单色 + alpha，是仓里分辨率最高、内容最全的那张
 * （鱼形标 + 「鱼小应 / YUXIAOYING」）。旧的 `brand-mark.png` / `brand-wordmark.png`
 * 就是它的 x∈[0,440) / x∈[460,1128) 裁切（逐像素差 ≤2）；旧 `brand-lockup.png`
 * 是 683×160 的双色低清版，不作源。仓里没有矢量真源，所以只从这一张位图派生。
 *
 * 产物写到 `src/assets/brand/`，页面一律经 `src/assets/brand/index.ts` 取用。
 * 出图宽度 = 页面盒子的 rpx × 1.5（750rpx 设计宽 → 375pt，再 ×3），不过采样：
 *
 * | 产物            | 母版裁切            | 输出宽 | 依据                                             |
 * | --------------- | ------------------- | ------ | ------------------------------------------------ |
 * | `lockup.png`    | 全幅 1128×268       | 303    | 首页顶栏 202rpx（`pages/home/index.scss`）、我的页脚 205rpx 定高 48rpx |
 * | `mark.png`      | x 0–440             | 375    | 关于页 250rpx（`pkg-legal/pages/about/index.scss`），登录页 188rpx 共用 |
 * | `wordmark.png`  | x 460–1128          | 300    | 登录页 200rpx（`pkg-auth/pages/login/index.scss`） |
 * | `share.png`     | 全幅 lockup 居中    | 500    | 首页 `useShareAppMessage` 的 5:4 封面            |
 *
 * 输出是确定的（同一母版重跑字节不变），CI 会校验重跑后 `src/assets` 无 diff。
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { initWasm, Resvg } from '@resvg/resvg-wasm'

const MASTER = `${import.meta.dir}/lockup-master.png`
const OUT_DIR = `${import.meta.dir}/../../src/assets/brand`
const MASTER_W = 1128
const MASTER_H = 268

interface Crop {
  x: number
  w: number
}

const LOCKUP: Crop = { x: 0, w: MASTER_W }
const MARK: Crop = { x: 0, w: 440 }
const WORDMARK: Crop = { x: 460, w: 668 }

/** 5:4 分享封面（微信卡片按 5:4 显示），母版坐标系下的画布 */
const SHARE_W = 1250
const SHARE_H = 1000
/** 封面里 lockup 占画布宽的比例 */
const SHARE_LOCKUP_RATIO = 0.62
/** `--brand #4285FF`（DESIGN.md），与母版颜色一致 */
const BRAND_RGB = [0x42, 0x85, 0xff] as const

const CRC_TABLE: number[] = []
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE.push(c >>> 0)
}

const masterBytes = new Uint8Array(await Bun.file(MASTER).arrayBuffer())
assertMasterSize(masterBytes)
const masterHref = `data:image/png;base64,${Buffer.from(masterBytes).toString('base64')}`

await initWasm(
  await Bun.file(Bun.resolveSync('@resvg/resvg-wasm/index_bg.wasm', import.meta.dir)).arrayBuffer(),
)

/**
 * `mask`：母版是单色，产物只留 alpha，按 `--brand` 着色写成调色板 PNG（1 字节/像素）。
 * `opaque`：分享封面不透明，写成 RGB。
 * 不用 resvg 自带的 `asPng()`：它固定 RGBA，且低 alpha 边缘像素反预乘后 RGB 会漂离品牌色。
 */
const outputs: Array<[name: string, svg: string, width: number, kind: 'mask' | 'opaque']> = [
  ['lockup.png', cropSvg(LOCKUP), 303, 'mask'],
  ['mark.png', cropSvg(MARK), 375, 'mask'],
  ['wordmark.png', cropSvg(WORDMARK), 300, 'mask'],
  ['share.png', shareSvg(), 500, 'opaque'],
]

// 出口目录只留 index.ts 与本次产物：改名 / 删产物后不会留下没人引用的旧图
const keep = new Set(['index.ts', ...outputs.map(([name]) => name)])
for (const f of readdirSync(OUT_DIR)) if (!keep.has(f)) unlinkSync(`${OUT_DIR}/${f}`)

for (const [name, svg, width, kind] of outputs) {
  const img = render(svg, width)
  const bytes = kind === 'mask' ? encodeMask(img) : encodeOpaque(img)
  await Bun.write(`${OUT_DIR}/${name}`, bytes)
  console.log(`${name.padEnd(13)} ${img.width}×${img.height}  ${bytes.byteLength} B`)
}

function cropSvg({ x, w }: Crop): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} 0 ${w} ${MASTER_H}" width="${w}" height="${MASTER_H}">` +
    `<image href="${masterHref}" width="${MASTER_W}" height="${MASTER_H}"/>` +
    '</svg>'
  )
}

/**
 * 封面：`--grad-page`（165°，#DCEBFF → #EAF4FF → #F7FAFF，DESIGN.md 页头令牌）冰蓝底 +
 * 居中 lockup（视觉略偏上）。试过右上叠一层 `--cyan` 径向光晕：二维渐变让 PNG 从 9KB
 * 涨到 18KB、品牌资产合计破 30KB，取舍后不加。
 */
function shareSvg(): string {
  const w = SHARE_W * SHARE_LOCKUP_RATIO
  const h = (w * MASTER_H) / MASTER_W
  const x = (SHARE_W - w) / 2
  const y = (SHARE_H - h) / 2 - SHARE_H * 0.03
  // 165° 的 CSS 渐变方向向量（0° 朝上、顺时针）
  const rad = (165 * Math.PI) / 180
  const dx = Math.sin(rad) / 2
  const dy = -Math.cos(rad) / 2
  const f = (n: number) => Number(n.toFixed(4))
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHARE_W} ${SHARE_H}" width="${SHARE_W}" height="${SHARE_H}">` +
    '<defs>' +
    `<linearGradient id="bg" x1="${f(0.5 - dx)}" y1="${f(0.5 - dy)}" x2="${f(0.5 + dx)}" y2="${f(0.5 + dy)}">` +
    '<stop offset="0" stop-color="#DCEBFF"/><stop offset="0.46" stop-color="#EAF4FF"/><stop offset="1" stop-color="#F7FAFF"/>' +
    '</linearGradient>' +
    '</defs>' +
    `<rect width="${SHARE_W}" height="${SHARE_H}" fill="url(#bg)"/>` +
    `<image href="${masterHref}" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"/>` +
    '</svg>'
  )
}

interface Raster {
  /** RGBA，逐行 */
  pixels: Uint8Array
  width: number
  height: number
}

function render(svg: string, width: number): Raster {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  })
  const image = resvg.render()
  const out = { pixels: image.pixels.slice(), width: image.width, height: image.height }
  image.free()
  resvg.free()
  return out
}

/** 调色板 PNG：每个出现过的 alpha 档位一个条目，RGB 全是品牌色 */
function encodeMask({ pixels, width, height }: Raster): Uint8Array {
  const alphas = [
    ...new Set(Array.from({ length: width * height }, (_, i) => byte(pixels, i * 4 + 3))),
  ].sort((a, b) => a - b)
  const index = new Map(alphas.map((a, i) => [a, i]))
  const rows = Array.from({ length: height }, (_, y) =>
    Uint8Array.from(
      { length: width },
      (_, x) => index.get(byte(pixels, (y * width + x) * 4 + 3)) ?? 0,
    ),
  )
  const plte = new Uint8Array(alphas.length * 3)
  for (let i = 0; i < alphas.length; i++) plte.set(BRAND_RGB, i * 3)
  return png(width, height, 3, 1, rows, [
    ['PLTE', plte],
    ['tRNS', Uint8Array.from(alphas)],
  ])
}

function encodeOpaque({ pixels, width, height }: Raster): Uint8Array {
  const rows = Array.from({ length: height }, (_, y) => {
    const row = new Uint8Array(width * 3)
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      if (pixels[p + 3] !== 255) throw new Error(`share 封面 (${x},${y}) 不是不透明像素`)
      row.set(pixels.subarray(p, p + 3), x * 3)
    }
    return row
  })
  return png(width, height, 2, 3, rows, [])
}

/**
 * 最小 PNG 编码器：IHDR + 附加块 + IDAT + IEND。行滤波在「全 None / 全 Sub / … / 逐行最小绝对和」
 * 几种策略里取 deflate 后最小的那个；全部是确定性的，同输入同字节。
 */
function png(
  width: number,
  height: number,
  colorType: 2 | 3,
  bpp: number,
  rows: Uint8Array[],
  chunks: Array<[type: string, data: Uint8Array]>,
): Uint8Array {
  const strategies: Array<number | 'adaptive'> = [0, 1, 2, 3, 4, 'adaptive']
  let idat: Uint8Array | undefined
  for (const strategy of strategies) {
    const raw = new Uint8Array(height * (width * bpp + 1))
    rows.forEach((row, y) => {
      const prev = y > 0 ? rows[y - 1] : undefined
      const filtered =
        strategy === 'adaptive'
          ? [0, 1, 2, 3, 4]
              .map((f) => filterRow(f, row, prev, bpp))
              .reduce((best, cur) => (absSum(cur) < absSum(best) ? cur : best))
          : filterRow(strategy, row, prev, bpp)
      raw.set(filtered, y * (width * bpp + 1))
    })
    const z = new Uint8Array(deflateSync(raw, { level: 9, memLevel: 9 }))
    if (!idat || z.byteLength < idat.byteLength) idat = z
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, colorType, 0, 0, 0], 8)
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...chunks.map(([type, data]) => chunk(type, data)),
    chunk('IDAT', idat ?? new Uint8Array()),
    chunk('IEND', new Uint8Array()),
  ]
  return Buffer.concat(parts)
}

/** 返回带滤波类型首字节的一行 */
function filterRow(
  type: number,
  row: Uint8Array,
  prev: Uint8Array | undefined,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(row.length + 1)
  out[0] = type
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? byte(row, i - bpp) : 0
    const b = prev ? byte(prev, i) : 0
    const c = prev && i >= bpp ? byte(prev, i - bpp) : 0
    const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type] ?? 0
    out[i + 1] = (byte(row, i) - predictor) & 0xff
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** 逐行选滤波的常用启发式：把字节当有符号数求绝对值和 */
function absSum(filtered: Uint8Array): number {
  let s = 0
  for (let i = 1; i < filtered.length; i++) {
    const v = byte(filtered, i)
    s += v < 128 ? v : 256 - v
  }
  return s
}

/** 越界读按 0 处理（`noUncheckedIndexedAccess` 下的显式口径） */
function byte(bytes: Uint8Array, i: number): number {
  return bytes[i] ?? 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.byteLength)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)))
  return out
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 母版换了尺寸，上面的裁切坐标就全错了 —— 直接失败，别静默出歪图 */
function assertMasterSize(png: Uint8Array): void {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const w = view.getUint32(16)
  const h = view.getUint32(20)
  if (w !== MASTER_W || h !== MASTER_H) {
    throw new Error(`lockup-master.png 应为 ${MASTER_W}×${MASTER_H}，实际 ${w}×${h}`)
  }
}
