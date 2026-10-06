import type { Me } from '@fish/contracts/auth/user'
import type { QueryClient } from '@tanstack/react-query'
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { isUnauthenticatedError } from '../../lib/api-client'
import {
  AUTH_ME_QUERY_KEY,
  currentSessionGeneration,
  PC_QUERY_PREFIX,
  resetPcSession,
  resetPcSessionIfCurrent,
} from '../../lib/session-cache'
import { invalidateTransactionSurfaces } from '../profile/queries'
import { syncRecommendationViewer } from '../recommendation/queue'
import {
  fetchAccountDeletionStatus,
  fetchMe,
  logout,
  requestAccountDeletion,
  withdrawAccountDeletion,
} from './api'

export const authKeys = {
  me: () => AUTH_ME_QUERY_KEY,
}

/**
 * 注销状态的查询键（#464）。
 *
 * 两件事必须同时成立，别把它们混成一件：
 *
 * 1. 它**不属于** `authKeys.me()`。`Me` 契约冻结不携带注销态，这条查询读的是
 *    `/me/account-deletion` 这另一个资源，两者缓存必须分开（否则撤回注销会把 `/me`
 *    也标脏，触发一次无意义的身份重验）。
 * 2. 它**必须**落在 `['pc', …]` 前缀下，并且带 `ownerId`。`resetPcSession`
 *    （`lib/session-cache.ts`）是 PC 端**唯一**的跨账号隔离边界，它按 `[PC_QUERY_PREFIX]`
 *    前缀清理/重置缓存。键逃出这个前缀，换号后新用户会读到上一个账号的注销态
 *    —— B 会看到 A 的冷静期与到期日，而冷静期分支只给「撤回申请」，等于把别人的
 *    注销状态当自己的显示出来（对抗性审查 B1）。`ownerId` 是第二道锁，与
 *    `viewHistoryKeys.list(ownerId)` 同款：同一 tab 内身份换了，键也不同。
 */
export const accountDeletionKeys = {
  status: (ownerId: string) => [PC_QUERY_PREFIX, 'account-deletion', 'status', ownerId] as const,
}

/**
 * 未登录是 `/me` 的正常态（契约：登录态唯一判据就是它 401），
 * 所以在这里收敛成 `null`，而不是让每个调用方去解读 `isError`。
 */
export async function loadMe(queryClient: QueryClient): Promise<Me | null> {
  const generation = currentSessionGeneration()
  const previous = queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)

  try {
    const user = await fetchMe()
    // 共享同源 Cookie 可能在现有 Web/另一标签页由 A 换成 B，而 PC 没走登录 mutation。
    // 旧代际的迟到响应不能反过来把新身份覆盖回 A。
    if (generation !== currentSessionGeneration()) {
      return queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY) ?? null
    }
    // 冷启动首次建立身份、以及 query 缓存为空时不走 `resetPcSession` 的路径：这里补一次
    // 队列身份同步（身份没变时 `syncRecommendationViewer` 不动队列）。
    syncRecommendationViewer(user.id)
    if (previous === undefined) {
      // 首次建立会话时，公开详情/留言查询可能已经挂载；没有旧身份需要清理。
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, user)
      return user
    }
    if (previous?.id !== user.id) {
      const reset = await resetPcSessionIfCurrent(queryClient, user, generation, {
        cancelAuth: false,
      })
      if (!reset) return queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY) ?? null
    }
    return user
  } catch (error) {
    if (!isUnauthenticatedError(error)) throw error
    if (generation !== currentSessionGeneration()) return null
    // 401 = 未登录：队列身份落成匿名。旧身份的待发事件在 `syncRecommendationViewer` 里丢弃，
    // 否则它们会被下一次带登录 Cookie 的补发记到别人账号上。
    syncRecommendationViewer(null)
    if (previous === undefined) {
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, null)
      return null
    }
    // 公开详情/留言在匿名态仍挂载；身份未变时不能清掉其查询缓存。
    if (previous === null) return null

    // 当前查询正在执行，不能取消自己；只有同一会话代际的 401 才允许清场。
    await resetPcSessionIfCurrent(queryClient, null, generation, { cancelAuth: false })
    return null
  }
}

