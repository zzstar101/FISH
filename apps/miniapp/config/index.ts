import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { defineConfig, type UserConfigExport } from '@tarojs/cli'

const contractsRoot = resolve(__dirname, '../../../packages/contracts')
const sharedRoot = resolve(__dirname, '../../../packages/shared')
const contractsRequire = createRequire(resolve(contractsRoot, 'package.json'))
const sharedRequire = createRequire(resolve(sharedRoot, 'package.json'))
const typeidRequire = createRequire(sharedRequire.resolve('typeid-js'))
const miniappRequire = createRequire(resolve(__dirname, '../package.json'))
const runtimeRequire = createRequire(miniappRequire.resolve('@tarojs/runtime'))
// https://docs.taro.zone/docs/config
export default defineConfig<'webpack5'>(async (merge) => {
  /**
   * 演示兜底开关的**构建期**口径（两处注入点见下：这里的 alias 与
   * `defineConstants.__ALLOW_MOCK_FALLBACK__`，本次一起收窄成同一个表达式）：
   * **只认显式的 `TARO_APP_MOCK=1`**（本地演示），
   * 其余（含 `bun run build:weapp` 与 `bun run dev:weapp`）一律切掉。
   *
   * `NODE_ENV=development` 不再打开兜底（#304 / #182）。它此前是默认打开的那一支，
   * 而 dev 构建正是「接着真实后端联调」的构建：后端没起、断网或域名配错时，订单页会
   * 静默换成演示订单，那些订单带的是 `t-*` / `l-*` **假 id** —— 点「打开二维码」进真实
   * 面交页拿 404「找不到这笔交易」，点「查看会话」拿假 id 打真实会话接口。开发时想看
   * 演示数据就显式写 `TARO_APP_MOCK=1`：让「现在看的是假数据」由命令本身说清楚，
   * 而不是由构建模式替使用者决定。
   */
  const allowMockFallback = process.env.TARO_APP_MOCK === '1'

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
    /**
     * 演示兜底 fixture 的构建期切分，见 `src/features/mock-fallback.ts` 的文件头。
     *
     * `allowMockFallback` 为假时，把**精确路径** `@/features/mock-fallback` 指向零
     * `@/mock/*` 依赖的桩文件，于是整片演示 fixture（`mock/api` 及其 catalog /
     * chat / account / users / wishes / discover）根本不进生产包的模块图 —— 它们此前
     * 被 `features/fetchers.ts` 与 `custom-tab-bar/index.tsx` 的静态 import 拖进首屏
     * chunk 并在冷启动时求值（实测占首屏 JS 求值的约 90%）。
     *
     * **边界（别把话说满）**：仍有三个 fixture **叶子**模块被 mock 层之外的调用点
     * 静态引用，因此仍在产物里 —— `@/mock/blocks`（占位骨架，`features/listing/adapt.ts`
     * 等 5 处）、`@/mock/images`（演示图，`pages/sell/index.tsx`）、`@/mock/sell`
     * （AI 润色候选，`features/ai/api.ts`）。它们不 import `mock/api` 那一片，属于
     * 先于本改动存在的遗留项，由 `tests/mock-boundary.test.ts` 逐条登记并守住。
     *
     * ⚠️ **键序是语义的一部分**：`enhanced-resolve` 的 alias 按声明顺序匹配
     * （`AliasUtils.js` 的 `forEachBail`），前缀别名 `'@'` 会先把
     * `@/features/mock-fallback` 整个吃掉。所以这个精确别名必须写在 `'@'` **之前**；
     * Taro 的 `MiniCombination#getAlias` 用 `Object.assign` 合并，保留用户键序。
     * 生效与否以构建产物的 grep 为准，不能只看这段配置。
     */
    alias: {
      ...(allowMockFallback
        ? {}
        : {
            '@/features/mock-fallback': resolve(
              __dirname,
              '..',
              'src/features/mock-fallback.prod.ts',
            ),
          }),
      '@': resolve(__dirname, '..', 'src'),
    },
    /**
     * 构建期注入 API 绝对地址。
     *
     * 小程序没有 Vite 那样的同源代理，请求必须写绝对地址（PC Web 靠
     * `apps/web-pc/vite.config.ts` 的 `/api` 代理，小程序没有这一层）。所以后端域名只能在构建期
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
       * 这是**本地演示**的兜底，不是生产数据策略：生产下后端挂掉、域名配错或契约漂移时，
       * 用户必须看到错误态，而不是一批「看起来正常」的假商品。所以默认关，
       * 只在显式给 `TARO_APP_MOCK=1`（本地演示）时打开。
       *
       * `NODE_ENV=development` **不再**打开它（#304 / #182，口径见上面 `allowMockFallback`
       * 的说明）：dev 构建是联调构建，静默回退会把 `t-*` 假 id 漏进真实面交页 / 会话链路。
       *
       * `taro build` 走 production，因此 `bun run build:weapp` 默认**不退 mock**；
       * 想在开发者工具里看 mock 演示页，用 `TARO_APP_MOCK=1 bun run build:weapp`。
       */
      __ALLOW_MOCK_FALLBACK__: JSON.stringify(process.env.TARO_APP_MOCK === '1'),
      /**
       * 演示登录态（读取处 `src/features/auth/demo.ts`）：是否用一个**内置的演示账号**
       * 直接进入已登录态，让受限页在本地没有后端时也能打开。
       *
       * 收窄后它与 `__ALLOW_MOCK_FALLBACK__` **同源**（都只认 `TARO_APP_MOCK=1`，见上面
       * `allowMockFallback` / #304），但仍是**两个独立注入点**：H5 预览产物
       * （`preview/build.mjs`）按需分别注入这几个常量，而「进页面就当已登录」与
       * 「接口失败退 fixture」本来就是两件事 —— 谁需要谁显式打开。
       */
      __DEMO_AUTH__: JSON.stringify(process.env.TARO_APP_MOCK === '1'),
      /**
       * AI 润色的 mock 兜底门禁（读取处 `src/features/ai/api.ts`）。
       *
       * **只认显式的 `TARO_APP_MOCK=1`**，与 `__DEMO_AUTH__` 同形、同样不复用
       * `__ALLOW_MOCK_FALLBACK__`（#142 设计 §10.2）：润色失败会摆出本地假候选，而那些
       * 候选带着 `provider='stub'` 角标、与真实 stub 传输的候选长得一样，现场分不清
       * "接的是后端还是兜底"；这个开关宁可只跟显式演示命令绑定，也不要跟着别的开关被动打开。
       *
       * 且它只覆盖**传输层失败**（后端没起 / 断网）：服务端一旦给出错误信封，一律照常
       * 走真实错误 UI —— 否则 429 会一边倒计时一边摆假候选。
       */
      __DEMO_AI_POLISH__: JSON.stringify(process.env.TARO_APP_MOCK === '1'),
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
    /**
     * ## terser：刻意保持 Taro 默认值（不做覆盖）
     *
     * `MiniBaseConfig.js` 的 defaultTerserOptions 关掉了 17 项 compress pass。
     * 试过恢复其中 12 项，结论是**不做**：
     *
     * - **收益小**：A/B 实测（`rm -rf dist` 后同参数各构建一次）dist
     *   1,660,132 → 1,643,691 B，即 **16,441 B / 1.0%**；
     * - **风险不可验证**：这些 pass 会在 `define(...)` 工厂作用域里做跨语句 /
     *   跨函数的数据流改写（`reduce_vars` / `reduce_funcs` / `inline` /
     *   `collapse_vars` / `hoist_props`），而构建末尾的 `ES5 syntax verified`
     *   只查**语法**、不查语义；DevTools 里跑通 37 个路由的渲染，不等于覆盖了
     *   表单提交、聊天发送、上传等交互路径。Taro 为小程序 target 主动关掉它们，
     *   本身就是一份值得尊重的上游证据。
     *
     * 1.0% 的体积换一份说不清的风险不划算，等有真机全交互验证的渠道再谈。
     * 复核方式：把下面这 12 项加回 `terser.config.compress` 重跑构建，差值是 16 KB 量级
     * （Taro 默认关掉的 17 项里，`arrows` / `switches` / `toplevel` / `typeofs` /
     * `directives` 未试）：
     * `collapse_vars`、`comparisons`、`computed_props`、`hoist_funs`、`hoist_props`、
     * `hoist_vars`、`inline`、`loops`、`negate_iife`、`properties`、`reduce_funcs`、
     * `reduce_vars`。
     *
     * ## csso：只开两个无损的结构化优化
     *
     * csso 的默认预设把 5 个开关全关了
     * （`@tarojs/webpack5-runner/dist/webpack/BaseConfig.js` 的 defaultOption）。
     * `mergeRules`（合并相邻同声明规则）与 `minifySelectors`（选择器最简化）都不改变
     * 声明语义，同一台机器上 A/B 构建（同一提交、只切这两个开关）实测省 2.5 KB —— 相对
     * 安全，保留。这是那次对比的数字，不是稳定收益，换机器 / 换依赖后不必复现。
     */
    csso: {
      config: {
        mergeRules: true,
        minifySelectors: true,
      },
    },
    mini: {
      // monorepo：@fish/* 通过 workspace:* 链接，package.json 的 exports 直接指向 src/*.ts。
      // webpack 默认不编译 node_modules 下的文件，一旦有代码「值导入」契约（纯类型引用会在 babel
      // 阶段被抹掉，不受影响），TS 语法就会被 webpack 的 JS 解析器拒绝，报：
      //   ModuleParseError: Module parse failed: Unexpected token ... export type HealthResponse = ...
      // 所以这里把 contracts 与 mock ID 映射依赖的 shared 源码目录加进 babel-loader 的 include。
      //
      // 注意：@tarojs/service 只会把白名单字段与 `mini` / 平台（`weapp`）块合并进 runner 配置，
      // `compile` 写在顶层会被静默丢弃（runner 收到的 config.compile 为空），必须放在 mini 这一层。
      compile: {
        include: [
          resolve(contractsRoot, 'src'),
          resolve(sharedRoot, 'src'),
          dirname(sharedRequire.resolve('typeid-js')),
          // TypeID 的 uuid 依赖发布了未转译的默认参数，必须进入小程序 ES5 编译链。
          resolve(dirname(typeidRequire.resolve('uuid')), '..'),
          // Zod 的发布产物含 class/const，Taro 默认只转译源码及自身依赖。
          dirname(contractsRequire.resolve('zod/package.json')),
          // tslib 的 ESM 默认导出含属性简写，开发构建也必须转译。
          dirname(runtimeRequire.resolve('tslib/package.json')),
          // qrcode-generator（#114 面交二维码）的 ESM 产物含 const/let，必须转译。
          // 其 exports 不暴露 package.json，只能解析主入口再取目录。
          dirname(miniappRequire.resolve('qrcode-generator')),
        ],
      },
      /**
       * 图片不再无条件 base64 内联。Taro 默认 `limit` 走 IMAGE_LIMIT = 2 KiB
       * （`@tarojs/runner-utils/dist/constant.js`），小于 2 KiB 的图会被塞进 JS；
       * base64 比原始字节多约 33%（实测图标源 76,614 B → data URI 102,389 B）。
       * `limit: true` = maxSize 0 = 全部落盘成独立文件
       * （`@tarojs/webpack5-runner/dist/utils/webpack.js#getAssetsMaxSize`），主包净省约 25 KiB。
       */
      imageUrlLoaderOption: {
        limit: true,
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
