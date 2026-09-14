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
      },
    ],
  ],
}
