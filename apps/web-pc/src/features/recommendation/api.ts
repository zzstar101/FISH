import {
  RECOMMENDATION_HEADERS,
  RECOMMENDATION_ROUTES,
} from '@fish/contracts/recommendation/routes'
import {
  type RecommendationEventInput,
  type RecommendationFeedResponse,
  RecommendationFeedResponseSchema,
} from '@fish/contracts/recommendation/schema'
import { apiRequest, apiRequestWithResponse } from '../../lib/api-client'
import { adoptAnonymousSessionId, ensureAnonymousSessionId } from './session'

export type RecommendationFeedQuery = { limit?: number; cursor?: string }

/**
 * 推荐 Feed 的查询串。
 * `cursor` 对客户端不透明：只负责原样回传，禁止解析或构造
 * （服务端把 requestId 编在里面，翻页要复用同一个推荐请求）。
 */
export function recommendationFeedPath(query: RecommendationFeedQuery): string {
  const params = new URLSearchParams()
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  return `${RECOMMENDATION_ROUTES.feed}?${params.toString()}`
}

/**
 * 拉取推荐 Feed。
 *
 * 带上本地匿名会话标识；响应头里若有服务端补发的标识则采纳，否则后续曝光事件
 * 会和推荐请求行上的会话对不上，整条被拒收。
 */
export async function fetchRecommendationFeed(
  query: RecommendationFeedQuery,
): Promise<RecommendationFeedResponse> {
  const { payload, response } = await apiRequestWithResponse(recommendationFeedPath(query), {
    headers: { [RECOMMENDATION_HEADERS.sessionId]: ensureAnonymousSessionId() },
  })

  const issued = response.headers.get(RECOMMENDATION_HEADERS.sessionId)
  if (issued !== null) adoptAnonymousSessionId(issued)

  return RecommendationFeedResponseSchema.parse(payload)
}

/**
 * 批量上报行为事件。
 *
 * 匿名可写，但必须带站点现有凭证：同源 fetch 自动带 Cookie，登录用户的曝光才能
 * 归到 userId 上。`202` 里的 `duplicates` 是重试的正常结果，不是错误。
 */
export async function postRecommendationEvents(
  events: readonly RecommendationEventInput[],
): Promise<void> {
  await apiRequest(RECOMMENDATION_ROUTES.events, {
    method: 'POST',
    body: JSON.stringify({ events }),
  })
}
