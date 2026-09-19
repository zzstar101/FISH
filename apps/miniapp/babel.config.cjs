// babel-preset-taro 的选项与默认值：https://docs.taro.zone/docs/next/babel-config
// 用 .cjs 是因为本包 package.json 声明了 "type": "module"，而 babel 的 root config 必须是 CJS。
module.exports = {
  presets: [
    [
      'taro',
      {
        framework: 'react',
        ts: true,
        compiler: 'webpack5',
        // 微信小程序真机运行时需要比 Web 端 browserslist 更保守的目标。
        // 依赖也需纳入 mini.compile.include，最终产物由 check:es5 验证。
        targets: {
          ios: '9',
          android: '5',
        },
        ignoreBrowserslistConfig: true,
      },
    ],
  ],
}
