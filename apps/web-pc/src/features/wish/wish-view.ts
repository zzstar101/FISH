import { ApiError } from '../../lib/api-client'

/** 愿望详情的 404：不存在与「不是你的」同码（owner-scoped 读模型的既定口径）。 */
export function isWishNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404
}
