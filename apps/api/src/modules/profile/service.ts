import type { Me } from '@fish/contracts/auth/user'
import {
  type ProfileResponse,
  type ProfileUpdateRequest,
  profileResponseSchema,
} from '@fish/contracts/profile/schema'
import { wishDtoSchema } from '@fish/contracts/wishes/schema'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { toMe } from '../auth/me'
import { toListingCard } from '../listings/card'
import { publicAvatarUrl } from '../uploads/avatar-url'
import type { UploadService } from '../uploads/service'
import { UploadServiceError } from '../uploads/service'
import type { MediaStorage } from '../uploads/storage'
import { toWishDto } from '../wishes/service'
import type { ProfileStore, ProfileTransactionRow } from './store'

/** 各列表的服务端封顶（契约注释冻结：P0 不分页，超出再扩游标端点）。 */
export const PROFILE_LIST_LIMIT = 100

function toProfileTransaction(row: ProfileTransactionRow, viewerId: string, storage: MediaStorage) {
  if (!row.listing || !row.counterpart) return null // 脏数据行：决策 C，跳过不 500
  return {
    id: encodePublicId(PUBLIC_ID_PREFIX.transaction, row.id),
    listingId: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
    role: row.buyerId === viewerId ? ('buyer' as const) : ('seller' as const),
    listing: {
      id: encodePublicId(PUBLIC_ID_PREFIX.listing, row.listingId),
      title: row.listing.title,
      priceCents: row.listing.priceCents,
      status: row.listing.status as 'ACTIVE' | 'RESERVED' | 'SOLD' | 'OFFLINE',
      coverUrl: row.listing.coverObjectKey ? storage.publicUrl(row.listing.coverObjectKey) : null,
    },
    counterpart: {
      ...row.counterpart,
      id: encodePublicId(PUBLIC_ID_PREFIX.user, row.counterpart.id),
      // `users.avatar_url` 是无约束 text，而契约声明 `z.url().nullable()`：值域外的历史值
      // 降级为 null，否则一个脏字段就让整个 /profile 500（与 auth 的 `toMe`、
      // listings 的 `toSeller` 同一取舍，见 auth/router.test.ts 的同款回归用例）。
      avatarUrl: publicAvatarUrl(row.counterpart.avatarUrl),
    },
    amountCents: row.amountCents,
    status: row.status as 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED',
    createdAt: new Date(row.createdAt).toISOString(),
  }
}

export interface ProfileService {
  /** 单个聚合接口（Issue #12 的 Backend Done 口径）：一个调用返回个人中心全部读数据。 */
  getProfile(me: Me): Promise<ProfileResponse>
  /**
   * #86 B 节：改昵称 / 头像，回更新后的 `Me`。
   *
   * 端上拿到就覆盖全局 store（「我的」页头部与商品卡卖家位立刻变），
   * 不必再补一次 `GET /me` —— 与 `applyVerification` 的取舍同一个理由：
   * 一次多余的往返失败会把刚写成功的资料又显示回旧值。
   */
  updateProfile(me: Me, input: ProfileUpdateRequest): Promise<Me>
}

export function createProfileService({
  store,
  storage,
  uploads,
}: {
  store: ProfileStore
  storage: MediaStorage
  /**
   * #86 B：头像对象键走上传域的 `confirm` 校验（归属前缀 + 对象确实已上传 + 格式/大小），
   * 再由 `storage.publicUrl` 拼绝对 URL。端上给不了任意外链。
   */
  uploads: Pick<UploadService, 'confirm'>
}): ProfileService {
  return {
    async getProfile(me) {
      const userId = decodePublicId(PUBLIC_ID_PREFIX.user, me.id)
      const [stats, listingRows, wishRows, txRows] = await Promise.all([
        store.stats(userId),
        store.ownListings(userId, PROFILE_LIST_LIMIT),
        store.ownWishes(userId, PROFILE_LIST_LIMIT),
        store.ownTransactions(userId, PROFILE_LIST_LIMIT),
      ])

      return profileResponseSchema.parse({
        user: me,
        stats,
        // 决策 C（#6 冻结口径）：单行脏数据记日志跳过，不让整个 /profile 打不开。
        listings: listingRows
          .map((row) => toListingCard(row, row.coverObjectKey, storage))
          .filter((card) => card !== null),
        wishes: wishRows.flatMap((row) => {
          const parsed = wishDtoSchema.safeParse(toWishDto(row))
          if (!parsed.success) {
            console.error('[profile] 跳过无法映射为契约的愿望', row.id, parsed.error.message)
            return []
          }
          return [parsed.data]
        }),
        transactions: txRows.flatMap((row) => {
          const tx = toProfileTransaction(row, userId, storage)
          if (!tx) {
            console.error('[profile] 跳过无法组装摘要的交易', row.id)
            return []
          }
          return [tx]
        }),
      })
    },

    async updateProfile(me, input) {
      const userId = decodePublicId(PUBLIC_ID_PREFIX.user, me.id)
      const patch: { nickname?: string; avatarUrl?: string } = {}
      if (input.nickname !== undefined) patch.nickname = input.nickname
      if (input.avatarObjectKey !== undefined) {
        // 复用上传域的 confirm，而不是自己再写一遍前缀 / stat / mime 校验：
        // 发布商品与改头像的失败码与文案必须是同一套（IMAGE_REFERENCE_INVALID /
        // UPLOAD_OBJECT_MISSING），端上才能共用一份错误处理。
        const { url, moderationDecision } = await uploads.confirm(userId, {
          objectKey: input.avatarObjectKey,
        })
        // #286 复审 blocker 2 的取舍：审核中的头像固化在**私有**前缀，而 `avatarUrl` 是到处直出的
        // 公开字段（9 处 `publicAvatarUrl` 投影）。头像没有人工审核队列（`listing_moderation_records`
        // 只挂 Listing），所以这里 fail closed：没拿到机器 `ALLOW` 就不换头像、保留旧值，而不是把
        // 一个私有/未审核的对象地址写进公开资料。代价是 `local` transport（图片恒 REVIEW）下改不了
        // 头像 —— 这是有意的：宁可功能不可用，也不放未审核的图进公开字段。
        if (moderationDecision !== 'ALLOW') {
          throw new UploadServiceError(422, 'IMAGE_CONTENT_BLOCKED', '头像未通过审核，请更换图片', [
            { field: 'avatarObjectKey', message: '头像未通过审核，请更换图片' },
          ])
        }
        patch.avatarUrl = url
      }

      const row = await store.updateUser(userId, patch)
      // requireAuth 已证明该行存在（`Me` 就是从它映射出来的），这里为 null 只可能是
      // 「认证与写入之间账号被删」的竞态——是服务端不变量被破坏，不是客户端错误。
      if (!row) throw new Error('更新资料时账号已不存在')
      return toMe(row)
    },
  }
}
