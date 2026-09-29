/**
 * 推荐域的接口调用（Issue #323 R1 §2）。
 *
 * 传输层复用 `lib/request.ts`：那里已经处理了超时、错误信封与登录态 cookie 注入，
 * 这里只补两件推荐域特有的事 —— 带上匿名会话头、以及**读响应头**（服务端可能补发会话 id）。
 */

import {
  RECOMMENDATION_HEADERS,
  RECOMMENDATION_ROUTES,
} from '@fish/contracts/recommendation/routes'
import {
  RecommendationEventIngestResponseSchema,
  type RecommendationEventInput,
  type RecommendationFeedResponse,
  RecommendationFeedResponseSchema,
} from '@fish/contracts/recommendation/schema'
import { apiRequestWithMeta, readResponseHeader } from '@/lib/request'
import { adoptRecommendationSessionId, ensureRecommendationSessionId } from './session'

/**
 * 首页一次取多少件。契约上限是 50（`RecommendationFeedQuerySchema`），取满一屏多；
 * 推荐 Feed 没有分页入口，首页是单屏瀑布流，所以一次取满。
 */
const FEED_LIMIT = 50

/**
 * 拉一次推荐 Feed。
 *
 * 响应里的 `requestId` 是后续曝光与详情归因的锚点，必须原样带回服务端；
 * `nextCursor` 是不透明串，R1 的首页不翻页，所以这里不透出。
 */
export async function fetchRecommendationFeed(): Promise<RecommendationFeedResponse> {
  const sessionId = ensureRecommendationSessionId()
  const { data, headers } = await apiRequestWithMeta(RECOMMENDATION_ROUTES.feed, {
    query: { limit: FEED_LIMIT },
    headers: { [RECOMMENDATION_HEADERS.sessionId]: sessionId },
  })
  // 服务端可能补发会话 id（本地那份它不认时）：先采纳再返回，后面的事件才挂得上同一条请求行
  adoptRecommendationSessionId(readResponseHeader(headers, RECOMMENDATION_HEADERS.sessionId))
  return RecommendationFeedResponseSchema.parse(data)
}

/**
 * 批量写入行为事件。接口是 fire-and-forget（202），只关心「这批被收下了没有」：
 * 响应体里的 accepted / duplicates / rejected 不影响调用方决策（rejected 重试也不会变好），
 * 所以解析失败只留日志，不抛错 —— 抛错会让队列把一批已经被收下的事件又重发一次。
 */
export async function postRecommendationEvents(events: RecommendationEventInput[]): Promise<void> {
  const { data } = await apiRequestWithMeta(RECOMMENDATION_ROUTES.events, {
    method: 'POST',
    body: { events },
  })
  const parsed = RecommendationEventIngestResponseSchema.safeParse(data)
  if (!parsed.success) {
    console.warn('[recommendation] 事件写入响应形状异常', parsed.error.issues)
    return
  }
  /*
    `rejected` = 通过契约校验但服务端**拒收**的条数（商品不存在 / 归属与 requestId 不符 /
    `occurredAt` 越界）。客户端重试不会变好，所以只留一条日志让人能顺着查；不弹提示、
    也不重发 —— 静默吞掉的话，线上只会看到「事件写进去了」却查不出为什么数据少了。
  */
  if (parsed.data.rejected > 0) {
    console.warn('[recommendation] 行为事件被服务端拒收', {
      rejected: parsed.data.rejected,
      accepted: parsed.data.accepted,
      duplicates: parsed.data.duplicates,
    })
  }
}
