import { ACCOUNT_DELETION_ROUTES } from '@fish/contracts/account-deletion/routes'
import {
  ACCOUNT_DELETION_CONFIRMATION_PHRASE,
  type AccountDeletionRequestResponse,
  AccountDeletionRequestResponseSchema,
  type AccountDeletionStatus,
  AccountDeletionStatusSchema,
} from '@fish/contracts/account-deletion/schema'
import { AuthResponseSchema } from '@fish/contracts/auth/session'
import type { Me } from '@fish/contracts/auth/user'
import { apiRequest } from '../../lib/api-client'

export async function logout(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' })
}

/**
 * 注销状态（#464）：三条方法落在同一个 URL 上，资源就是「我的注销申请」这一条状态。
 *
 * 注销态**不在** `Me` 里（#3 契约冻结），所以个人中心要单独读这里；读不到状态就不能
 * 渲染注销入口 —— 宁可显示读取失败，也不能猜一个「未申请」出来（否则冷静期内的用户
 * 会看到一个假的「申请注销」按钮）。
 */
export async function fetchAccountDeletionStatus(): Promise<AccountDeletionStatus> {
  return AccountDeletionStatusSchema.parse(await apiRequest(ACCOUNT_DELETION_ROUTES.status))
}

/**
 * 申请注销（幂等：已在冷静期内重复提交回 200 与既有状态，**不重置 7 天计时**）。
 *
 * 固定词由客户端按契约常量填入，用户必须手输过一遍才允许提交（见 `account-deletion.ts`）；
 * 服务端仍会独立校验，端上的比对只是即时反馈。
 */
export async function requestAccountDeletion(): Promise<AccountDeletionRequestResponse> {
  return AccountDeletionRequestResponseSchema.parse(
    await apiRequest(ACCOUNT_DELETION_ROUTES.status, {
      method: 'POST',
      body: JSON.stringify({ confirmation: ACCOUNT_DELETION_CONFIRMATION_PHRASE }),
    }),
  )
}

/** 撤回注销申请（幂等：不在冷静期时回 200 与当前状态）。 */
export async function withdrawAccountDeletion(): Promise<AccountDeletionStatus> {
  return AccountDeletionStatusSchema.parse(
    await apiRequest(ACCOUNT_DELETION_ROUTES.status, { method: 'DELETE' }),
  )
}

/**
 * `GET /me` 的响应是 `{ user: Me }`（#3 冻结契约第 1 节），进 UI 前先过一遍契约，
 * 后端形状漂移会在数据进入应用之前就暴露。
 */
export async function fetchMe(): Promise<Me> {
  return AuthResponseSchema.parse(await apiRequest('/me')).user
}
