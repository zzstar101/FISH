import { MeSchema } from '@fish/contracts/auth/user'
import { ListingCardSchema } from '@fish/contracts/listings/schema'
import { wishDtoSchema } from '@fish/contracts/wishes/schema'
import { z } from 'zod'

/**
 * Profile Domain Contract（Issue #12）。前端和 API 只依赖本目录的字段定义。
 *
 * 复用而非重写：user 块是认证域的 `Me`（requireAuth 已写入 context，campus 的脏值
 * 回退逻辑不复制第二份）；商品卡是 #6 的 `ListingCardSchema`（本人视角可见全部状态）；
 * 愿望是 #7 的 `wishDtoSchema`。交易摘要是本域的投影——#11 的契约尚未合并，字段刻意
 * 最小（详情跳交易详情页），待 `@fish/contracts/transactions` 合并后迁移为 `.pick()`。
 */

export const profileTransactionStatusSchema = z.enum(['PENDING_MEETUP', 'COMPLETED', 'CANCELLED'])
export type ProfileTransactionStatus = z.infer<typeof profileTransactionStatusSchema>

export const profileTransactionSchema = z.object({
  id: z.string(),
  listingId: z.string(),
  /** 查看者在交易中的角色（买入 / 卖出列表合并返回，前端据此分组）。 */
  role: z.enum(['buyer', 'seller']),
  amountCents: z.number().int().nonnegative(),
  status: profileTransactionStatusSchema,
  createdAt: z.iso.datetime(),
})
export type ProfileTransaction = z.infer<typeof profileTransactionSchema>

export const profileStatsSchema = z.object({
  /** 在售商品数（listings.status = ACTIVE 且 seller 是我）。 */
  activeListings: z.number().int().nonnegative(),
  /** 活跃愿望数（wishes.status = ACTIVE 且 user 是我）。 */
  activeWishes: z.number().int().nonnegative(),
  /** 完成交易数（买卖两个角色合并计）。 */
  completedTransactions: z.number().int().nonnegative(),
  // 「买入 / 卖出条数」刻意不设计数：由前端对 transactions[] 按 role 分组得到。
  // 该列表封顶 100（见 profileResponseSchema 注释），计数在封顶内准确——超出属于
  // demo 数据量之外的规模，届时应扩独立分页端点而不是在 stats 里加 COUNT。
})
export type ProfileStats = z.infer<typeof profileStatsSchema>

export const profileResponseSchema = z.object({
  /** 认证域的 Me（requireAuth 产出）：头像、昵称、认证状态都在这里。 */
  user: MeSchema,
  stats: profileStatsSchema,
  /**
   * 我发布的商品（本人视角，含 OFFLINE / RESERVED / SOLD；时间倒序）。
   * P0 不分页：各列表服务端封顶 100 条（demo 数据量内足够），超出再扩游标端点。
   */
  listings: z.array(ListingCardSchema),
  /** 我的愿望（全部状态；时间倒序，含 matchCount）。 */
  wishes: z.array(wishDtoSchema),
  /** 我的买入 / 卖出交易（合并返回，按 role 分组；时间倒序）。 */
  transactions: z.array(profileTransactionSchema),
})
export type ProfileResponse = z.infer<typeof profileResponseSchema>
