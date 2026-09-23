/**
 * 个人中心域 API。
 *
 * P0 只有「我自己的聚合视图」一个端点（`profile/routes.ts`）：一次请求拿到
 * user + stats + listings + wishes + transactions，个人中心整页只需要这一次调用。
 * 他人主页（P1）不在契约内。
 *
 * #86 B 起多一个**写**端点：同一个 `/profile` 的 PATCH（编辑昵称 / 头像）。
 */
import type { Me } from '@fish/contracts/auth/user'
import { PROFILE_ROUTES } from '@fish/contracts/profile/routes'
import {
  type ProfileResponse,
  type ProfileUpdateRequest,
  profileResponseSchema,
  profileUpdateResponseSchema,
} from '@fish/contracts/profile/schema'
import { apiRequest } from '@/lib/request'

/** 必须登录；未登录 401 UNAUTHENTICATED */
export async function fetchProfile(): Promise<ProfileResponse> {
  const payload = await apiRequest(PROFILE_ROUTES.me)
  return profileResponseSchema.parse(payload)
}

/**
 * 编辑资料（#86 B）：改昵称 / 换头像，返回**更新后**的 `Me`。
 *
 * 头像传的是上传链拿到的 `objectKey`，不是 URL —— 服务端拿它去对象存储复核归属与格式，
 * 端上塞任意外链会被 422 `IMAGE_REFERENCE_INVALID` 挡掉（见契约 `profileUpdateRequestSchema`）。
 */
export async function updateProfile(input: ProfileUpdateRequest): Promise<Me> {
  const payload = await apiRequest(PROFILE_ROUTES.me, { method: 'PATCH', body: input })
  return profileUpdateResponseSchema.parse(payload).user
}
