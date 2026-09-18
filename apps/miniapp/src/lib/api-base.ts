/**
 * 小程序端 API 基地址。
 *
 * Web 端走同源 `/api` 前缀，由 Vite 代理去掉前缀转发到 API（`apps/web/vite.config.ts`）。
 * 小程序没有代理层，必须写**绝对地址**，所以这里单独抽一个常量，由构建期注入
 * （`config/index.ts` 的 `defineConstants`）。
 *
 * 注意路径语义：`packages/contracts/src/**\/routes.ts` 里的常量是 **API 侧根级路径**
 * （`/listings`、`/conversations`…），Vite 那层 `/api` 是浏览器前缀、不是 API 路径。
 * 所以小程序拼的是 `${API_BASE}${LISTING_ROUTES.base}`，**不要**再加 `/api`。
 */

/** 由构建期 `defineConstants` 注入；未注入时回落到本机 API（真机调试需改成局域网 IP）。 */
declare const __API_BASE__: string | undefined

export const API_BASE: string =
  typeof __API_BASE__ === 'string' && __API_BASE__.length > 0
    ? __API_BASE__
    : 'http://localhost:3000'
