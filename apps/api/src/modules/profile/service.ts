import type { Me } from '@fish/contracts/auth/user'
import {
  type ProfileErrorCode,
  type ProfilePendingChange,
  type ProfileResponse,
  type ProfileUpdateRequest,
  profileResponseSchema,
} from '@fish/contracts/profile/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { wishDtoSchema } from '@fish/contracts/wishes/schema'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { toMe } from '../auth/me'
import { toListingCard } from '../listings/card'
import { ContentModerationError } from '../moderation/providers/types'
import { publicAvatarUrl } from '../uploads/avatar-url'
import type { UploadService } from '../uploads/service'
import { UploadServiceError } from '../uploads/service'
import type { MediaStorage } from '../uploads/storage'
import { toWishDto } from '../wishes/service'
import type { ProfileModerationPolicy, ProfileTextModerationResult } from './moderation-policy'
import {
  decodeProfileChange,
  type ProfileChange,
  type ProfileModerationRecordInput,
  profileChangeFields,
} from './moderation-store'
import type { ProfilePendingRow, ProfileStore, ProfileTransactionRow } from './store'

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

/**
 * 资料写入的可预期失败（#694 M5）。
 *
 * 与 `CommentServiceError` 同形：service 抛出带状态码的域错误，router 只负责转成错误信封。
 * 状态码只有两档：`422`（内容被阻断，用户改文案后可重试）与 `503`（审核上游不可用，稍后重试）。
 */
export class ProfileServiceError extends Error {
  constructor(
    readonly status: 422 | 503,
    readonly code: Extract<
      ProfileErrorCode,
      'PROFILE_CONTENT_BLOCKED' | 'CONTENT_MODERATION_UNAVAILABLE'
    >,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
  }
}

export interface ProfileUpdateResult {
  /** 更新后的公开资料；机审 `REVIEW` 时仍是**旧值**（新值只在 `pending` 里，尚未生效）。 */
  user: Me
  pending: ProfilePendingChange | null
}

export interface ProfileService {
  /** 单个聚合接口（Issue #12 的 Backend Done 口径）：一个调用返回个人中心全部读数据。 */
  getProfile(me: Me): Promise<ProfileResponse>
  /**
   * #86 B 节：改昵称 / 头像 / 签名，回更新后的 `Me` 与待审状态（#694 M5）。
   *
   * 端上拿到就覆盖全局 store（「我的」页头部与商品卡卖家位立刻变），
   * 不必再补一次 `GET /me` —— 与 `applyVerification` 的取舍同一个理由：
   * 一次多余的往返失败会把刚写成功的资料又显示回旧值。
   *
   * 昵称 / 签名先过公开 UGC 审核（fail-closed）：
   * - `ALLOW`：一次 UPDATE 直接生效（旧待审记录被本次提交取代）；
   * - `BLOCK`：422 `PROFILE_CONTENT_BLOCKED`，**任何公开值都不改**，连头像都不 confirm；
   * - `REVIEW`：新值挂起为待审记录，`user` 仍是旧公开值（列表 / 商品卡 / 聊天 sender
   *   等所有投射继续显示旧值），本人从 `pending` 看到「审核中」。
   */
  updateProfile(me: Me, input: ProfileUpdateRequest): Promise<ProfileUpdateResult>
}

/** 待审记录 → 本人可见的待审视图（`fields` 区分「没提交」与「提交了清空」）。 */
function toPendingChange(row: ProfilePendingRow | null): ProfilePendingChange | null {
  if (row === null) return null
  const change = decodeProfileChange(row.payload)
  return {
    nickname: change.nickname ?? null,
    signature: change.signature !== undefined ? change.signature : null,
    avatarUrl: change.avatarUrl === undefined ? null : publicAvatarUrl(change.avatarUrl),
    fields: profileChangeFields(change),
    submittedAt: row.submittedAt.toISOString(),
  }
}

function pendingRecordOf(verdict: ProfileTextModerationResult): ProfileModerationRecordInput {
  return {
    machineDecision: verdict.decision,
    decision: verdict.decision,
    provider: verdict.provider,
    providerRequestId: verdict.providerRequestId,
    policyVersion: verdict.policyVersion,
    suggestion: verdict.suggestion,
    label: verdict.label,
    subLabel: verdict.subLabel,
    score: verdict.score,
    matchedRules: verdict.matchedRules,
    matchedTermsMasked: verdict.matchedTermsMasked,
  }
}

/**
 * BLOCK → 字段级 422。
 *
 * 只报被判定 BLOCK 的字段：同一次送审可能同时命中 BLOCK 与 REVIEW 规则，把只触发 REVIEW
 * 的字段也说成「包含平台禁止发布的内容」会把用户指到错的输入框（与商品域 #74 同一口径）。
 */
function blockedProfileError(verdict: ProfileTextModerationResult): ProfileServiceError {
  const details = verdict.blockedFields.map((field) => ({
    field,
    message: field === 'nickname' ? '昵称包含平台禁止发布的内容' : '个性签名包含平台禁止发布的内容',
  }))
  return new ProfileServiceError(
    422,
    'PROFILE_CONTENT_BLOCKED',
    '昵称或个性签名未通过审核',
    details.length === 0 ? undefined : details,
  )
}

