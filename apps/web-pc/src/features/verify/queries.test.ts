import { describe, expect, test } from 'bun:test'
import type { Me } from '@fish/contracts/auth/user'
import type { VerificationStatus } from '@fish/contracts/auth/verification'
import { QueryClient } from '@tanstack/react-query'
import { AUTH_ME_QUERY_KEY } from '../../lib/session-cache'
import { profileKeys } from '../profile/queries'
import { applyVerificationResult, verificationStatusKey } from './queries'

/**
 * #380 验收 2 的接线：校验成功后顶栏与个人中心徽章**立即**更新。
 *
 * 这条接线只存在于 mutation 的 `onSuccess` 里，而 web-pc 没有 jsdom、点不了按钮，
 * 所以把写入抽成 `applyVerificationResult` 直接驱动 QueryClient 来守
 * （删掉函数体里的任一行，本文件都会红）。
 */
const OWNER = 'usr_01jc000000e00800000000000a'

const ME: Me = {
  id: OWNER,
  nickname: '阿岚',
  avatarUrl: null,
  authStatus: 'UNVERIFIED',
  verifiedAt: null,
  phoneBound: false,
  maskedPhone: null,
  // #179 起 `Me` 多了个性签名：本用例不关心，给 null。
  signature: null,
}

const VERIFIED: VerificationStatus = {
  authStatus: 'VERIFIED',
  verifiedAt: '2026-10-01T02:03:04.000Z',
  maskedEmail: 'a***@gzasc.edu.cn',
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

describe('applyVerificationResult', () => {
  test('Me 立即变 VERIFIED，其余字段原样保留（顶栏徽章读的就是它）', async () => {
    const queryClient = newClient()
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME)

    await applyVerificationResult(queryClient, OWNER, VERIFIED)

    expect(queryClient.getQueryData<Me | null>(AUTH_ME_QUERY_KEY)).toEqual({
      ...ME,
      authStatus: 'VERIFIED',
      verifiedAt: '2026-10-01T02:03:04.000Z',
    })
  })

  test('权威状态写进 verify 查询缓存，已认证态不必再打一次 status', async () => {
    const queryClient = newClient()

    await applyVerificationResult(queryClient, OWNER, VERIFIED)

    expect(queryClient.getQueryData<VerificationStatus>(verificationStatusKey())).toEqual(VERIFIED)
  })

  test('profile 聚合读模型被失效：个人中心徽章读的是它，不是 Me', async () => {
    const queryClient = newClient()
    const aggregateKey = profileKeys.aggregate(OWNER)
    queryClient.setQueryData(aggregateKey, {
      user: ME,
      stats: { activeListings: 0, activeWishes: 0, completedTransactions: 0 },
      listings: [],
      wishes: [],
      transactions: [],
    })
    expect(queryClient.getQueryState(aggregateKey)?.isInvalidated).toBe(false)

    await applyVerificationResult(queryClient, OWNER, VERIFIED)

    expect(queryClient.getQueryState(aggregateKey)?.isInvalidated).toBe(true)
  })

  test('未登录（Me 为 null）时不凭空造出身份', async () => {
    const queryClient = newClient()
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, null)

    await applyVerificationResult(queryClient, OWNER, VERIFIED)

    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toBeNull()
  })
})
