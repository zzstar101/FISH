import type { ListingStatus } from '@fish/contracts/listings/schema'
import type { ListingId } from '@fish/contracts/system/public-id'
import type {
  TransactionReview,
  TransactionReviewCreateInput,
} from '@fish/contracts/transaction-reviews/schema'
import type { QueryClient } from '@tanstack/react-query'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY, currentSessionGeneration } from '../../lib/session-cache'
import { fetchConversationPage, fetchMessagePage } from '../chat/api'
import { listingDetailQueryKey } from '../listing-detail/queries'
import {
  acceptTransaction,
  cancelTransaction,
  confirmTransaction,
  createTransactionReview,
  deleteListing,
  fetchMeetupTokenStatus,
  fetchMyListings,
  fetchMyReview,
  fetchProfile,
  fetchTransaction,
  fetchTransactions,
  issueMeetupToken,
  type MyListingStatusFilter,
  type OrderStatusFilter,
  redeemMeetupToken,
  rejectProposal,
  setListingStatus,
  updateListing,
  updateProfile,
  verifyMeetupCode,
} from './api'
import { loadPendingIndex, type PendingIndex } from './pending'

export const profileKeys = {
  all: () => ['pc', 'profile'] as const,
  aggregate: (ownerId: string) => ['pc', 'profile', 'aggregate', ownerId] as const,
  listings: (ownerId: string, status: MyListingStatusFilter) =>
    ['pc', 'profile', 'listings', ownerId, status] as const,
  orders: (ownerId: string, role: 'buyer' | 'seller', status: OrderStatusFilter) =>
    ['pc', 'profile', 'orders', ownerId, role, status] as const,
  order: (ownerId: string, transactionId: string) =>
    ['pc', 'profile', 'order', ownerId, transactionId] as const,
  pending: (ownerId: string) => ['pc', 'profile', 'pending', ownerId] as const,
  meetupToken: (ownerId: string, transactionId: string) =>
    ['pc', 'profile', 'meetup-token', ownerId, transactionId] as const,
  review: (ownerId: string, transactionId: string) =>
    ['pc', 'profile', 'review', ownerId, transactionId] as const,
}

type SessionMutationContext = { generation: number }

function captureSession(): SessionMutationContext {
  return { generation: currentSessionGeneration() }
}

function isSessionCurrent(context: SessionMutationContext | undefined): boolean {
  return context !== undefined && context.generation === currentSessionGeneration()
}

function invalidateProfileSummary(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: profileKeys.aggregate(ownerId) })
}

function invalidateListingLists(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'profile', 'listings', ownerId] })
}

function invalidateOrderLists(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'profile', 'orders', ownerId] })
}

function invalidateListingViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'listings'] })
}

function invalidateChatSurfaces(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'chat'] })
}

/**
 * 愿望域。`useMyListingsForMatches`（愿望发布页的商品选择器）取的是**同一份「我的发布」**，
 * 却有自己的 query key 与 30s staleTime —— 删掉商品后不失效，选择器里会留下一条
 * 点进去必然 404 的选项。
 */
function invalidateWishSurfaces(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['pc', 'wish'] })
}

function invalidatePending(queryClient: QueryClient, ownerId: string): void {
  void queryClient.invalidateQueries({ queryKey: profileKeys.pending(ownerId) })
}

export function invalidateTransactionSurfaces(queryClient: QueryClient, ownerId: string): void {
  invalidateProfileSummary(queryClient, ownerId)
  invalidateOrderLists(queryClient, ownerId)
  invalidateListingLists(queryClient, ownerId)
  invalidateListingViews(queryClient)
  invalidateChatSurfaces(queryClient)
}

export function useProfile(ownerId: string) {
  return useQuery({
    queryKey: profileKeys.aggregate(ownerId),
    queryFn: fetchProfile,
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export function useMyListings(ownerId: string, status: MyListingStatusFilter) {
  return useQuery({
    queryKey: profileKeys.listings(ownerId, status),
    queryFn: () => fetchMyListings(ownerId, status),
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export function useOrders(ownerId: string, role: 'buyer' | 'seller', status: OrderStatusFilter) {
  return useQuery({
    queryKey: profileKeys.orders(ownerId, role, status),
    queryFn: () => fetchTransactions({ role, status }),
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export function useOrder(ownerId: string, transactionId: string) {
  return useQuery({
    queryKey: profileKeys.order(ownerId, transactionId),
    queryFn: () => fetchTransaction(transactionId),
    enabled: ownerId !== '' && transactionId !== '',
    staleTime: 15_000,
  })
}

export function useUpdateProfile(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateProfile,
    onMutate: captureSession,
    onSuccess: (user, _input, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
      invalidateProfileSummary(queryClient, ownerId)
    },
  })
}

export function useUpdateListing(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateListing>[1] }) =>
      updateListing(id, input),
    onMutate: captureSession,
    onSuccess: (detail, variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(listingDetailQueryKey(variables.id, ownerId), detail)
      invalidateProfileSummary(queryClient, ownerId)
      invalidateListingLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
      invalidateChatSurfaces(queryClient)
    },
  })
}

export function useSetListingStatus(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'OFFLINE' }) =>
      setListingStatus(id, status),
    onMutate: captureSession,
    onSuccess: (detail, variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(listingDetailQueryKey(variables.id, ownerId), detail)
      invalidateProfileSummary(queryClient, ownerId)
      invalidateListingLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
      invalidateChatSurfaces(queryClient)
    },
  })
}

