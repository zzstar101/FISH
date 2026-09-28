/**
 * 行为事件的唯一入口（Issue #323 R1 §3.5 / §3.6）。
 *
 * 所有字段在这里一次定型，调用方只描述「发生了什么」：
 * - `eventId` 在这里生成，入队后不再改写 —— 重试靠它幂等；
 * - `anonymousSessionId` 同样**入队时固化**：队列里的事件可能在换会话之后才发出去，
 *   用发送时刻的会话 id 会与服务端那条推荐请求行的归属对不上（`identity_mismatch` 被拒）；
 * - `source` 客户端**不传**：R1 只有单通道，服务端按 requestId 补 `fresh`（规格 §1）。
 */
import type {
  RecommendationEventInput,
  RecommendationEventType,
} from '@fish/contracts/recommendation/schema'
import { ListingIdSchema } from '@fish/contracts/system/public-id'
import { randomUuidV4 } from '@/lib/uuid'
import { enqueueRecommendationEvent } from './queue'
import { currentRecommendationSessionId } from './session'

export type RecommendationAttribution = {
  requestId: string
  position: number
}

export type TrackRecommendationEventInput = {
  listingId: string
  eventType: RecommendationEventType
  /** 推荐归因；搜索 / 分类 / 卖家主页等入口没有，传 null 或不传 */
  attribution?: RecommendationAttribution | null
  /** 逐类型白名单里的判定数值（契约里全部是数字），调用方只传该类型允许的键 */
  metadata?: Record<string, number>
}

export function trackRecommendationEvent(input: TrackRecommendationEventInput): void {
  /*
    listingId 必须是公开 id（`lst_...`）。这条检查不是形式主义：演示 / 兜底数据用的是
    `l-001` 这类 fixture id，服务端一定按 `listing_not_found` 拒收，而契约的事件类型本身
    也只收公开 id —— 在这里收口，队列里就不会攒下一批注定发不出去、还要在冲刷时逐条告警的事件。
  */
  const parsedListingId = ListingIdSchema.safeParse(input.listingId)
  if (!parsedListingId.success) {
    console.warn('[recommendation] 跳过非公开 id 的埋点事件', input.eventType, input.listingId)
    return
  }
  const attribution = input.attribution ?? null
  const event: RecommendationEventInput = {
    eventId: randomUuidV4(),
    listingId: parsedListingId.data,
    eventType: input.eventType,
    requestId: attribution?.requestId ?? null,
    position: attribution?.position ?? null,
    anonymousSessionId: currentRecommendationSessionId(),
    // 发生时刻在入队时确定：离线补发时它才是「用户真的什么时候做的」这件事
    occurredAt: new Date().toISOString(),
  }
  if (input.metadata) event.metadata = input.metadata
  enqueueRecommendationEvent(event)
}
