import { RECOMMENDATION_HEADERS } from '@fish/contracts/recommendation/routes'
import type { RecommendationSource } from '@fish/contracts/recommendation/schema'
import {
  RECOMMENDATION_MAX_POSITION,
  RecommendationSourceSchema,
} from '@fish/contracts/recommendation/schema'
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
/**
 * 会话标识：非法/缺失都返回 null，由调用方决定补发（Feed）或放弃归因（事件写入）。
 *
 * 统一转小写：契约的 `z.uuid()` 与小程序的 `isUuidShape` 都接受大写，而 PG 的 `uuid` 列写入即
 * 规范化成小写、回读也是小写。若这里保留客户端原样大小写，`ownsRequest` 的 `===` 比对就会让
 * 「同一个合法会话标识」第一页 200、第二页 422，带该 requestId 的事件全被判 `identity_mismatch`。
 */
export function readAnonymousSessionId(c: Context): string | null {
  const raw = c.req.header(RECOMMENDATION_HEADERS.sessionId)
  if (!raw || !isUuidShape(raw)) return null
  return raw.toLowerCase()
}

export interface RecommendationContext {
  requestId: string | null
  /**
   * 用契约的 `RecommendationSource` 而不是手抄一份字面量联合：R3 往枚举里加了 `category`，
   * 手抄的副本当场就编译不过（TS2322）——通道集合每扩一次都要在两处改，迟早漏一处。
   */
  source: RecommendationSource | null
  position: number | null
}

/**
 * 读出本次业务请求携带的推荐归因。
 *
 * `position` 只接受 `[0, RECOMMENDATION_MAX_POSITION]` 内的整数：负数或小数说明客户端算错了，
 * 而超过上限的值（int4 溢出）会让整条 INSERT 失败、事件被写失败的 catch 吞掉——归因不值得
 * 用整条事件陪葬，所以一律当作没有归因。
 */
export function readRecommendationContext(c: Context): RecommendationContext {
  const requestIdRaw = c.req.header(RECOMMENDATION_HEADERS.requestId)
  const sourceRaw = c.req.header(RECOMMENDATION_HEADERS.source)
  const sourceParsed = sourceRaw ? RecommendationSourceSchema.safeParse(sourceRaw) : null
  const positionRaw = c.req.header(RECOMMENDATION_HEADERS.position)
  // 只认规范的十进制整数字串。`Number.parseInt` 会把 `5.9` 读成 5、`1e3` 读成 1、` 7 ` 读成 7，
  // 与请求体 `z.number().int()` 的严格口径不一致——分析维度会凭空多出错误的位次。
  const position =
    positionRaw && /^\d+$/.test(positionRaw) ? Number.parseInt(positionRaw, 10) : Number.NaN

  return {
    // requestId 同样转小写：它与 `recommendation_requests.id` 比对，PG 回读的是小写。
    requestId: requestIdRaw && isUuidShape(requestIdRaw) ? requestIdRaw.toLowerCase() : null,
    source: sourceParsed?.success ? sourceParsed.data : null,
    position:
      Number.isInteger(position) && position >= 0 && position <= RECOMMENDATION_MAX_POSITION
        ? position
        : null,
  }
}