/**
 * 删除商品。**不是「下架」** —— 下架可重新上架，删除不可恢复。
 *
 * 成功后详情缓存要**移除而不是覆盖**：商品行已经不存在，`GET /listings/:id` 之后只会 404，
 * 留一份旧详情会让「返回该商品详情页」闪出一条已删除的商品。
 *
 * 待确认推导也要失效：提案不落库、只是会话里的 SYSTEM 消息，所以一条挂着提案的商品
 * 可能满足删除条件（无交易记录）—— 不失效的话「待确认」里会留下一条点不动的幽灵申请。
 */
export function useDeleteListing(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: deleteListing,
    onMutate: captureSession,
    onSuccess: (_result, id, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.removeQueries({ queryKey: listingDetailQueryKey(id, ownerId) })
      invalidateProfileSummary(queryClient, ownerId)
      invalidateListingLists(queryClient, ownerId)
      invalidateListingViews(queryClient)
      invalidateChatSurfaces(queryClient)
      invalidatePending(queryClient, ownerId)
      invalidateWishSurfaces(queryClient)
    },
  })
}

function useTransactionMutation(
  ownerId: string,
  mutationFn: (transactionId: string) => ReturnType<typeof confirmTransaction>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onMutate: captureSession,
    onSuccess: (transaction, transactionId, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(profileKeys.order(ownerId, transactionId), transaction)
      invalidateTransactionSurfaces(queryClient, ownerId)
    },
  })
}

export function useConfirmTransaction(ownerId: string) {
  return useTransactionMutation(ownerId, confirmTransaction)
}

export function useCancelTransaction(ownerId: string) {
  return useTransactionMutation(ownerId, cancelTransaction)
}

/** 我的评价边（null = 还没评过）。卡片只挂在 COMPLETED 订单上，因此不设 enabled 开关。 */
export function useMyReview(ownerId: string, transactionId: string) {
  return useQuery({
    queryKey: profileKeys.review(ownerId, transactionId),
    queryFn: () => fetchMyReview(transactionId),
    enabled: ownerId !== '' && transactionId !== '',
    staleTime: 15_000,
  })
}

export type CreateReviewVariables = { transactionId: string; input: TransactionReviewCreateInput }

/**
 * 写评价成功后的缓存接线（抽成可独立驱动的接缝，手法同 verify 域的 applyVerificationResult）：
 * 写边缓存让卡片立即翻已评态、不再依赖 refetch；失效「我的评论」评价段，
 * 新评价必须立刻出现在 /comments 列表里。
 */
export function applyReviewCreated(
  queryClient: QueryClient,
  ownerId: string,
  transactionId: string,
  review: TransactionReview,
): void {
  queryClient.setQueryData(profileKeys.review(ownerId, transactionId), review)
  void queryClient.invalidateQueries({ queryKey: ['pc', 'my-comments'] })
}

/** 写评价。**不可修改、不可重评** —— 重复提交由 409 在 api 层翻译，这里只管成功接线。 */
export function useCreateReview(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, input }: CreateReviewVariables) =>
      createTransactionReview(transactionId, input),
    onMutate: captureSession,
    onSuccess: (review, variables, context) => {
      if (!isSessionCurrent(context)) return
      applyReviewCreated(queryClient, ownerId, variables.transactionId, review)
    },
  })
}

const EMPTY_PENDING: PendingIndex = {
  proposals: new Map(),
  complete: true,
  failed: false,
}

/**
 * 卖家侧「谁在等我点头」的推导（口径见 `./pending` 文件头）。
 *
 * 商品**状态一并交给推导**（见 `./pending` 的 `ACTIONABLE_STATUSES`），这里不做筛选：
 * 服务端对接受与拒绝的要求不对称 —— 接受要求商品仍 `ACTIVE`，拒绝不看商品状态 ——
 * 所以「哪些状态还能处理」这件事只有推导侧一个地方说了算。
 *
 * id 全集独立取一次，不跟着「我的发布」当前标签页走：标签页可能停在「已下架 / 已预定」。
 */
