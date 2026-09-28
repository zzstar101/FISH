import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import { RecommendationSourceSchema } from '@fish/contracts/recommendation/schema'
import type { Context } from 'hono'
import { isUuidShape } from './uuid'

/**
 * 推荐上下文请求头解析（R1「Recommendation Context」）。
 *
 * 设计原则：**头缺失或非法 → 归因为空，绝不 4xx**。这些头是带外信息，跟着收藏/评论/下单等
 * 业务请求走；一个坏头不该让用户的下单失败，它只该让这次行为失去推荐归因。
 *
 * 头里的值一律当作**待校验的声明**：真正的身份真值来自 token（`userId`）与
 * `recommendation_requests` 行，服务端在写事件前比对（见 service.ts）。
 */
/** 会话标识：非法/缺失都返回 null，由调用方决定补发（Feed）或放弃归因（事件写入）。 */
export function readAnonymousSessionId(c: Context): string | null {
  const raw = c.req.header(RECOMMENDATION_HEADERS.sessionId)
  if (!raw || !isUuidShape(raw)) return null
  return raw
}

export interface RecommendationContext {
  requestId: string | null
  source: 'fresh' | 'popular' | 'semantic' | 'wish' | 'follow' | 'similar' | 'explore' | null
  position: number | null
}

/**
 * 读出本次业务请求携带的推荐归因。
 *
 * `position` 只接受非负整数：曝光序号是"第几位"的编码，负数或小数说明客户端算错了，
 * 与其存进去污染统计，不如当作没有归因。
 */
export function readRecommendationContext(c: Context): RecommendationContext {
  const requestIdRaw = c.req.header(RECOMMENDATION_HEADERS.requestId)
  const sourceRaw = c.req.header(RECOMMENDATION_HEADERS.source)
  const sourceParsed = sourceRaw ? RecommendationSourceSchema.safeParse(sourceRaw) : null
  const positionRaw = c.req.header(RECOMMENDATION_HEADERS.position)
  const position = positionRaw ? Number.parseInt(positionRaw, 10) : Number.NaN

  return {
    requestId: requestIdRaw && isUuidShape(requestIdRaw) ? requestIdRaw : null,
    source: sourceParsed?.success ? sourceParsed.data : null,
    position: Number.isInteger(position) && position >= 0 ? position : null,
  }
}
