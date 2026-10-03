import { VIEW_HISTORY_ROUTES } from '@fish/contracts/view-history/routes'
import {
  type ClearViewHistoryResponse,
  ClearViewHistoryResponseSchema,
  type MyViewHistoryResponse,
  MyViewHistoryResponseSchema,
} from '@fish/contracts/view-history/schema'
import { apiRequest } from '../../lib/api-client'

/** 浏览记录每页条数：契约默认 20、上限 50，端上取默认。 */
export const VIEW_HISTORY_PAGE_LIMIT = 20

export function myViewHistoryPath(input: { limit: number; cursor?: string }): string {
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor !== undefined) params.set('cursor', input.cursor)
  return `${VIEW_HISTORY_ROUTES.myViewHistory}?${params.toString()}`
}

/** 我的浏览记录（服务端按登录态判定账号，端上无法指定别人）。 */
export async function fetchMyViewHistory(input: {
  limit: number
  cursor?: string
}): Promise<MyViewHistoryResponse> {
  return MyViewHistoryResponseSchema.parse(await apiRequest(myViewHistoryPath(input)))
}

/**
 * 清空我的浏览记录（`DELETE`，服务端幂等）。
 *
 * 回的是**服务端删除行数**：端上据此刷新列表，不本地假清空；失败抛错由调用方渲染文案。
 */
export async function clearMyViewHistory(): Promise<ClearViewHistoryResponse> {
  return ClearViewHistoryResponseSchema.parse(
    await apiRequest(VIEW_HISTORY_ROUTES.myViewHistory, { method: 'DELETE' }),
  )
}