export function usePendingProposals(ownerId: string) {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: profileKeys.pending(ownerId),
    queryFn: async () => {
      /*
       * 按 `ACTIVE` / `OFFLINE` 分别取再合并，**不用**单次 `status=ALL`：
       * 列表接口只回首页 `limit=50` 且按创建时间倒序，`ALL` 下较新的 SOLD/OFFLINE
       * 会把较老的 ACTIVE 挤出首页 —— 那些商品查不到状态就会被推导整条跳过，
       * 正好复现「卖家看不到在等的申请」。分开取让每个状态各自拥有 50 个名额。
       * 单状态超过 50 件时仍会漏（与「我的发布」同一上限，见 pending.ts 边界 6）。
       */
      const [active, offline] = await Promise.all([
        queryClient.fetchQuery({
          queryKey: profileKeys.listings(ownerId, 'ACTIVE'),
          queryFn: () => fetchMyListings(ownerId, 'ACTIVE'),
          staleTime: 15_000,
        }),
        queryClient.fetchQuery({
          queryKey: profileKeys.listings(ownerId, 'OFFLINE'),
          queryFn: () => fetchMyListings(ownerId, 'OFFLINE'),
          staleTime: 15_000,
        }),
      ])
      const byId = new Map<ListingId, ListingStatus>([
        ...active.items.map((item) => [item.id, item.status] as const),
        ...offline.items.map((item) => [item.id, item.status] as const),
      ])
      if (byId.size === 0) return EMPTY_PENDING
      return loadPendingIndex(byId, fetchConversationPage, fetchMessagePage)
    },
    enabled: ownerId !== '',
    staleTime: 15_000,
  })
}

export type ProposalDecisionVariables = { conversationId: string; amountCents: number }

/**
 * 同意提案：唯一创建交易行的写操作。
 *
 * 成功后商品转 `RESERVED`，因此除了交易面还要失效待确认推导 —— 这一件不该再出现在
 * 「待确认」里，其余买家留在会话里的 `tx.proposal` 也不再有可操作性。
 */
export function useAcceptProposal(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId, amountCents }: ProposalDecisionVariables) =>
      acceptTransaction(conversationId, amountCents),
    onMutate: captureSession,
    onSuccess: (transaction, _variables, context) => {
      if (!isSessionCurrent(context)) return
      queryClient.setQueryData(profileKeys.order(ownerId, transaction.id), transaction)
      invalidateTransactionSurfaces(queryClient, ownerId)
      invalidatePending(queryClient, ownerId)
    },
  })
}

/** 拒绝提案：只写一条 `tx.rejected`，商品留在在售，所以只失效会话面与推导。 */
export function useRejectProposal(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ conversationId }: ProposalDecisionVariables) => rejectProposal(conversationId),
    onMutate: captureSession,
    onSuccess: (_message, _variables, context) => {
      if (!isSessionCurrent(context)) return
      invalidateChatSurfaces(queryClient)
      invalidatePending(queryClient, ownerId)
    },
  })
}

/**
 * 面交凭证状态（不含明文码）。
 *
 * `enabled` 由页面按「交易处于 PENDING_MEETUP」给：终态订单不该再去问凭证，
 * 免得给只读页面拉出一个永远不会有值的请求。
 */
export function useMeetupTokenStatus(ownerId: string, transactionId: string, enabled: boolean) {
  return useQuery({
    queryKey: profileKeys.meetupToken(ownerId, transactionId),
    queryFn: () => fetchMeetupTokenStatus(transactionId),
    enabled: enabled && ownerId !== '' && transactionId !== '',
    staleTime: 15_000,
  })
}

function invalidateMeetupToken(
  queryClient: QueryClient,
  ownerId: string,
  transactionId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: profileKeys.meetupToken(ownerId, transactionId),
  })
}

/**
 * 卖家取码。幂等「确保并读取」，所以重取不会换码；成功后只失效凭证状态
 * （明文码由调用方留在组件状态里，不进缓存 —— 缓存会被 devtools / 序列化带出去）。
 */
export function useIssueMeetupToken(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (transactionId: string) => issueMeetupToken(transactionId),
    onMutate: captureSession,
    onSuccess: (_token, transactionId, context) => {
      if (!isSessionCurrent(context)) return
      invalidateMeetupToken(queryClient, ownerId, transactionId)
    },
  })
}

export type RedeemVariables = {
  transactionId: string
  input: { kind: 'code'; code: string } | { kind: 'qr'; token: string }
}

/**
 * 核销（6 位码或二维码载荷）。
 *
 * 成功只代表「凭证已消费」，交易仍是 `PENDING_MEETUP` —— 契约用
 * `nextAction: 'CONFIRM_DELIVERY'` 表达下一步是双方各确认一次，页面据此引导到
 * 已有的「确认完成面交」，这里不替它推进终态。
 */
export function useRedeemMeetupToken(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ transactionId, input }: RedeemVariables) =>
      input.kind === 'code'
        ? verifyMeetupCode(transactionId, input.code)
        : redeemMeetupToken(transactionId, input.token),
    onMutate: captureSession,
    onSuccess: (_verification, variables, context) => {
      if (!isSessionCurrent(context)) return
      invalidateMeetupToken(queryClient, ownerId, variables.transactionId)
      void queryClient.invalidateQueries({
        queryKey: profileKeys.order(ownerId, variables.transactionId),
      })
    },
  })
}
