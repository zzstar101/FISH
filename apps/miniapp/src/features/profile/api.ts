/**
 * 个人中心域 API。
 *
 * P0 只有「我自己的聚合视图」一个端点（`profile/routes.ts`）：一次请求拿到
 * user + stats + listings + wishes + transactions，个人中心整页只需要这一次调用。
 * 他人主页（P1）不在契约内。
 */
import { PROFILE_ROUTES } from '@fish/contracts/profile/routes'
import { type ProfileResponse, profileResponseSchema } from '@fish/contracts/profile/schema'
import { apiRequest } from '@/lib/request'

/** 必须登录；未登录 401 UNAUTHENTICATED */
export async function fetchProfile(): Promise<ProfileResponse> {
  const payload = await apiRequest(PROFILE_ROUTES.me)
  return profileResponseSchema.parse(payload)
}
