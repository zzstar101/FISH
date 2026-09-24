/**
 * 本地图片文件的 mime 判定（纯逻辑，不 import Taro）。
 *
 * 为什么单独拆一个文件：`features/profile/avatar.ts`（头像编辑）也要用它 —— 微信
 * `getImageInfo` 拿不到格式时按后缀兜底。而它原来住在 `./api.ts` 里，那个模块会拉起
 * `@tarojs/taro` 运行时，纯逻辑一旦被牵连就再也不能在 bun 里测
 * （`ReferenceError: ENABLE_INNER_HTML is not defined`）。
 */
import type { ALLOWED_IMAGE_MIME } from '@fish/contracts/listings/schema'

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIME)[number]

const EXTENSION_MIME: Record<string, AllowedImageMime> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/**
 * 从本地临时路径推 mime。
 *
 * 小程序的 `chooseMedia` 只给 `fileType: 'image'`，没有 mime；契约的 presign 只收
 * `ALLOWED_IMAGE_MIME` 三个值，所以必须在这里收敛，否则请求会在 422 才失败。
 * 后缀不在表里（含 `.heic`）返回 `null`，由调用方给出明确文案。
 */
export function mimeFromPath(path: string): AllowedImageMime | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_MIME[ext] ?? null
}