export function createProfileService({
  store,
  storage,
  uploads,
  moderation,
}: {
  store: ProfileStore
  storage: MediaStorage
  /**
   * #86 B：头像对象键走上传域的 `confirm` 校验（归属前缀 + 对象确实已上传 + 格式/大小），
   * 再由 `storage.publicUrl` 拼绝对 URL。端上给不了任意外链。
   */
  uploads: Pick<UploadService, 'confirm'>
  /**
   * #694 M5：昵称 / 签名的公开 UGC 审核策略。注入而不是内部 new：装配处用公开 UGC 的
   * TMS 策略号（`TENCENT_TMS_UGC_BIZ_TYPE`），与商品 / 聊天策略号隔离；测试可给假 provider。
   */
  moderation: ProfileModerationPolicy
}): ProfileService {
  return {
    async getProfile(me) {
      const userId = decodePublicId(PUBLIC_ID_PREFIX.user, me.id)
      const [stats, listingRows, wishRows, txRows, pending] = await Promise.all([
        store.stats(userId),
        store.ownListings(userId, PROFILE_LIST_LIMIT),
        store.ownWishes(userId, PROFILE_LIST_LIMIT),
        store.ownTransactions(userId, PROFILE_LIST_LIMIT),
        store.findPendingProfileChange(userId),
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
        // 待审新值只回给本人：它不进 stats / listings / wishes / transactions 任何投射。
        pending: toPendingChange(pending),
      })
    },

    async updateProfile(me, input) {
      const userId = decodePublicId(PUBLIC_ID_PREFIX.user, me.id)
      const change: ProfileChange = {}
      /** 本次真正变化、且需要送审的文本字段（与公开值相同的值不重复送审）。 */
      const text: { nickname?: string; signature?: string } = {}
      if (input.nickname !== undefined && input.nickname !== me.nickname) {
        change.nickname = input.nickname
        text.nickname = input.nickname
      }
      // #179：trim 归一化在**写边界**做（service 自足，不依赖 router 层先 parse）；
      // 空白 = 清空 → 落 null（与「从未填写」同态）。清空不需要送审（没有新内容）。
      if (input.signature !== undefined) {
        const trimmed = input.signature.trim()
        const next = trimmed.length === 0 ? null : trimmed
        if (next !== me.signature) {
          change.signature = next
          if (next !== null) text.signature = next
        }
      }

      // 先审文本、再审头像：BLOCK 时连 `uploads.confirm` 都不做，避免「文字没通过但头像已经
      // 固化并换上去」的部分提交（#694 M5 票面明令禁止）。
      const hasText = text.nickname !== undefined || text.signature !== undefined
      let verdict: ProfileTextModerationResult | null = null
      if (hasText) {
        try {
          verdict = await moderation.moderateProfile(text)
        } catch (error) {
          if (!(error instanceof ContentModerationError)) throw error
          // 不静默吞第三方审核故障、也不降级放行：本次提交整体不落库。
          console.error('[profile] 内容审核不可用，资料未落库', {
            reason: error.reason,
            retryable: error.retryable,
            requestId: error.requestId,
          })
          throw new ProfileServiceError(
            503,
            'CONTENT_MODERATION_UNAVAILABLE',
            '内容审核暂时不可用，请稍后重试',
          )
        }
        if (verdict.decision === 'BLOCK') throw blockedProfileError(verdict)
      }

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
        change.avatarUrl = url
      }

      if (profileChangeFields(change).length === 0) {
        // 提交的值与当前公开值完全一致：不写库、也不覆盖已有的待审记录。
        return { user: me, pending: toPendingChange(await store.findPendingProfileChange(userId)) }
      }

      if (verdict?.decision === 'REVIEW') {
        // 待人工确认：旧公开值继续对外可见，新值（含本次一起提交的头像）只在待审记录里，
        // 管理员放行时一次切换全部列。
        const queued = await store.queuePendingProfileChange(
          userId,
          change,
          pendingRecordOf(verdict),
        )
        if (!queued) throw new Error('更新资料时账号已不存在')
        return { user: me, pending: toPendingChange(queued) }
      }

      // ALLOW：一次 UPDATE 生效。只有当本次提交**覆盖了待审记录的全部字段**时才算「取代」；
      // 只改头像、或只改待审里的另一个字段时，不能替用户撤回还没审完的昵称/签名。
      const pendingRow = hasText ? await store.findPendingProfileChange(userId) : null
      const pendingFields = pendingRow
        ? profileChangeFields(decodeProfileChange(pendingRow.payload))
        : []
      const supersedePending =
        hasText && pendingFields.every((field) => change[field] !== undefined)
      const row = await store.applyProfileChange(userId, change, { supersedePending })
      // requireAuth 已证明该行存在（`Me` 就是从它映射出来的），这里为 null 只可能是
      // 「认证与写入之间账号被删」的竞态——是服务端不变量被破坏，不是客户端错误。
      if (!row) throw new Error('更新资料时账号已不存在')
      return {
        user: toMe(row),
        pending: toPendingChange(await store.findPendingProfileChange(userId)),
      }
    },
  }
}