/**
 * `skipAuthRedirect`：`/me` 的 401 正是「未登录」，不该触发全局跳登录
 * （否则任何人打开首页都会被弹到登录页）。见 `lib/query-client.ts`。
 */
export const meQueryOptions = (queryClient: QueryClient) =>
  queryOptions({
    queryKey: authKeys.me(),
    queryFn: () => loadMe(queryClient),
    staleTime: 60_000,
    // 共享 Cookie 可在另一标签页换号；即使缓存仍 fresh，回到 PC 也必须重验身份。
    refetchOnWindowFocus: 'always',
    meta: { skipAuthRedirect: true },
  })

export function useMe() {
  const queryClient = useQueryClient()
  return useQuery(meQueryOptions(queryClient))
}

export function useLogout() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: logout,
    onSuccess: () => resetPcSession(queryClient, null),
  })
}

/**
 * 注销状态（#464）。`staleTime: 0` 是刻意的：这条状态决定个人中心渲染「申请注销」还是
 * 「撤回申请」，而它会被另一个标签页、另一台设备（撤回）以及 worker（到期去标识化）改写，
 * 缓存里留旧的会让用户看到一个已经过期的入口。
 */
export function useAccountDeletionStatus(ownerId: string) {
  return useQuery({
    queryKey: accountDeletionKeys.status(ownerId),
    queryFn: fetchAccountDeletionStatus,
    staleTime: 0,
  })
}

type SessionMutationContext = { generation: number }

/**
 * 申请注销。
 *
 * 成功后用 POST 响应**直接写入**状态缓存（不回读）：契约规定申请与撤回都回完整状态，
 * 服务端返回的就是权威值，再打一次 GET 只是多一个可能失败的往返。
 *
 * 同时失效「我的发布 / 订单 / 个人中心聚合 / 会话」：申请会把在架商品下架，
 * 这些界面里的商品状态此刻已经过期。`ownerId` 由调用方捕获传入而不是从缓存读，
 * 换号场景下也只会失效旧账号自己的查询，不会污染新身份的缓存。
 *
 * 落缓存前还要比对**会话代际**（沿用 view-history / chat / wish 的 mutation 模式）：
 * 换号会递增代际，A 的迟到响应不能写进 B 的缓存。键里虽然有 `ownerId`，但那是调用方
 * 渲染时捕获的闭包值，迟到响应拿到的仍是 A 的键——不比对代际就还是把 A 的注销态
 * 留在了缓存里（对抗性审查 B1 的第二条路径）。
 */

export function useRequestAccountDeletion(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: requestAccountDeletion,
    onMutate: (): SessionMutationContext => ({ generation: currentSessionGeneration() }),
    onSuccess: (result, _variables, context) => {
      if (context === undefined || context.generation !== currentSessionGeneration()) return
      queryClient.setQueryData(accountDeletionKeys.status(ownerId), {
        status: result.status,
        requestedAt: result.requestedAt,
        purgeScheduledAt: result.purgeScheduledAt,
      })
      invalidateTransactionSurfaces(queryClient, ownerId)
    },
  })
}

/** 撤回注销申请。撤回**不恢复商品上架**，所以商品列表仍需失效一次以显示真实状态。 */
export function useWithdrawAccountDeletion(ownerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: withdrawAccountDeletion,
    onMutate: (): SessionMutationContext => ({ generation: currentSessionGeneration() }),
    onSuccess: (result, _variables, context) => {
      if (context === undefined || context.generation !== currentSessionGeneration()) return
      queryClient.setQueryData(accountDeletionKeys.status(ownerId), result)
      invalidateTransactionSurfaces(queryClient, ownerId)
    },
  })
}
