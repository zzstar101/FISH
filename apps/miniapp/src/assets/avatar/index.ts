/**
 * 头像资产的唯一出口（#618）：组件只从这里取，不直接 `import` 图片文件
 * （同 `assets/brand` 出口的约定，#513）。
 *
 * 这张图是 Owner 指定的默认头像插画（白发 Q 版女生抱鱼、蓝色圆形底），**不是生成物**：
 * 没有 `tools/` 下的母版与构建脚本，换图就是直接替换这个 png。
 * 圆外已按环形底色填平，所以圆形 / 圆角方形 / 方形头像位都不会露白角。
 *
 * 为什么小程序还要另存一份（PC 站用的是 `packages/ui/src/assets/avatar-default.png`）：
 * 小程序的资源必须落在 `apps/miniapp` 内由 Taro 打包，跨包引 png 走不通。
 */
export { default as DEFAULT_AVATAR } from './default@3x.png'
