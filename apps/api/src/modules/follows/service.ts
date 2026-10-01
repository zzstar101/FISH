import type {
  FollowErrorCode,
  FollowedUser,
  FollowState,
  MyFollowingQuery,
  MyFollowingResponse,
} from '@fish/contracts/follows/schema'
import { FollowStateSchema, MyFollowingResponseSchema } from '@fish/contracts/follows/schema'
import type { ApiErrorDetail, SystemErrorCode } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { decodeFollowingCursor, encodeFollowingCursor } from './cursor'
import type { FollowingRow, FollowStore } from './store'

/**
 * 关注关系的业务层（Issue #188）。
 *
 * `code` 取值域由契约的 `FollowErrorCodeSchema` 收窄（`FollowErrorCode`）；
 * `VALIDATION_FAILED` 直接取 system 的成员（不重写字面量），重命名会在这里编译失败。
 */
export class FollowServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: FollowErrorCode | Extract<SystemErrorCode, 'VALIDATION_FAILED'>,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'FollowServiceError'
  }
}

/** 与 `users` 域同码同文案：非法 uuid 与不存在的用户都走它，不给 id 空间留探针。 */
const userNotFound = () => new FollowServiceError(404, 'USER_NOT_FOUND', '用户不存在或不可见')

/**
 * 自关注在 DB 层不可表达（`follows_no_self_follow` CHECK），但那是 23514 → 500；
 * 写入前显式判掉才给得出稳定的 422。**关注与取关同一判据**：与自己的关系不可表达，
 * 取关自己也不是「未关注」的成功语义。
 */
const cannotFollowSelf = () => new FollowServiceError(422, 'CANNOT_FOLLOW_SELF', '不能关注自己')

/** 非法游标 → 422（与 listings feed / 公开用户列表同一结论），不做"宽容解析"。 */
const invalidCursor = () =>
  new FollowServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])

/**
 * 逐字段组装公开行（**不是** `{...row}`）：显式列出五个字段，谁想多带一个都得改这行字面量，
 * 展开式组装会在 store 加列时静默把新列带进公开响应（`users/service.ts` 同款取舍）。
 */
function toFollowedUser(row: FollowingRow): FollowedUser {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, row.id),
    nickname: row.nickname,
    avatarUrl: publicAvatarUrl(row.avatarUrl),
    authStatus: row.authStatus,
    mutual: row.mutual,
  }
}

export interface FollowService {
  listMyFollowing(userId: string, query: MyFollowingQuery): Promise<MyFollowingResponse>
  /** 本人视角：我是否关注 TA、是否互关。 */
  getState(viewerId: string, targetUserId: string): Promise<FollowState>
  follow(viewerId: string, targetUserId: string): Promise<FollowState>
  unfollow(viewerId: string, targetUserId: string): Promise<FollowState>
}

export function createFollowService(options: { store: FollowStore }): FollowService {
  const { store } = options

  /** 目标存在性 + 非自己：两个写接口与状态读共用的前置。 */
  async function assertTarget(viewerId: string, targetUserId: string): Promise<void> {
    if (viewerId === targetUserId) throw cannotFollowSelf()
    if (!(await store.userExists(targetUserId))) throw userNotFound()
  }

  return {
    async listMyFollowing(userId, query) {
      const cursor = query.cursor === undefined ? null : decodeFollowingCursor(query.cursor)
      if (query.cursor !== undefined && !cursor) throw invalidCursor()

      const [rows, totals] = await Promise.all([
        store.listFollowing(userId, query.limit, cursor),
        store.totals(userId),
      ])

      // store 多取了一行用于判断还有没有下一页；这里丢掉它。
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      // 游标基于**最后一条已返回**的行，而不是 limit+1 那一条：否则会漏掉一个人。
      const last = page.at(-1)
      const nextCursor =
        hasMore && last
          ? encodeFollowingCursor({ createdAt: last.followedAtCursor, id: last.id })
          : null

      return MyFollowingResponseSchema.parse({
        items: page.map(toFollowedUser),
        nextCursor,
        total: totals.total,
        mutualTotal: totals.mutualTotal,
      })
    },

    async getState(viewerId, targetUserId) {
      if (!(await store.userExists(targetUserId))) throw userNotFound()
      const following = await store.isFollowing(viewerId, targetUserId)
      // 只有已关注才谈得上互关；未关注时不再多查一次反向边。
      const mutual = following && (await store.isFollowing(targetUserId, viewerId))
      return FollowStateSchema.parse({ following, mutual })
    },

    async follow(viewerId, targetUserId) {
      await assertTarget(viewerId, targetUserId)
      await store.follow(viewerId, targetUserId)
      // mutual 由服务端按反向边算，不让端上自己翻。
      const mutual = await store.isFollowing(targetUserId, viewerId)
      return FollowStateSchema.parse({ following: true, mutual })
    },

    async unfollow(viewerId, targetUserId) {
      await assertTarget(viewerId, targetUserId)
      await store.unfollow(viewerId, targetUserId)
      // 取关后必然不是互关：直接给结论，不再查反向边。
      return FollowStateSchema.parse({ following: false, mutual: false })
    },
  }
}
