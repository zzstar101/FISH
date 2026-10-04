import type { Me } from '@fish/contracts/auth/user'
import type { MessageDto } from '@fish/contracts/chat/schema'
import { messageDtoSchema } from '@fish/contracts/chat/schema'
import { LISTING_ROUTES } from '@fish/contracts/listings/routes'
import {
  type ListingDetail,
  ListingDetailSchema,
  type ListingFeedResponse,
  ListingFeedResponseSchema,
  type ListingStatus,
  type ListingUpdateInput,
} from '@fish/contracts/listings/schema'
import { PROFILE_ROUTES } from '@fish/contracts/profile/routes'
import {
  type ProfileResponse,
  type ProfileUpdateRequest,
  profileResponseSchema,
  profileUpdateResponseSchema,
} from '@fish/contracts/profile/schema'
import { TRANSACTION_REVIEW_ROUTES } from '@fish/contracts/transaction-reviews/routes'
import {
  type TransactionReview,
  type TransactionReviewCreateInput,
  TransactionReviewResponseSchema,
} from '@fish/contracts/transaction-reviews/schema'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import {
  type MeetupTokenResponse,
  type MeetupTokenStatusResponse,
  type MeetupVerificationResponse,
  meetupTokenResponseSchema,
  meetupTokenStatusResponseSchema,
  meetupVerificationResponseSchema,
  type TransactionDto,
  type TransactionListResponse,
  type TransactionRole,
  type TransactionStatus,
  transactionDtoSchema,
  transactionListResponseSchema,
} from '@fish/contracts/transactions/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

export type MyListingStatusFilter = ListingStatus | 'ALL'
export type OrderStatusFilter = TransactionStatus | 'ALL'

export type ProfileFieldErrors = Partial<
  Record<'nickname' | 'avatarObjectKey' | 'signature', string>
>

