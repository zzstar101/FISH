/**
 * 头像 / 昵称编辑的纯逻辑（#86 B 线）。
 *
 * 这里**不 import Taro**：页面负责平台层（`chooseAvatar` 回调、`getImageInfo`、读文件大小），
 * 本模块只做三件能在 bun 里直接测的事 —— 判 mime、校验昵称、决定这次要不要发请求。
 */
import type { ProfileUpdateRequest } from '@fish/contracts/profile/schema'
import { type AllowedImageMime, mimeFromPath } from '@/features/upload/mime'

/** 契约 `NicknameSchema` = trim 后 1–20 字；前端只做预检，服务端才是权威。 */
export const NICKNAME_MAX = 20

/**
 * 微信 `getImageInfo` 回的图片格式 → 契约白名单 mime。
 *
 * 为什么不信路径后缀：`chooseAvatar` 给的是**临时文件**，真机上常见没有后缀的名字，
 * 按后缀判会把合法头像误报成「格式不支持」。后缀只在拿不到 `getImageInfo.type` 时兜底。
 */
const MIME_BY_IMAGE_TYPE: Record<string, AllowedImageMime> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

export function mimeFromImageType(type: string | null | undefined): AllowedImageMime | null {
  if (!type) return null
  return MIME_BY_IMAGE_TYPE[type.trim().toLowerCase()] ?? null
}

/** 头像 mime：优先系统给的格式，拿不到再按后缀兜底，都不认返回 `null`（页面给明确文案）。 */
export function avatarMime(type: string | null | undefined, path: string): AllowedImageMime | null {
  return mimeFromImageType(type) ?? mimeFromPath(path)
}

/** 昵称预检：返回文案即不合法，`null` 即可以提交（服务端仍会再校验一次）。 */
export function nicknameError(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return '请输入昵称'
  if (trimmed.length > NICKNAME_MAX) return `昵称最多 ${NICKNAME_MAX} 个字`
  return null
}

/**
 * 这次保存要发什么。
 *
 * - 昵称 trim 后与当前一致就不带它；没选新头像（`avatarObjectKey` 为 `null`）也不带它；
 * - 两者都没有 → 返回 `null`：页面提示「没有需要保存的修改」，而不是发一个**必然 422**
 *   的空对象（契约 `profileUpdateRequestSchema` 明确拒绝空对象）。
 */
export function profileUpdateBody(
  originalNickname: string,
  draft: { nickname: string; avatarObjectKey: string | null },
): ProfileUpdateRequest | null {
  const body: ProfileUpdateRequest = {}
  const nickname = draft.nickname.trim()
  if (nickname !== originalNickname) body.nickname = nickname
  if (draft.avatarObjectKey) body.avatarObjectKey = draft.avatarObjectKey
  return body.nickname === undefined && body.avatarObjectKey === undefined ? null : body
}
