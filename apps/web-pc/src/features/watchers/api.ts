import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { type ChatWatchersResponse, chatWatchersResponseSchema } from '@fish/contracts/chat/schema'
import { ApiError, apiRequest } from '../../lib/api-client'

/**
 * 「谁想要」域 API（#381）：`GET /listings/:id/watchers`。
 *
 * 名单与 `total` 都由服务端裁决：源是「对该商品已建立会话的买家」，且**只有商品卖家本人
 * 可读**（`apps/api/src/modules/conversations/watchers-router.ts`）。这里只做
 * 「拼路径 + 发请求 + 用契约收口」，不吞错误码 —— 哪个码落到哪种界面是展示层的事
 * （`watchersLoadError`）。
 */

/** 单页上限取契约默认值（1–50，服务端 default 20），翻页大小与小程序保持一致。 */
export const WATCHERS_PAGE_LIMIT = 20

/** 路径构造：`limit` 恒带，`cursor` 缺省时不带（服务端从最新一页开始）。 */
export function chatWatchersPath(listingId: string, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(WATCHERS_PAGE_LIMIT) })
  if (cursor !== undefined) params.set('cursor', cursor)
  return `${CHAT_ROUTES.watchers(listingId)}?${params.toString()}`
}

export async function fetchChatWatchers(
  listingId: string,
  cursor?: string,
): Promise<ChatWatchersResponse> {
  return chatWatchersResponseSchema.parse(await apiRequest(chatWatchersPath(listingId, cursor)))
}

/**
 * 名单加载结果。404 / 403 是**业务边界**（商品不存在 / 不是卖家），
 * 必须落成业务空态，不能和「网络挂了」混成同一个错误视图（#381 验收 4）。
 *
 * 注：Issue 原文写「非卖家落到 404」，但服务端实现是 403 `NOT_LISTING_OWNER`
 * （`watchers-service.ts`：不存在 → 404，非卖家 → 403）。这里两种都收，
 * 比 Issue 的字面要求更严。
 */
export type WatchersLoadOutcome =
  | { kind: 'ok' }
  | { kind: 'listing-missing' }
  | { kind: 'not-owner' }
  | { kind: 'error'; message: string }

export function watchersLoadError(error: unknown): WatchersLoadOutcome {
  if (error instanceof ApiError) {
    if (error.status === 404 && error.code === 'LISTING_NOT_FOUND')
      return { kind: 'listing-missing' }
    if (error.status === 403 && error.code === 'NOT_LISTING_OWNER') return { kind: 'not-owner' }
    return { kind: 'error', message: error.message }
  }
  return { kind: 'error', message: '网络异常，请稍后重试' }
}
