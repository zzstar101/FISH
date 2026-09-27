import { encodePublicId, type PublicIdPrefix } from '@fish/shared/public-id'

/**
 * 仅供离线演示 fixture 使用：把旧版 mock 键稳定地映射为规范公开 ID。
 * 真实 API 返回的 ID 必须原样使用，绝不经此函数改写或在客户端编解码。
 */
export function mockPublicId<P extends PublicIdPrefix>(prefix: P, key: string): `${P}_${string}` {
  let hash = 2166136261
  for (let i = 0; i < key.length; i += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0
  }
  const uuid = `01930000-0000-7000-8000-${hash.toString(16).padStart(12, '0')}`
  return encodePublicId(prefix, uuid)
}
