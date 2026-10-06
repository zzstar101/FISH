import { AuthStatusSchema } from '@fish/contracts/auth/user'
import { z } from 'zod'
import { UserIdSchema } from '../system/public-id'

/**
 * Block Domain Contract（Issue #466）。前端与 API 只依赖本目录的字段定义。
 *
 * 表结构：`packages/db/src/schema/blocks.ts` 的 `user_blocks`（有向关系
 * `blocker_id → blocked_id`）。三条不变量都在 DB 层兜底：
 * - `unique(blocker_id, blocked_id)`：重复拉黑靠 ON CONFLICT DO NOTHING 幂等；
 * - `check(blocker_id <> blocked_id)`：自拉黑在写入侧就不可表达（服务层显式 422）；
 * - `(blocker_id, created_at, id)` 游标索引服务「我的黑名单」列表。
 *
 * ## 公开投影：follows 同款公开子集，不逐人回查（无 N+1）
 *
 * 列表行只出 `id / nickname / avatarUrl / authStatus` 四样——与 `follows/schema.ts`
 * 同一隐私边界（无学号 / 校区 / 教育邮箱 / 手机号 / role）。列表里唯一的关系字段是
 * `blockedAt`（我拉黑 TA 的时刻），按定义每一行都是「我拉黑的」，不提供反向列表。
 */

/** 黑名单列表的一行：公开用户子集 + 关系时间。 */
export const BlockedUserSchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
  /** 无约束 text 的历史脏值由服务端降级为 `null`（与用户域 / follows 同一取舍）。 */
  avatarUrl: z.url().nullable(),
  authStatus: AuthStatusSchema,
  /** 我拉黑 TA 的时刻（ISO 8601）。管理页展示用，不参与任何守卫判定。 */
  blockedAt: z.iso.datetime(),
})

export type BlockedUser = z.infer<typeof BlockedUserSchema>

/** `GET /me/blocks` 的查询参数。`strictObject`：多传未知参数报 422（follows 同款）。 */
export const MyBlocksQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 不透明字符串：服务端对 `(created_at, 用户 id)` 编码，前端只原样回传。 */
  cursor: z.string().min(1).optional(),
})

export type MyBlocksQuery = z.infer<typeof MyBlocksQuerySchema>

/** 黑名单列表响应。`nextCursor !== null` 即还有下一页（与 feed / follows 同语义）。 */
export const MyBlocksResponseSchema = z.object({
  items: z.array(BlockedUserSchema),
  nextCursor: z.string().nullable(),
})

export type MyBlocksResponse = z.infer<typeof MyBlocksResponseSchema>

/**
 * 拉黑关系状态（`GET /users/:userId/block` 与两个写接口的响应共用）。
 *
 * 写接口回状态而不是 204，端上直接采用服务端结论（follows 同款取舍）。
 */
export const BlockStateSchema = z.object({
  blocked: z.boolean(),
})

export type BlockState = z.infer<typeof BlockStateSchema>

/**
 * 本 domain 的错误码。其余复用 system 的 `VALIDATION_FAILED`（422）与 auth 的
 * `UNAUTHENTICATED`（401）。
 */
export const BlockErrorCodeSchema = z.enum([
  /**
   * 404：目标用户不存在，**或**路径参数不是规范的用户 Public ID。同码同文案——
   * 与 follows / users 域同一取舍：不给 id 空间留探针。
   */
  'USER_NOT_FOUND',
  /**
   * 422：不能拉黑自己。DB 有 `user_blocks_no_self_block` CHECK 兜底，但那会抛
   * 23514 变成 500；写入前显式判掉才给得出稳定的 422。
   */
  'CANNOT_BLOCK_SELF',
])

export type BlockErrorCode = z.infer<typeof BlockErrorCodeSchema>
