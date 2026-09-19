import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { defineConfig, type UserConfigExport } from '@tarojs/cli'

const contractsRoot = resolve(__dirname, '../../../packages/contracts')
const contractsRequire = createRequire(resolve(contractsRoot, 'package.json'))
const miniappRequire = createRequire(resolve(__dirname, '../package.json'))
const runtimeRequire = createRequire(miniappRequire.resolve('@tarojs/runtime'))

// https://docs.taro.zone/docs/config
export default defineConfig<'webpack5'>(async (merge) => {
  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'fish-miniapp',
    designWidth: 750,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2,
    },
    sourceRoot: 'src',
    outputRoot: 'dist',
    alias: {
      '@': resolve(__dirname, '..', 'src'),
    },
    /**
     * 构建期注入 API 绝对地址。
     *
     * 小程序没有 Vite 那样的同源代理，请求必须写绝对地址（`apps/web` 靠
     * `vite.config.ts` 的 `/api` 代理，小程序没有这一层）。所以后端域名只能在构建期
     * 由环境变量给进来：`TARO_APP_API_BASE=https://api.example.com bun run build:miniapp`。
     *
     * 未设置时注入空串，`src/lib/api-base.ts` 据此回落到本机 `http://localhost:3000`
     * —— 保持「不传也能在开发者工具里跑」的现状。
     *
     * 注：`defineConstants` 确实在 `@tarojs/service` 的白名单里
     * （`Config.js#getConfigWithNamed` 的 Object.assign 里列了它），写在顶层有效；
     * 与 `compile` 不同（那个必须写在 `mini` 层，见 README 第 1 节）。
     */
    defineConstants: {
      __API_BASE__: JSON.stringify(process.env.TARO_APP_API_BASE ?? ''),
      /**
       * 是否允许「真实接口失败 → 退回 mock fixture」（读取处 `src/features/fetchers.ts`）。
       *
       * 这是**开发 / 预览**的兜底，不是生产数据策略：生产下后端挂掉、域名配错或契约漂移时，
       * 用户必须看到错误态，而不是一批「看起来正常」的假商品。所以默认关，
       * 只在显式给 `TARO_APP_MOCK=1`（本地演示）或 `NODE_ENV=development` 时打开。
       *
       * `taro build` 走 production，因此 `bun run build:weapp` 默认**不退 mock**；
       * 想在开发者工具里看 mock 演示页，用 `TARO_APP_MOCK=1 bun run build:weapp`。
       */
      __ALLOW_MOCK_FALLBACK__: JSON.stringify(
        process.env.TARO_APP_MOCK === '1' || process.env.NODE_ENV === 'development',
      ),
    },
    framework: 'react',
    // 本地开发的依赖预编译（esbuild）会把 workspace 里以 TS 源码形式发布的包当成外部依赖处理，
    // 这里直接关闭，统一交给 webpack + babel-loader 处理，行为与生产构建保持一致。
    compiler: {
      type: 'webpack5',
      prebundle: { enable: false },
    },
    cache: {
      enable: false,
    },
    mini: {
      // monorepo：@fish/* 通过 workspace:* 链接，package.json 的 exports 直接指向 src/*.ts。
      // webpack 默认不编译 node_modules 下的文件，一旦有代码「值导入」契约（纯类型引用会在 babel
      // 阶段被抹掉，不受影响），TS 语法就会被 webpack 的 JS 解析器拒绝，报：
      //   ModuleParseError: Module parse failed: Unexpected token ... export type HealthResponse = ...
      // 所以这里把 contracts 的源码目录加进 babel-loader 的 include。
      //
      // 注意：@tarojs/service 只会把白名单字段与 `mini` / 平台（`weapp`）块合并进 runner 配置，
      // `compile` 写在顶层会被静默丢弃（runner 收到的 config.compile 为空），必须放在 mini 这一层。
      compile: {
        include: [
          resolve(contractsRoot, 'src'),
          // Zod 的发布产物含 class/const，Taro 默认只转译源码及自身依赖。
          dirname(contractsRequire.resolve('zod/package.json')),
          // tslib 的 ESM 默认导出含属性简写，开发构建也必须转译。
          dirname(runtimeRequire.resolve('tslib/package.json')),
        ],
      },
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false,
          config: {
            namingPattern: 'module',
            generateScopedName: '[name]__[local]___[hash:base64:5]',
          },
        },
      },
    },
  }

  return merge({}, baseConfig)
})
