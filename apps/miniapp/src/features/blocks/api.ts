/**
 * 拉黑关系的 API（Issue #466 端上批次 / #473）。
 *
 * 路径一律取自契约常量（`@fish/contracts/blocks/routes`），不硬编码字符串；
 * 响应一律用契约 schema 收口，形状漂移在解析处就炸，而不是渲染到页面上才炸。
 *
 * **没有 mock 回退**（同 `features/following/api.ts` 的口径）：拉黑是「我」与某个人的
 * 有向边，读与写都要求登录，演示构建下没有可扮演的身份 —— 页面在 demo 构建里会如实
 * 进错误/空态，不做假数据。
 *
 * **守卫在服务端**：拉黑后发送 / 建会话的 403 `CONVERSATION_UNAVAILABLE` 由 chat 域的
 * 描述函数与 conversation 页兜中性文案（见 `features/chat/api.ts` 与会话页的接线），
 * 本文件不管。
 */
import { BLOCK_ROUTES } from '@fish/contracts/blocks/routes'
import {
  type BlockState,
  BlockStateSchema,
  type MyBlocksResponse,
  MyBlocksResponseSchema,
} from '@fish/contracts/blocks/schema'
import { apiRequest } from '@/lib/request'

/** 黑名单每页条数：契约默认 20、上限 50，端上取默认（与 following 同档）。 */
export const BLOCKS_PAGE_SIZE = 20

/**
 * 我拉黑的人一页（`GET /me/blocks`，`created_at DESC` 游标分页）。
 * 只列**我拉黑的**——「谁拉黑了我」契约上没有读取路径，被拉黑不是可探测状态。
 * 未登录 → 401 `UNAUTHENTICATED`，由调用方分支。
 */
export async function fetchMyBlocks(cursor?: string): Promise<MyBlocksResponse> {
  const payload = await apiRequest(BLOCK_ROUTES.myBlocks, {
    query: { limit: BLOCKS_PAGE_SIZE, cursor },
  })
  return MyBlocksResponseSchema.parse(payload)
}

/**
 * 我与某人的拉黑状态（`GET /users/:userId/block`）。
 * 404 `USER_NOT_FOUND` = 目标不存在**或**路径不是规范 Public ID（同码），由调用方分支。
 */
export async function fetchBlockState(userId: string): Promise<BlockState> {
  const payload = await apiRequest(BLOCK_ROUTES.blockRelation(userId))
  return BlockStateSchema.parse(payload)
}

/**
 * 拉黑 / 解除（`POST` / `DELETE` 同一路径）。幂等：重复拉黑 / 重复解除都是 200。
 *
 * 回包是服务端算出的**关系真值**，调用方直接采用它，不要本地翻转：
 * 「成功以服务端为准」是 #466 验收条目（关注钮同款取舍）。
 */
export async function setBlock(userId: string, blocked: boolean): Promise<BlockState> {
  const payload = await apiRequest(BLOCK_ROUTES.blockRelation(userId), {
    method: blocked ? 'POST' : 'DELETE',
  })
  return BlockStateSchema.parse(payload)
}
