import type { HealthResponse } from '@fish/contracts/system/health'

// 第一阶段只验证 workspace 包复用，不接入任何业务契约、不发任何网络请求。
//
// 这里刻意只做「类型引用」：`@fish/contracts` 的 exports 直接指向 src/*.ts，类型引用同样要求
// TypeScript 解析到 packages/contracts/src/**，足以证明 workspace 包被正确解析；
// 同时它不产生任何运行时代码 —— 值导入会把 zod 一并打进产物（实测 vendors.js 8KB → 99KB），
// 骨架阶段没有必要付这个体积，所以 monorepo 的 bundler 配置只在真正值导入契约时才需要生效
// （见 config/index.ts 中 mini.compile.include 的说明）。
export type BackendStatus = HealthResponse['status']

/** 开发占位状态：类型来自后端契约，产物里只是一个普通字符串。 */
export const BACKEND_STATUS: BackendStatus = 'ok'
