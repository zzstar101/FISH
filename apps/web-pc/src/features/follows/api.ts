import { FOLLOW_ROUTES } from '@fish/contracts/follows/routes'
import {
  type FollowState,
  FollowStateSchema,
  type MyFollowingResponse,
  MyFollowingResponseSchema,
} from '@fish/contracts/follows/schema'
import { UserIdSchema } from '@fish/contracts/system/public-id'
import { ApiError, apiRequest } from '../../lib/api-client'

/** 关注列表每页条数：契约默认 20、上限 50，端上取默认。 */
export const FOLLOWING_PAGE_LIMIT = 20

export function myFollowingPath(input: { limit: number; cursor?: string }): string {
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor !== undefined) params.set('cursor', input.cursor)
  return `${FOLLOW_ROUTES.myFollowing}?${params.toString()}`
}

/** 用户 id 是用户可见输入（路由参数），拼 URL 前先过契约校验，不合法直接当不存在。 */
export function followRelationPath(userId: string): string | null {
  if (!UserIdSchema.safeParse(userId).success) return null
  return FOLLOW_ROUTES.followRelation(userId)
}

export async function fetchMyFollowing(input: {
  limit: number
  cursor?: string
}): Promise<MyFollowingResponse> {
  return MyFollowingResponseSchema.parse(await apiRequest(myFollowingPath(input)))
}

export type FollowStateOutcome =
  | { kind: 'loaded'; following: boolean; mutual: boolean }
  | { kind: 'notFound' }
  | { kind: 'failed'; message: string }

function followErrorText(error: unknown): string {
  if (error instanceof ApiError && error.message.length > 0) return error.message
  return '网络异常，请稍后重试'
}

/**
 * 读与某人的关注状态。404 USER_NOT_FOUND 单独成 `notFound`（降级「无法关注」），
 * 与网络/服务端失败分开——后者保留重试，两种都不能让按钮假装成未关注可点。
 */
export async function fetchFollowState(userId: string): Promise<FollowStateOutcome> {
  const path = followRelationPath(userId)
  if (path === null) return { kind: 'notFound' }
  try {
    const state = FollowStateSchema.parse(await apiRequest(path))
    return { kind: 'loaded', following: state.following, mutual: state.mutual }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.code === 'USER_NOT_FOUND') {
      return { kind: 'notFound' }
    }
    return { kind: 'failed', message: followErrorText(error) }
  }
}

export type FollowWriteResult =
  | { kind: 'written'; following: boolean; mutual: boolean }
  | { kind: 'failed'; message: string }

/**
 * 关注/取关的失败都走这里：调用方以服务端结果为准，失败不改本地状态。
 * `CANNOT_FOLLOW_SELF`（422）也会落到 `failed`（端上不渲染自关注钮，这条是兜底）。
 */
async function writeFollow(userId: string, method: 'POST' | 'DELETE'): Promise<FollowWriteResult> {
  const path = followRelationPath(userId)
  if (path === null) return { kind: 'failed', message: '用户不存在或不可见' }
  try {
    const state: FollowState = FollowStateSchema.parse(await apiRequest(path, { method }))
    return { kind: 'written', following: state.following, mutual: state.mutual }
  } catch (error) {
    return { kind: 'failed', message: followErrorText(error) }
  }
}

export function requestFollow(userId: string): Promise<FollowWriteResult> {
  return writeFollow(userId, 'POST')
}

export function requestUnfollow(userId: string): Promise<FollowWriteResult> {
  return writeFollow(userId, 'DELETE')
}
