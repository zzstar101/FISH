import { AuthStatusSchema } from '@fish/contracts/auth/user'
import { z } from 'zod'
import { UserIdSchema } from '../system/public-id'

/**
 * Follow Domain Contract（Issue #188）。前端与 API 只依赖本目录的字段定义。
 *
 * 表结构由 #287 落地（`packages/db/src/schema/follows.ts`），本域**不新增任何表/列**：
 * 有向关系 `follower_id → following_id`，三条不变量（唯一约束 / 禁止自关注 CHECK /
 * 双向游标索引）都在 DB 层兜底。
 *
 * ## 公开投影：复用用户域的公开字段子集，不按列表逐人回查（无 N+1）
 *
 * 列表行只出 `id / nickname / avatarUrl / authStatus` 四样——与 `users/schema.ts` 的
 * `PublicUserProfileSchema` 同一隐私边界（无学号 / 校区 / 教育邮箱 / 手机号 / role /
 * 微信平台标识），但**不复用整份 `PublicUserProfileSchema`**：那份还带 `joinedDays` /
 * `activeCount` / `soldCount`，每个都要额外 COUNT，在关注列表里就是 N+1。
 *
 * 行上唯一的关系字段是 `mutual`（是否互相关注），由服务端按反向关系算（一条 EXISTS，
 * 不是端上两两比对）。`following` 不必出：列表里的每一行按定义都是「我关注的」。
 */

/** 关注列表的一行：公开用户子集 + 关系字段。 */
export const FollowedUserSchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
  /** 无约束 text 的历史脏值由服务端降级为 `null`（与用户域 / comments 同一取舍）。 */
  avatarUrl: z.url().nullable(),
  authStatus: AuthStatusSchema,
  /** 互相关注（双向关系）。服务端真值，端上不重算、不缓存成可见状态。 */
  mutual: z.boolean(),
})

export type FollowedUser = z.infer<typeof FollowedUserSchema>

/**
 * `GET /me/following` 的查询参数。
 *
 * 只接受 `limit` / `cursor`：`followerId` 由登录态决定，端上无法指定别人的列表，
 * 所以它是 `strictObject` 而不是「多传就忽略」——多传未知参数报 422，把越权尝试暴露出来。
 * `limit` 边界与公开 Feed / 公开用户列表逐字相同：默认 20、上限 50。
 */
export const MyFollowingQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 不透明字符串：服务端对 `(created_at, 用户 id)` 编码，前端禁止解析或构造，只原样回传。 */
  cursor: z.string().min(1).optional(),
})

export type MyFollowingQuery = z.infer<typeof MyFollowingQuerySchema>

/**
 * 关注列表响应。
 *
 * `total` / `mutualTotal` 是**全量**计数（服务端 COUNT，与列表同一份关系数据）：
 * 页面顶部「关注 N 人 · 互粉 M 人」不能拿分页列表的长度冒充总数——只加载了一页时
 * 那个数字会随滚动跳动，是错的。`nextCursor !== null` 即还有下一页（与 feed 同语义）。
 */
export const MyFollowingResponseSchema = z.object({
  items: z.array(FollowedUserSchema),
  nextCursor: z.string().nullable(),
  /** 我关注的总人数。 */
  total: z.number().int().nonnegative(),
  /** 其中互相关注的人数。 */
  mutualTotal: z.number().int().nonnegative(),
})

export type MyFollowingResponse = z.infer<typeof MyFollowingResponseSchema>

/**
 * 关注关系状态（`GET /users/:userId/follow` 与两个写接口的响应共用）。
 *
 * `mutual = following && 对方也关注我`：取关后必然为 `false`，所以 `DELETE` 的响应恒为
 * `{ following: false, mutual: false }`。写接口回状态而不是 204，是为了让端上**直接采用
 * 服务端结论**（成功以服务端为准），不必本地翻转再自己猜 mutual。
 */
export const FollowStateSchema = z.object({
  following: z.boolean(),
  mutual: z.boolean(),
})

export type FollowState = z.infer<typeof FollowStateSchema>

/**
 * 本 domain 的错误码。其余复用 system 的 `VALIDATION_FAILED`（422）与 auth 的
 * `UNAUTHENTICATED`（401）。
 */
export const FollowErrorCodeSchema = z.enum([
  /**
   * 404：目标用户不存在，**或**路径参数不是规范的用户 Public ID。两者同码同文案——
   * 与 `users` 域同一取舍：这条路径任何登录用户都能稳定触发，区分「格式错」与
   * 「不存在」等于给出一份用户 id 空间的探针。
   */
  'USER_NOT_FOUND',
  /**
   * 422：不能关注自己。DB 有 `follows_no_self_follow` CHECK 兜底，但那会抛
   * 23514 变成 500；写入前显式判掉才给得出稳定的 422。
   */
  'CANNOT_FOLLOW_SELF',
])

export type FollowErrorCode = z.infer<typeof FollowErrorCodeSchema>
