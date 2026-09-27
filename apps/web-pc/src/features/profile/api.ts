import type { Me } from '@fish/contracts/auth/user'
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
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import {
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

export type ProfileFieldErrors = Partial<Record<'nickname' | 'avatarObjectKey', string>>

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
