/**
 * 浏览历史 API（#415 M1 落地的端点，契约见 `@fish/contracts/view-history`）。
 *
 * 只有一条路径、两个方法（`GET /me/view-history` 读 / `DELETE` 清空）：
 * 端上冻结的动作只有「清空」（Owner 2026-09-23 拍板），没有单条删除。
 * 整挂 `requireAuth`，列表响应的 `total` 是 **30 天窗口内的全量数**（不是这一页），
 * 与列表同一张表、同一个窗口 —— 数字必须同源，不能各算各的。
 *
 * 约定与 `features/favorites/api.ts` 一致：路径取契约常量，响应用 zod schema 收口。
 */

import { VIEW_HISTORY_ROUTES } from '@fish/contracts/view-history/routes'
import {
  ClearViewHistoryResponseSchema,
  type MyViewHistoryResponse,
  MyViewHistoryResponseSchema,
} from '@fish/contracts/view-history/schema'
import { apiRequest } from '@/lib/request'

/** 一页的条数。与收藏 / 我的评论同档：默认 20（契约上限 50）。 */
export const VIEW_HISTORY_PAGE_SIZE = 20

/** 拉一页浏览记录。`cursor` 是不透明串，只能原样回传上一页的 `nextCursor`。 */
export async function fetchMyViewHistory(args: {
  cursor?: string
  limit?: number
}): Promise<MyViewHistoryResponse> {
  const payload = await apiRequest(VIEW_HISTORY_ROUTES.myViewHistory, {
    query: { cursor: args.cursor, limit: args.limit ?? VIEW_HISTORY_PAGE_SIZE },
  })
  return MyViewHistoryResponseSchema.parse(payload)
}

/** 清空本人浏览记录。幂等：没有记录时 `deleted: 0` 也是成功。返回清掉的行数。 */
export async function clearMyViewHistory(): Promise<number> {
  const payload = await apiRequest(VIEW_HISTORY_ROUTES.myViewHistory, { method: 'DELETE' })
  return ClearViewHistoryResponseSchema.parse(payload).deleted
}