export function myListingsPath(
  sellerId: string,
  status: MyListingStatusFilter = 'ALL',
  cursor?: string,
): string {
  const params = new URLSearchParams({ sellerId, limit: '50' })
  if (status !== 'ALL') params.set('status', status)
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${LISTING_ROUTES.base}?${params.toString()}`
}

export function transactionsPath(query: {
  role?: TransactionRole
  status?: OrderStatusFilter
  cursor?: string
}): string {
  const params = new URLSearchParams({ limit: '50' })
  if (query.role !== undefined) params.set('role', query.role)
  if (query.status !== undefined && query.status !== 'ALL') params.set('status', query.status)
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  return `${TRANSACTION_ROUTES.base}?${params.toString()}`
}

/** 个人聚合读模型；服务端以登录 cookie 判定账号。 */
export async function fetchProfile(): Promise<ProfileResponse> {
  return profileResponseSchema.parse(await apiRequest(PROFILE_ROUTES.me))
}

/** 昵称 / 头像写入；响应只回更新后的 Me，直接用于覆盖顶栏。 */
export async function updateProfile(input: ProfileUpdateRequest): Promise<Me> {
  const response = profileUpdateResponseSchema.parse(
    await apiRequest(PROFILE_ROUTES.me, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  )
  return response.user
}

export async function fetchMyListings(
  sellerId: string,
  status: MyListingStatusFilter = 'ALL',
): Promise<ListingFeedResponse> {
  return ListingFeedResponseSchema.parse(await apiRequest(myListingsPath(sellerId, status)))
}

export async function updateListing(id: string, input: ListingUpdateInput): Promise<ListingDetail> {
  return ListingDetailSchema.parse(
    await apiRequest(LISTING_ROUTES.detail(id), {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  )
}

export async function setListingStatus(
  id: string,
  status: Extract<ListingStatus, 'ACTIVE' | 'OFFLINE'>,
): Promise<ListingDetail> {
  const path = status === 'ACTIVE' ? LISTING_ROUTES.online(id) : LISTING_ROUTES.offline(id)
  return ListingDetailSchema.parse(await apiRequest(path, { method: 'POST' }))
}

/**
 * 物理删除商品：成功是 204 无响应体（`apiRequest` 对 204 回 `null`）。
 *
 * **不是「下架」的别名** —— 下架可重新上架，删除不可恢复。
 * **也不是任意商品都能删**：服务端只放行「未过审且没有交易记录」的商品
 * （判据见 `apps/api/src/modules/listings/service.ts` 的 `deleteListing`），
 * 其余一律 409 `LISTING_NOT_DELETABLE`。端上按 `isDeletableListing` 预筛，
 * 但「有没有交易记录」是客户端看不到的那一条，仍可能 409 —— 失败必须透传，不能当成功。
 *
 * 路径复用 `LISTING_ROUTES.detail(id)`：`LISTING_ROUTES` 没有单独的 delete 常量，
 * 小程序侧同样是 `detail(id)` + DELETE（`apps/miniapp/src/features/listing/api.ts`）。
 */
export async function deleteListing(id: string): Promise<void> {
  await apiRequest(LISTING_ROUTES.detail(id), { method: 'DELETE' })
}

export async function fetchTransactions(query: {
  role?: TransactionRole
  status?: OrderStatusFilter
  cursor?: string
}): Promise<TransactionListResponse> {
  return transactionListResponseSchema.parse(await apiRequest(transactionsPath(query)))
}

/**
 * 订单详情：404 表示交易不存在或当前账号不是交易双方。
 * 页面用 null 渲染业务空态，不把可预期的无权限伪装成系统错误。
 */
export async function fetchTransaction(id: string): Promise<TransactionDto | null> {
  try {
    return transactionDtoSchema.parse(await apiRequest(TRANSACTION_ROUTES.detail(id)))
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.status === 404 &&
      error.code === 'TRANSACTION_NOT_FOUND'
    ) {
      return null
    }
    throw error
  }
}

export async function confirmTransaction(id: string): Promise<TransactionDto> {
  return transactionDtoSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.confirm(id), { method: 'POST' }),
  )
}

export async function cancelTransaction(id: string): Promise<TransactionDto> {
  return transactionDtoSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.cancel(id), { method: 'POST' }),
  )
}

/**
 * 卖家接受提案：**唯一会创建交易行的端点**。
 *
 * 金额取提案消息里的值（提案不落库，服务端无处可读，所以由端上重传）。
 * 409 `LISTING_NOT_ACTIVE` 覆盖「输给并发买家」与「商品已非 ACTIVE」两种情形，
 * 且**不得**直译成「接受失败」——响应丢失后重试收到 409 时，交易可能已在上一次创建；
 * 调用方须以会话内 `tx.accepted` 或 `GET /transactions` 为准（契约注释同源）。
 */
export async function acceptTransaction(
  conversationId: string,
  amountCents: number,
): Promise<TransactionDto> {
  return transactionDtoSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.accept, {
      method: 'POST',
      body: JSON.stringify({ conversationId, amountCents }),
    }),
  )
}

/** 卖家拒绝提案：只往会话写一条 `tx.rejected`，商品留在在售。 */
export async function rejectProposal(conversationId: string): Promise<MessageDto> {
  return messageDtoSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.reject, {
      method: 'POST',
      body: JSON.stringify({ conversationId }),
    }),
  )
}

/**
 * 「(我, 这笔交易)」的评价边读：没评过就是 404，返回 null 而不是错误。
 *
 * 404 有两种码且端上同态处理：`REVIEW_NOT_FOUND` 是常态（还没评）；
 * `TRANSACTION_NOT_FOUND` 正常到不了（卡片只挂在已加载成功的订单详情上），
 * 真出现时让后续 POST 去拿同一句话，不在这里伪造「没评过」以外的状态。
 */
export async function fetchMyReview(transactionId: string): Promise<TransactionReview | null> {
  try {
    return TransactionReviewResponseSchema.parse(
      await apiRequest(TRANSACTION_REVIEW_ROUTES.reviewEdge(transactionId)),
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  }
}

/**
 * 写评价：三档评分 + 可空评语（#195 冻结口径）。**不可修改、不可重评** ——
 * 重复提交由 409 `TRANSACTION_REVIEW_EXISTS` 挡（并发撞库唯一索引也归这里）。
 */
export async function createTransactionReview(
  transactionId: string,
  input: TransactionReviewCreateInput,
): Promise<TransactionReview> {
  return TransactionReviewResponseSchema.parse(
    await apiRequest(TRANSACTION_REVIEW_ROUTES.reviewEdge(transactionId), {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  )
}

/** 提交评价失败的可执行分支（错误码全集见契约 `TransactionReviewErrorCodeSchema`）。 */
export function reviewSubmitError(error: unknown): {
  message: string
  alreadyReviewed: boolean
  refresh: boolean
} {
  if (error instanceof ApiError) {
    if (error.code === 'TRANSACTION_REVIEW_EXISTS') {
      return { message: '你已评价过这笔交易', alreadyReviewed: true, refresh: false }
    }
    if (error.code === 'TRANSACTION_NOT_COMPLETED' || error.code === 'TRANSACTION_NOT_FOUND') {
      return { message: error.message, alreadyReviewed: false, refresh: true }
    }
    return { message: error.message, alreadyReviewed: false, refresh: false }
  }
  return { message: '评价失败，请稍后重试', alreadyReviewed: false, refresh: false }
}

/**
 * 卖家取本单面交码。
 *
 * 契约是**幂等「确保并读取」**：同一笔交易恒定同一枚码，重复调用不换码
 * （只清失败计数与锁定），所以「重新取码」按钮不需要禁用态。
 * 明文码（`code` / `qrPayload`）只在这个响应里出现，状态端点不返回。
 */
export async function issueMeetupToken(id: string): Promise<MeetupTokenResponse> {
  return meetupTokenResponseSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.issueMeetupToken(id), { method: 'POST' }),
  )
}

/** 凭证状态：`NONE` / `ISSUED` / `CONSUMED`（含消费方与时间，不含明文码）。 */
export async function fetchMeetupTokenStatus(id: string): Promise<MeetupTokenStatusResponse> {
  return meetupTokenStatusResponseSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.meetupTokenStatus(id)),
  )
}

/** 用二维码载荷核销；`qrToken` 由 `parseMeetupQrPayload` 从载荷里取出。 */
export async function redeemMeetupToken(
  id: string,
  qrToken: string,
): Promise<MeetupVerificationResponse> {
  return meetupVerificationResponseSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.redeemMeetupToken(id), {
      method: 'POST',
      body: JSON.stringify({ qrToken }),
    }),
  )
}

/** 用 6 位手动码核销。 */
export async function verifyMeetupCode(
  id: string,
  code: string,
): Promise<MeetupVerificationResponse> {
  return meetupVerificationResponseSchema.parse(
    await apiRequest(TRANSACTION_ROUTES.verifyMeetupCode(id), {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  )
}

/**
 * 处理提案（同意 / 拒绝）失败的可执行分支。
 *
 * `LISTING_NOT_ACTIVE` 的文案**刻意不断言「这次没成功」**：契约明确该码在重试场景下
 * 也可能意味着交易已经创建，所以只说事实（商品已不在售）并要求刷新，
 * 由服务端状态而不是这次响应来决定结论。
 */
export function proposalDecisionError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_NOT_ACTIVE') {
      return { message: '商品已不在售，可能已被他人拍下或已同意过一笔，正在刷新', refresh: true }
    }
    if (error.code === 'NOT_CONVERSATION_SELLER') {
      return { message: '只有卖家可以处理这笔申请', refresh: false }
    }
    if (error.code === 'CONVERSATION_NOT_FOUND') {
      return { message: '会话不存在或不可访问，正在刷新', refresh: true }
    }
    return { message: error.message, refresh: false }
  }
  return { message: '操作失败，请重试', refresh: false }
}

/**
 * 删除商品失败的可执行分支。
 *
 * **文案一律用服务端原文**（403 / 404 / 409 都透传）：服务端那几句
 * （「只有未通过审核且没有交易记录的商品可以删除」/「只能操作自己的商品」）已经是
 * 给人看的一句话，端上按错误码改写只会丢信息，还会与服务端文案悄悄漂移。
 *
 * `refresh` 只对三个已知失败码为真 —— 它们既可能来自「本来就不能删」，
 * 也可能来自「刚被并发买家拍下」这类漂移，结论要由服务端状态给。
 */
export function listingDeleteError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    const refresh =
      error.code === 'LISTING_NOT_DELETABLE' ||
      error.code === 'NOT_LISTING_OWNER' ||
      error.code === 'LISTING_NOT_FOUND'
    return { message: error.message, refresh }
  }
  return { message: '删除失败，请稍后重试', refresh: false }
}

/** 商品上下架失败的可执行分支：状态漂移必须刷新，而不是把失败当成功。 */
export function listingActionError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'LISTING_NOT_EDITABLE') {
      return { message: '商品状态已变化，正在刷新最新状态', refresh: true }
    }
    if (error.code === 'LISTING_NOT_FOUND') {
      return { message: '商品不存在或当前账号无权操作', refresh: true }
    }
    return { message: error.message, refresh: false }
  }
  return { message: '操作失败，请稍后重试', refresh: false }
}

/** 交易确认 / 取消失败的可执行分支：终态漂移只接受服务端最新状态。 */
export function transactionActionError(error: unknown): { message: string; refresh: boolean } {
  if (error instanceof ApiError) {
    if (error.code === 'TRANSACTION_NOT_IN_PENDING') {
      return { message: '订单状态已变化，正在刷新最新状态', refresh: true }
    }
    if (error.code === 'TRANSACTION_NOT_FOUND') {
      return { message: '订单不存在或当前账号无权查看', refresh: true }
    }
    return { message: error.message, refresh: false }
  }
  return { message: '操作失败，请稍后重试', refresh: false }
}

/** 编辑资料失败：保留输入，并把服务端 details 映射到可见字段。 */
export function profileUpdateErrorView(error: unknown): {
  message: string
  fields: ProfileFieldErrors
} {
  if (error instanceof ApiError) {
    const fields: ProfileFieldErrors = {}
    for (const detail of error.details ?? []) {
      if (detail.field === 'nickname') fields.nickname = detail.message
      // 上传域的错误详情字段名是 objectKey；资料域对外语义是头像，两处都收口。
      if (detail.field === 'avatarObjectKey' || detail.field === 'objectKey') {
        fields.avatarObjectKey = detail.message
      }
      if (detail.field === 'signature') fields.signature = detail.message
    }

    if (error.code === 'IMAGE_REFERENCE_INVALID') {
      return { message: '头像文件校验失败，请重新选择图片', fields }
    }
    if (error.code === 'UPLOAD_OBJECT_MISSING') {
      return { message: '头像尚未上传完成，请重试', fields }
    }
    return { message: error.message, fields }
  }
  return { message: '保存失败，请稍后重试', fields: {} }
}
