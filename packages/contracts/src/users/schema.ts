/**
 * User Domain 公开读模型契约（Issue #122）。
 *
 * 这是**他人主页**的读模型：任何登录 / 匿名用户都能看某一个 userId 公开出来的那一层。
 * 它**不是**认证域的 `Me`（`@fish/contracts/auth/user`）：`Me` 是「当前登录用户自己的」
 * 私有模型，两者字段边界不同，直接复用会把私有字段带进公开响应。因此本域独立定义。
 *
 * ## 写进契约的隐私边界（本 Issue 的验收核心）
 *
 * 公开 DTO **只有** `id / nickname / avatarUrl / authStatus / joinedDays / activeCount /
 * soldCount / presence` 八个字段（`presence` 是 #359 第五点新增的在线态，见
 * `UserPresenceSchema` 的 Owner 拍板记录）。以下字段**在任何情况下都不得出现在响应里**
 * （不是"当前没有数据所以为空"，而是**契约里根本没有这个字段**）：
 *
 * - `studentNo`（学号即账号）、`campusEmail`（校园认证绑定）、`passwordHash`、`role`
 *   —— 表里有，但永远不进公开 DTO；
 * - `campus`（校区）：#86（2026-09-22 产品冻结）后**产品整体不采集、不公开校区**，
 *   DB 列已删除，不存在任何「可见性偏好」语义——不是"暂缓公开"，是永久移除（#86 F 节）。
 * - `phone`（明文手机号）：服务端保存，任何 DTO 只出派生态（`auth/user.ts` 的
 *   `phoneBound` / `maskedPhone`），公开 DTO 两者皆不含。
 * - `goodRate`（好评率）：仓库没有 reviews / ratings 表，**没有真实口径**，不编造。
 *   `listing-detail` 对卖家好评率已经是「契约没有 → 传 null → 整行不渲染」的同款处理。
 * - `following`（是否已关注）：没有 follows 表，关注关系未拆 Domain，#122 明确不做。
 *
 * `joinedAt` 也不出：它和 `joinedDays` 是同一事实的两种表达，两个字段必然漂移。
 * 口径由服务端固定，端上不再自己算（见 `joinedDays` 注释）。
 */
import { AuthStatusSchema } from '@fish/contracts/auth/user'
import {
  type ListingFeedResponse,
  ListingFeedResponseSchema,
} from '@fish/contracts/listings/schema'
import { z } from 'zod'
import { UserIdSchema } from '../system/public-id'

/**
 * 用户 id。路由层的路径参数校验也用它 —— 非法 uuid 在被绑到 `users.id`（uuid 列）之前
 * 就要挡住，否则驱动会抛 `invalid input syntax for type uuid` 变成 500，
 * 而本域的契约是「非法 uuid 与不存在都是 404」（与 `listings` 的 `ListingIdSchema` 同款用途）。
 */
export const PublicUserIdSchema = UserIdSchema

export type PublicUserId = z.infer<typeof PublicUserIdSchema>

/**
 * 在线判定窗口（#359 第五点）：`now - lastActiveAt < PRESENCE_ONLINE_TTL_MS` 即在线。
 *
 * 服务端按它算 `UserPresence.online`；**客户端也拿同一个常量**把在线态在本地过期
 * （实时事件只在「变在线」时推，见 `chat/schema.ts` 的 `presence.changed`），
 * 两端的窗口必须同源，否则会出现「服务端说离线、客户端还画着绿点」。
 */
export const PRESENCE_ONLINE_TTL_MS = 60_000

/**
 * 用户在线态（#359 第五点）。
 *
 * 口径：**已认证活动 + TTL**，不是「WebSocket 连接还在不在」—— 小程序端当前没有
 * 实时客户端（#213→#220 链未合入 main），若只认 WS 连接，端上永远没有人在线。
 * 所以服务端把「最近一次已认证活动」（HTTP 请求或 WS 心跳）记进进程内的登记表，
 * `online = 最近活动在 TTL 窗口内`。
 *
 * 两个字段的取值语义：
 * - `online`：服务端**读取这一刻**的判定结果（活动窗口内）；
 * - `lastActiveAt`：最后一次已认证活动的时刻（ISO，**在线时也照给**，客户端据此
 *   在本地越过 TTL 后自行翻成离线）；服务端自本次进程启动以来没见过该用户活动时为
 *   `null`（进程重启会丢掉登记表，见 `apps/api/src/modules/presence/presence.ts`），
 *   此时客户端的降级文案是「离线」，不编造一个「最后活跃」时刻。
 *
 * 隐私边界（Owner 2026-09-30 拍板）：在线态**给他人看**——他人主页与商品详情的卖家行
 * 都要显示（#359 第五点的三处展示位）。因此它是公开读模型的一部分，匿名访客也能读到。
 * 这一条是产品决策，不是实现泄漏；若要收回到「仅登录用户可见」，改动点是服务端在
 * 匿名视角把 `presence` 恒置 `{ online: false, lastActiveAt: null }` 并同步本注释。
 */
