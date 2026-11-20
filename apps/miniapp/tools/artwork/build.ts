/**
 * 页面成品图生成器：`bun run --filter @fish/miniapp artwork`
 *
 * 与 `tools/brand`（母版 + 生成器）同一治理口径：**母版留在 `tools/artwork/`，
 * 产物写进 `src/assets/`**，CI 会重跑一遍并校验 `src/assets` 无 diff。
 *
 * 为什么要有这个生成器（#695）：入库的成品图是按设计稿原始分辨率给的，比端上显示
 * 尺寸大一个数量级——认证徽章 2172×724 只显示 51×17pt（102×34rpx），是 42 倍超采样；
 * 「我的」交易入口图 256×256 只显示 48rpx。小程序**主包上限 2MB**，这些像素全部
 * 打进主包会让上传直接报「主包过大」，所以产物按显示尺寸出图。
 *
 * 出图宽度 = 显示 rpx × 1.5（750rpx 设计宽 → 375pt，再 ×3 —— 与 `tools/brand` 同一条
 * 换算，也是 `lib-icons` 的惯例：显示 48rpx 的图标入库 72px）。
 *
 * | 母版                          | 产物                                        | 输出   | 依据                                        |
 * | ----------------------------- | ------------------------------------------- | ------ | ------------------------------------------- |
 * | `badge-master.png` 2172×724   | `src/assets/badge/verified-badge@3x.png`    | 153×51 | `pages/profile` 102×34rpx、行内 72×24rpx    |
 * | `profile-*-master.png` 256²   | `src/assets/page-illustrations/profile-*.png` | 72×72 | `pages/profile` 的 `.profile__cell-ic` 48rpx |
 *
 * 徽章按 153×51 出图后仍由 `aspectFit` 显示：两档显示尺寸（102×34 / 72×24）比例都是 3:1，
 * 与画布一致，所以不变形、不留白。**不要再把分辨率调大**：主包放不下。
 *
 * 输出是确定的（同一母版重跑字节不变）。母版是设计稿原字节，换图必须找 Owner 出手稿重出，
 * 不要自己缩图后覆盖母版。
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { initWasm, Resvg } from '@resvg/resvg-wasm'

const HERE = import.meta.dir
const ICON_OUT_DIR = `${HERE}/../../src/assets/page-illustrations`
const BADGE_OUT_DIR = `${HERE}/../../src/assets/badge`

/** 认证徽章母版：设计稿 2172×724（宽高比 3:1），显示 102×34rpx / 72×24rpx */
const BADGE_MASTER = 'badge-master.png'
const BADGE_WIDTH = 153
const BADGE_HEIGHT = 51

/** 「我的」交易入口图：母版 256×256，显示 48rpx */
const PROFILE_ICONS = [
  'profile-onsale',
  'profile-sold',
  'profile-bought',
  'profile-review',
  'profile-reports',
] as const
const PROFILE_ICON_SIZE = 72

await initWasm(
  await Bun.file(Bun.resolveSync('@resvg/resvg-wasm/index_bg.wasm', HERE)).arrayBuffer(),
)

await Bun.write(
  `${BADGE_OUT_DIR}/verified-badge@3x.png`,
  await resize(`${HERE}/${BADGE_MASTER}`, BADGE_WIDTH, BADGE_HEIGHT),
)
console.log(`verified-badge@3x.png  ${BADGE_WIDTH}×${BADGE_HEIGHT}`)

for (const name of PROFILE_ICONS) {
  await Bun.write(
    `${ICON_OUT_DIR}/${name}.png`,
    await resize(`${HERE}/${name}-master.png`, PROFILE_ICON_SIZE, PROFILE_ICON_SIZE),
  )
  console.log(`${name}.png`.padEnd(22) + `${PROFILE_ICON_SIZE}×${PROFILE_ICON_SIZE}`)
}

// 只清理本生成器负责的 `profile-*.png`（同目录还有首页分类图与 banner，不归这里管）：
// 母版改名 / 退役后不会留下没人引用的旧图
const keep = new Set(PROFILE_ICONS.map((name) => `${name}.png`))
for (const f of readdirSync(ICON_OUT_DIR)) {
  if (f.startsWith('profile-') && !keep.has(f)) unlinkSync(`${ICON_OUT_DIR}/${f}`)
}

/**
 * 把母版位图重采样到目标画布。
 *
 * 走 resvg（而不是 `sips` / `sharp`）：母版是位图，套一层 `<image>` 后由 resvg 缩放，
 * 跨平台（macOS / Linux CI）逐字节一致，与 `tools/brand` 同一个渲染器。
 */
async function resize(path: string, width: number, height: number): Promise<Uint8Array> {
  const master = new Uint8Array(await Bun.file(path).arrayBuffer())
  const href = `data:image/png;base64,${Buffer.from(master).toString('base64')}`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">` +
    `<image href="${href}" width="${width}" height="${height}"/></svg>`
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
  })
  const image = resvg.render()
  const png = image.asPng()
  image.free()
  resvg.free()
  return png
}
