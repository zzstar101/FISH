import { resolve } from 'node:path'
import { defineConfig, type UserConfigExport } from '@tarojs/cli'

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
        include: [resolve(__dirname, '../../../packages/contracts/src')],
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
