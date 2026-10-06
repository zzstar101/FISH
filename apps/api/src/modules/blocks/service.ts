import type {
  BlockErrorCode,
  BlockedUser,
  BlockState,
  MyBlocksQuery,
  MyBlocksResponse,
} from '@fish/contracts/blocks/schema'
import { BlockStateSchema, MyBlocksResponseSchema } from '@fish/contracts/blocks/schema'
import type { ApiErrorDetail, SystemErrorCode } from '@fish/contracts/system/error'
import { encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { publicAvatarUrl } from '../uploads/avatar-url'
import { decodeBlockCursor, encodeBlockCursor } from './cursor'
import type { BlockedRow, BlockStore } from './store'

/**
 * 拉黑关系的业务层（#466）。
 *
 * `code` 取值域由契约的 `BlockErrorCodeSchema` 收窄（`BlockErrorCode`）；
 * `VALIDATION_FAILED` 直接取 system 的成员（不重写字面量）。
 *
 * **本 service 只管关系本身**（建立 / 解除 / 列表 / 状态）。拉黑的「生效」——拦截
 * 会话创建与消息发送——在 chat 域的 service 层实现（守卫读 `store.existsBlockBetween`），
 * 两件事分开：关系是数据，拦截是行为。
 */
export class BlockServiceError extends Error {
  constructor(
    readonly status: 404 | 422,
    readonly code: BlockErrorCode | Extract<SystemErrorCode, 'VALIDATION_FAILED'>,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'BlockServiceError'
  }
}

/** 与 `users` 域同码同文案：非法 uuid 与不存在的用户都走它，不给 id 空间留探针。 */
const userNotFound = () => new BlockServiceError(404, 'USER_NOT_FOUND', '用户不存在或不可见')

/** 自拉黑在 DB 层不可表达（`user_blocks_no_self_block` CHECK），显式判掉给稳定 422。 */
const cannotBlockSelf = () => new BlockServiceError(422, 'CANNOT_BLOCK_SELF', '不能拉黑自己')

/** 非法游标 → 422（follows / listings 同一结论），不做"宽容解析"。 */
const invalidCursor = () =>
  new BlockServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])

/**
 * 逐字段组装公开行（follows 同款：显式列出，不用展开式组装）。
 * `blockedAt` 从游标的微秒精度截到毫秒：响应口径与全仓 DTO 的 ISO 一致（Date 序列化），
 * 游标仍用未截断的微秒文本（`blockedAtCursor`），翻页精度不受影响。
 */
function toBlockedUser(row: BlockedRow): BlockedUser {
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.user, row.id),
    nickname: row.nickname,
    avatarUrl: publicAvatarUrl(row.avatarUrl),
    authStatus: row.authStatus,
    blockedAt: row.blockedAtCursor.replace(/(\.\d{3})\d+/, '$1'),
  }
}

export interface BlockService {
  listMyBlocks(userId: string, query: MyBlocksQuery): Promise<MyBlocksResponse>
  /** 本人视角：我是否拉黑了 TA。 */
  getState(viewerId: string, targetUserId: string): Promise<BlockState>
  block(viewerId: string, targetUserId: string): Promise<BlockState>
  unblock(viewerId: string, targetUserId: string): Promise<BlockState>
}

export function createBlockService(options: { store: BlockStore }): BlockService {
  const { store } = options

  /** 目标存在性 + 非自己：两个写接口共用的前置（follows assertTarget 同构）。 */
  async function assertTarget(viewerId: string, targetUserId: string): Promise<void> {
    if (viewerId === targetUserId) throw cannotBlockSelf()
    if (!(await store.userExists(targetUserId))) throw userNotFound()
  }

  return {
    async listMyBlocks(userId, query) {
      const cursor = query.cursor === undefined ? null : decodeBlockCursor(query.cursor)
      if (query.cursor !== undefined && !cursor) throw invalidCursor()

      const rows = await store.listBlocks(userId, query.limit, cursor)

      // store 多取了一行用于判断还有没有下一页；这里丢掉它。
      const hasMore = rows.length > query.limit
      const page = hasMore ? rows.slice(0, query.limit) : rows

      // 游标基于最后一条已返回的行，而不是 limit+1 那一条（follows 同款）。
      const last = page.at(-1)
      const nextCursor =
        hasMore && last ? encodeBlockCursor({ createdAt: last.blockedAtCursor, id: last.id }) : null

      return MyBlocksResponseSchema.parse({ items: page.map(toBlockedUser), nextCursor })
    },

    async getState(viewerId, targetUserId) {
      if (!(await store.userExists(targetUserId))) throw userNotFound()
      return BlockStateSchema.parse({ blocked: await store.isBlocked(viewerId, targetUserId) })
    },

    async block(viewerId, targetUserId) {
      await assertTarget(viewerId, targetUserId)
      await store.block(viewerId, targetUserId)
      return BlockStateSchema.parse({ blocked: true })
    },

    async unblock(viewerId, targetUserId) {
      await assertTarget(viewerId, targetUserId)
      await store.unblock(viewerId, targetUserId)
      return BlockStateSchema.parse({ blocked: false })
    },
  }
}
