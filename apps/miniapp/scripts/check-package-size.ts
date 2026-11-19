import { resolve } from 'node:path'

/**
 * 小程序主包体积门禁（#695）。
 *
 * 为什么要有：`#695` 把设计稿原始分辨率的成品图（认证徽章 2172×724 = 1016 KB）直接入库，
 * 主包从 1073 KB 涨到 2774 KB，**超过微信 2048 KB 上限 726 KB**，上传与预览都会直接报
 * 「主包过大」。typecheck / lint / 单测全绿，只有真去构建量 `dist` 才看得见。
 *
 * 判据与微信一致：主包 = `dist/` 下**除各分包目录**以外的全部文件（含图片、wxml、js）。
 * 留 64 KB 余量给构建产物的平台差异，触线即报出占用最多的文件，指向该怎么处理
 * （新素材走 `tools/artwork/build.ts` 按显示尺寸出图，别把母版分辨率整张入库）。
 */
const dist = resolve(import.meta.dir, '../dist')
/** 微信小程序主包上限 2048 KB；产物留 64 KB 余量 */
const LIMIT_BYTES = (2048 - 64) * 1024

const files = Array.from(new Bun.Glob('**/*').scanSync(dist))
if (files.length === 0) throw new Error('No miniapp output; build first.')

const mainPackage = files
  .filter((file) => !file.split('/')[0]?.startsWith('pkg-'))
  .map((file) => ({ file, size: Bun.file(resolve(dist, file)).size }))

const total = mainPackage.reduce((sum, entry) => sum + entry.size, 0)
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`

if (total > LIMIT_BYTES) {
  const biggest = mainPackage
    .sort((a, b) => b.size - a.size)
    .slice(0, 10)
    .map((entry) => `  ${kb(entry.size).padStart(8)}  ${entry.file}`)
    .join('\n')
  console.error(`主包 ${kb(total)} 超过门禁 ${kb(LIMIT_BYTES)}（微信上限 2048 KB）\n最大的前 10 个文件：\n${biggest}`)
  console.error(
    '\n新增图片请走 tools/artwork/build.ts 按**显示尺寸**出图（出图宽 = 显示 rpx × 1.5），' +
      '不要把设计稿母版分辨率整张放进 src/assets。',
  )
  process.exit(1)
}

console.log(`主包体积 ${kb(total)} / ${kb(LIMIT_BYTES)}（微信上限 2048 KB）`)