export const UserPresenceSchema = z.object({
  online: z.boolean(),
  lastActiveAt: z.iso.datetime().nullable(),
})

export type UserPresence = z.infer<typeof UserPresenceSchema>

/**
 * 公开用户资料。
 *
 * `avatarUrl` 与 `MeSchema` 同口径用 `z.url().nullable()`：库里是**无约束 text**，
 * 历史脏值由服务端降级为 `null`，不让一个人的脏头像把整页打成 500。
 */
export const PublicUserProfileSchema = z.object({
  id: PublicUserIdSchema,
  nickname: z.string(),
  avatarUrl: z.url().nullable(),
  authStatus: AuthStatusSchema,
  /**
   * 加入天数（服务端算，下限 1）。
   *
   * 口径：`max(1, floor((now - created_at) / 86400000))`——按**已过的 24 小时整数倍**取整，
   * 而不是日历日差：仓库里既有的时间判断全是 elapsed 差值语义（`transactions` 的
   * `lockedUntil`、`wishes` 的 `poolCache.expiresAt`），没有任何服务端时区约定
   * （全仓无 `Asia/Shanghai` / `TZ`），按日历日算就必须先引入一个"服务端时区"。
   *
   * 下限 1 是刻意的：注册当天不能显示「加入 0 天」。
   * 副作用（明确接受）：满 24 小时不涨，满 48 小时才从 1 变 2，即「N 天」表示
   * `[ (N-1)*24h, N*24h )` 之外的滞后一天区间——它是"加入满几天"的保守下界，不会虚报。
   */
  joinedDays: z.number().int().min(1),
  /** 在售商品数（`listings.status = 'ACTIVE'` 且 seller 是 TA）；服务端 COUNT。 */
  activeCount: z.number().int().nonnegative(),
  /**
   * 卖出的件数（`transactions.status = 'COMPLETED'` 且 seller 是 TA）。
   *
   * 注意与 `profile` 域「我发布的商品」不是同一个数：那边是**历史发布总数**，
   * 这里是**成交数**。页面上写「卖出」就该用这个。
   */
  soldCount: z.number().int().nonnegative(),
  /**
   * 在线态（#359 第五点）。他人主页的头像右侧要显示它；商品详情页的卖家行复用同一个
   * 端点（`GET /users/:id/public`）拿到的这份值，因此两屏不可能各说各话。
   *
   * 公开可见是刻意的（见 `UserPresenceSchema` 的隐私边界注记）。
   */
  presence: UserPresenceSchema,
})

export type PublicUserProfile = z.infer<typeof PublicUserProfileSchema>

/**
 * `GET /users/:userId/listings` 的查询参数。
 *
 * 只接受 `limit` / `cursor`：`sellerId` 由路径参数蕴含，`status` 恒为 `ACTIVE`
 * （公开在售列表不允许出现 OFFLINE / RESERVED / SOLD），所以这两个参数**不允许**出现
 * ——`strictObject` 会把它们当非法参数报 422，而不是静默忽略后再悄悄放宽过滤。
 *
 * `limit` 的边界与公开 Feed（`ListingFeedQuerySchema`）逐字相同：默认 20、上限 50。
 */
export const PublicUserListingsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** 不透明字符串：服务端对 `(created_at, id)` 编码，前端禁止解析或构造，只原样回传。 */
  cursor: z.string().min(1).optional(),
})

export type PublicUserListingsQuery = z.infer<typeof PublicUserListingsQuerySchema>

/**
 * 在售列表的响应体：**直接复用**公开 Feed 的 `ListingFeedResponseSchema`
 * （`{ items: ListingCard[], nextCursor }`），不另立一份同形 schema。
 *
 * 复用而不是自建的理由：`ListingCard` 的字段（含封面 URL 的拼法）与 feed 必须完全一致，
 * 两份 schema 会漂移；游标语义（`nextCursor !== null` 即还有下一页）也必须同源。
 * 本域只负责"查谁 + 只查 ACTIVE"，投影与分页口径归 listings 域。
 */
export const PublicUserListingsResponseSchema = ListingFeedResponseSchema

export type PublicUserListingsResponse = ListingFeedResponse

/**
 * 本域的错误码值域（路由层据此收窄，见 `UserServiceError`）。
 *
 * `USER_NOT_FOUND` 同时覆盖两种输入：**非法 uuid 的路径参数**与**合法但不存在 / 不可见
 * 的用户**。不区分是刻意的——与 `listings` 的 `LISTING_NOT_FOUND`（「商品不存在**或不可见**」）
 * 同一取舍：这条路径任何匿名请求都能稳定触发，区分「格式错」与「不存在」等于给出一份
 * 用户 id 空间的探针。
 */
export const UserErrorCodeSchema = z.enum(['USER_NOT_FOUND'])

export type UserErrorCode = z.infer<typeof UserErrorCodeSchema>
