/**
 * 把 miniapp 的页面打包成一份可在浏览器里跑的预览产物，用于「对照设计稿截图」。
 *
 * 为什么不用微信开发者工具：本轮目标是**视觉还原比对**，不是端上验证。
 * 浏览器 + 固定 390×844 帧 + Edge headless 截图，能最快看出间距/层级/配色的偏差。
 * 端上行为（原生 TabBar、真机字体、safe-area）仍以微信开发者工具为准，见 DESIGN.md。
 *
 * 产出：preview/dist/{preview.js, main.css}
 * 用法：node preview/build.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sass from 'sass'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const OUT = join(HERE, 'dist')

mkdirSync(OUT, { recursive: true })

/** 把 `@/xxx` 指向 src，把 `@tarojs/*` 指向预览桩，并把 SCSS 编译成 CSS */
const previewPlugin = {
  name: 'preview',
  setup(build) {
    build.onResolve({ filter: /^@tarojs\/(components|taro)$/ }, () => ({
      path: join(HERE, 'taro-web-stub.tsx'),
    }))
    build.onLoad({ filter: /\.(scss|sass)$/ }, async (args) => {
      const result = sass.compile(args.path, {
        loadPaths: [join(ROOT, 'src')],
        importers: [
          {
            findFileUrl(url) {
              if (!url.startsWith('@/')) return null
              return new URL(`file:///${join(ROOT, 'src', url.slice(2)).replace(/\\/g, '/')}`)
            },
          },
        ],
        style: 'expanded',
        silenceDeprecations: ['import', 'global-builtin', 'legacy-js-api'],
      })
      return { contents: result.css, loader: 'css' }
    })
  },
}

const result = await Bun.build({
  entrypoints: [join(HERE, 'main.tsx')],
  outdir: OUT,
  target: 'browser',
  format: 'esm',
  splitting: false,
  minify: false,
  sourcemap: false,
  define: {
    'process.env.TARO_ENV': '"h5"',
    'process.env.NODE_ENV': '"development"',
    // 预览产物（H5，只给本地评审 / 截图 / 像素测量用）**显式打开** mock 回退：
    // 这个 bundle 不是生产，评审时没有后端也要能看到完整页面。
    // 生产口径见 config/index.ts 的 __ALLOW_MOCK_FALLBACK__。
    __ALLOW_MOCK_FALLBACK__: 'true',
  },
  plugins: [previewPlugin],
  naming: {
    entry: '[name].[ext]',
    chunk: 'chunk-[hash].[ext]',
    asset: 'asset-[hash].[ext]',
  },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

/**
 * 与 Taro 的 postcss-pxtransform 保持一致：`Npx` → `Nrpx`。
 * 预览运行时再把 `Nrpx` 按帧宽换算成 CSS 像素（750rpx = 390px）。
 * 少了这一步，设计尺寸会被当成 CSS 像素直接放大一倍以上。
 */
function pxToRpx(css) {
  return css.replace(/(-?[\d.]+)px\b/g, '$1rpx')
}

/**
 * Bun.build 会自己把收集到的 CSS 写进 outdir（即使我们再手动写一次，也会被它覆盖），
 * 所以构建产物先落到临时目录，再在这里做 px→rpx 与 `page` 选择器改写后搬到 dist。
 */
const cssText = (
  await Promise.all(result.outputs.filter((f) => f.path.endsWith('.css')).map((f) => f.text()))
)
  .join('\n')
  .replace(/^page\s*\{/m, ':root, .page-frame {')

for (const file of result.outputs) {
  if (file.path.endsWith('main.js')) {
    writeFileSync(join(OUT, 'preview.js'), await file.text())
    console.log(' - preview.js')
  }
}
// 浏览器不认识 rpx：去掉单位即可（帧宽 375px ≡ 750rpx，语义与小程序一致）
writeFileSync(join(OUT, 'preview.css'), cssText.replace(/(-?[\d.]+)rpx/g, '$1px'))
console.log(' - preview.css', `${Math.round(cssText.length / 1024)}KB`)

/* 令牌 + 全局壳：注入到 <style id="app-css">，避免与组件 CSS 顺序错乱 */
const rewrite = (css) => pxToRpx(css).replace(/^page\s*\{/m, ':root, .page-frame {')
for (const [name, file] of [['main.css', join(ROOT, 'src', 'app.scss')]]) {
  const compiled = sass.compile(file, {
    loadPaths: [join(ROOT, 'src')],
    style: 'expanded',
    silenceDeprecations: ['import', 'global-builtin', 'legacy-js-api'],
  })
  writeFileSync(join(OUT, name), rewrite(compiled.css))
  console.log(' -', name)
}

/**
 * 外壳 HTML 必须和产物**同目录**：Bun 把图片/图标写成 `./asset-xxx.png` 这种
 * 相对产物目录的路径，HTML 若在上一层就会整片裂图（踩过这个坑）。
 */
writeFileSync(join(OUT, 'index.html'), shellHtml())
console.log(' - index.html')

function shellHtml() {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FISH miniapp · 预览</title>
    <style>
      /* 预览帧：750×1624 CSS 像素 = 小程序的 750rpx 宽。
         换算约定（DESIGN.md §1）：SCSS 里的 1 个数值 = 1rpx，
         而 1rpx 在 375pt 屏上 = 0.5 CSS 像素 → 帧宽必须写成 750 才能与真机等比。
         写成 375 会让所有尺寸、字号、间距显示成真机的 2 倍。 */
      * { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0; background: #e9eef7;
        font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      }
      body { display: flex; justify-content: center; }
      .page-frame {
        position: relative; width: 750px; height: 1624px;
        overflow-x: hidden; overflow-y: auto;
        background: var(--bg, #f7faff); isolation: isolate;
      }
      .preview-loading, .preview-missing { padding: 24px; color: #71809c; font-size: 13px; }
      .page-frame ::-webkit-scrollbar { width: 0; height: 0; }
    </style>
    <link rel="stylesheet" href="./preview.css" />
    <!-- 全局壳 CSS（令牌 + .page/.pad/.sec）：与小程序端同一份 app.scss -->
    <link rel="stylesheet" href="./main.css" />
  </head>
  <body>
    <div id="preview-root" class="page-frame"></div>
    <script type="module" src="./preview.js"></script>
  </body>
</html>
`
}

console.log('预览产物 →', OUT)
