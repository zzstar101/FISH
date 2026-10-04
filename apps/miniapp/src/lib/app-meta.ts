/**
 * App 版本元信息（真实的构建期常量，不是演示数据）。
 *
 * 为什么从 `mock/account.ts` 挪出来：「关于」页与设置页要显示版本号，而这两个页面
 * 在真实构建下也不该为了两个字符串去静态 import 整包 fixture（`mock/account.ts`
 * 里还有订单、认证、设置项等一大堆演示数据）。`mock/account.ts` 仍 re-export 这两个
 * 名字，既有 `@/mock/api` 的 import 路径不受影响。
 */

export const APP_VERSION = '1.4.0'
export const APP_BUILD = '20260916'
