/**
 * 浏览记录 API（契约见 `@fish/contracts/view-history`，#415 M1 上线）。
 *
 * 约定与其余域模块一致（先例 `features/favorites/api.ts`）：路径取自契约常量
 * （不硬编码字符串），响应一律用契约 zod schema 收口 —— 形状漂移在解析处就炸，
 * 而不是渲染到页面上才炸。
 *
 * ## 两条路径的语义
 *
 * - `GET /me/view-history`：我的浏览记录，`(last_viewed_at, 商品 id)` 倒序、不透明游标分页。
 *   要登录（未登录 401 `UNAUTHENTICATED`）。响应 `{ items, nextCursor, total }`，
 *   `total` 是**30 天窗口内的全量计数**（不是这一页）——「我的」页数字栏与列表同源读它。
 * - `DELETE /me/view-history`：清空本人浏览记录，**幂等**（没有记录时 `deleted: 0` 也是成功），
 *   回 `{ deleted }` 而不是 204。端上**以服务端为准**：清空成功只有 `deleted` 回来，
 *   列表的下一次真相仍以重新取的第一页为准，不做任何本地翻转。
 */
import { VIEW_HISTORY_ROUTES } from '@fish/contracts/view-history/routes'
import {
  type ClearViewHistoryResponse,
  ClearViewHistoryResponseSchema,
  type MyViewHistoryResponse,
  MyViewHistoryResponseSchema,
} from '@fish/contracts/view-history/schema'
import { apiRequest } from '@/lib/request'

/**
 * 一页浏览记录的条数。契约 `MyViewHistoryQuerySchema` 的上限是 50，
 * 这里取默认档 20（与收藏页同一档）：历史页是「按天翻着看」的列表，
 * 首屏 20 条足够，也让游标分页的「加载更多」不至于太碎。
 */
const PAGE_SIZE = 20

/** 拉一页我的浏览记录。`cursor` 只能原样回传上一页的 `nextCursor`（契约禁止前端解析或构造）。 */
export async function fetchMyViewHistory(
  params: { limit?: number; cursor?: string } = {},
): Promise<MyViewHistoryResponse> {
  const payload = await apiRequest(VIEW_HISTORY_ROUTES.myViewHistory, {
    query: { limit: params.limit ?? PAGE_SIZE, cursor: params.cursor },
  })
  return MyViewHistoryResponseSchema.parse(payload)
}

/** 清空我的浏览记录（幂等，回 `{ deleted }`；重复清空不报错）。 */
export async function clearMyViewHistory(): Promise<ClearViewHistoryResponse> {
  const payload = await apiRequest(VIEW_HISTORY_ROUTES.myViewHistory, { method: 'DELETE' })
  return ClearViewHistoryResponseSchema.parse(payload)
}
