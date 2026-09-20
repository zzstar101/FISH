import type { ListingCard } from '@fish/contracts/listings/schema'
import type { ApiErrorDetail, SystemErrorCode } from '@fish/contracts/system/error'
import {
  type PublicUserListingsQuery,
  type PublicUserListingsResponse,
  PublicUserListingsResponseSchema,
  type PublicUserProfile,
  PublicUserProfileSchema,
  type UserErrorCode,
} from '@fish/contracts/users/schema'
import { toListingCard } from '../listings/card'
import { decodeCursor, encodeCursor, isCursorTimestamp } from '../listings/cursor'
import type { MediaStorage } from '../uploads/storage'
import type {
  PublicListingCursor,
  PublicListingRow,
  PublicUserRow,
  PublicUserStatsRow,
  PublicUserStore,
} from './store'

/**
 * 公开用户读模型的业务层（Issue #122）。
 *
 * `code` 取值域由契约的 `UserErrorCodeSchema` 收窄（`UserErrorCode`）；`VALIDATION_FAILED`
 * 直接取 system 的 `SystemErrorCode` 成员（不重写字面量），重命名会在这里编译失败。
 */
export class PublicUserServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: UserErrorCode | Extract<SystemErrorCode, 'VALIDATION_FAILED'>,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'PublicUserServiceError'
  }
}

/**
 * 唯一的不存在语义：**非法 uuid 与不存在的用户都走它**。
 *
 * 文案与 `listings` 的「商品不存在或不可见」同款：不给"格式对不对"留出可区分的响应，
 * 否则这个匿名可触发的端点就成了一份用户 id 空间探针。
 */
const userNotFound = () => new PublicUserServiceError(404, 'USER_NOT_FOUND', '用户不存在或不可见')

/** 非法游标 → 422（与 listings feed 契约 §2.1 同一结论），不做"宽容解析"。 */
const invalidCursor = () =>
  new PublicUserServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])

const MS_PER_DAY = 86_400_000

/**
 * 加入天数：按**已过的 24 小时整数倍**取整，下限 1（注册当天不显示「加入 0 天」）。
 *
 * 不用日历日差：仓库里既有的时间判断全是 elapsed 差值语义（`transactions` 的 `lockedUntil`、
 * `wishes` 的 `poolCache.expiresAt`），且全仓没有任何服务端时区约定（无 `Asia/Shanghai` / `TZ`），
 * 按日历日算就必须先引入一个"服务端时区"。
 */
function joinedDaysOf(createdAt: Date, now: Date): number {
  const elapsed = now.getTime() - createdAt.getTime()
  return Math.max(1, Math.floor(elapsed / MS_PER_DAY))
}

/**
 * 公开资料 DTO：**逐字段组装**，不是 `{...row}`。
 *
 * 显式列出七个字段而不是展开行对象，是为了让"多一个字段"必须写进这行字面量——
 * 展开式组装会在有人给 `PublicUserRow` 加列时**静默**把新列带进公开响应。
 * 最后再 `parse` 一次，把契约漂移（例如 `auth_status` 出现第三个值）挡在出站前。
 */
function toPublicProfile(
  row: PublicUserRow,
  stats: PublicUserStatsRow,
  now: Date,
): PublicUserProfile {
  return PublicUserProfileSchema.parse({
    id: row.id,
    nickname: row.nickname,
    // `users.avatar_url` 是无约束 text，值域外的历史脏值降级为 null，
    // 不让一个人的脏头像把整页打成 500（与 comments 的 `toAuthor` 同一取舍）。
    avatarUrl: PublicUserProfileSchema.shape.avatarUrl.safeParse(row.avatarUrl).data ?? null,
    authStatus: row.authStatus,
    joinedDays: joinedDaysOf(row.createdAt, now),
    activeCount: stats.activeListings,
    soldCount: stats.soldCount,
  })
}

export interface PublicUserService {
  getPublicProfile(userId: string): Promise<PublicUserProfile>
  listActiveListings(
    userId: string,
    query: PublicUserListingsQuery,
  ): Promise<PublicUserListingsResponse>
}

export function createPublicUserService(options: {
  store: PublicUserStore
  /** 只取 `publicUrl`：「公开 URL 怎么拼」全仓只有一个实现（#6 契约 §7.8）。 */
  storage: Pick<MediaStorage, 'publicUrl'>
}): PublicUserService {
  const { store, storage } = options

  /** 游标解码 + 值域校验；不合法一律 422（与 feed 的 `decodeFeedCursor` 同款）。 */
  function decodeListingCursor(raw: string): PublicListingCursor {
    const decoded = decodeCursor(raw)
    if (!decoded) throw invalidCursor()
    // 本端点只有 `newest` 一种排序，所以 sortKey 必须是"微秒精度 UTC ISO"；
    // 值域也要合法，否则 `::timestamptz` 转换失败又会变成 500。
    if (typeof decoded.sortKey !== 'string' || !isCursorTimestamp(decoded.sortKey)) {
      throw invalidCursor()
    }
    return { createdAt: decoded.sortKey, id: decoded.id }
  }

  function toCard(row: PublicListingRow): ListingCard | null {
    return toListingCard(row, row.coverObjectKey, storage)
  }

  return {
    async getPublicProfile(userId) {
      const row = await store.findPublicUser(userId)
      if (!row) throw userNotFound()

      return toPublicProfile(row, await store.stats(userId), new Date())
    },

    async listActiveListings(userId, query) {
      // **先确认用户存在**：对不存在的用户返回空列表，端上会把「用户不存在」渲染成
      // 「TA 暂无在售商品」——这正是 #122 要求"稳定错误语义"要防的事。
      if (!(await store.findPublicUser(userId))) throw userNotFound()

      const cursor = query.cursor === undefined ? null : decodeListingCursor(query.cursor)
      const rows = await store.listActiveListings(userId, query.limit, cursor)

      // store 多取了一行用于判断还有没有下一页；这里丢掉它。
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      const items: ListingCard[] = []
      for (const row of page) {
        const card = toCard(row)
        if (card) items.push(card)
      }

      // 游标基于**最后一条已返回**的行，而不是 limit+1 那一条：否则会漏掉一个商品。
      const last = page.at(-1)
      const nextCursor =
        hasMore && last ? encodeCursor({ sortKey: last.createdAtCursor, id: last.id }) : null

      return PublicUserListingsResponseSchema.parse({ items, nextCursor })
    },
  }
}
