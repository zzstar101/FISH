import type { Me } from '@fish/contracts/auth/user'
import type { VerificationStatus } from '@fish/contracts/auth/verification'
import type { QueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { profileKeys } from '../profile/queries'

/**
 * 认证状态查询。key 以 `pc` 开头：`resetPcSession` 只按 `['pc']` 前缀清理，
 * 换号时这条查询必须一起被清掉，否则会把 A 的认证状态展示给 B。
 */
export const verificationStatusKey = () => ['pc', 'verify', 'status'] as const

/**
 * 校验成功后的缓存写入（#380 验收 2：徽章**立即**更新，不需要整页刷新）。
 *
 * 两件事，缺一不可：
 * - `Me` 直接反映服务端返回的权威状态 —— 顶栏徽章读的是 `Me`，写完即变；
 * - 失效 profile 聚合读模型 —— 个人中心的徽章读的是它（不是 `Me`），不失效就会在
 *   15s `staleTime` 内继续显示「未认证」。
 *
 * 单独成函数而不是写在 mutation 的 `onSuccess` 里：web-pc 没有 jsdom，
 * 组件交互测不了，这条接线只能靠直接驱动 QueryClient 来守（见 `./queries.test.ts`）。
 */
export function applyVerificationResult(
  queryClient: QueryClient,
  ownerId: string,
  result: VerificationStatus,
): Promise<void> {
  const previous = queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)
  // `null` = 未登录（契约里 401 是正常态）；此时没有身份可更新，也不该造一个出来。
  if (previous) {
    queryClient.setQueryData<Me>(AUTH_ME_QUERY_KEY, {
      ...previous,
      authStatus: result.authStatus,
      verifiedAt: result.verifiedAt,
    })
  }
  queryClient.setQueryData(verificationStatusKey(), result)
  return queryClient.invalidateQueries({ queryKey: profileKeys.aggregate(ownerId) })
}
