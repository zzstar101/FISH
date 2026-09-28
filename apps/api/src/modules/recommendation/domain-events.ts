import type { RecommendationEventType } from '@fish/contracts/recommendation/schema'
import type { Context } from 'hono'
import { readAnonymousSessionId, readRecommendationContext } from './context'
import type { RecommendationService } from './service'

/**
 * 服务端已确证行为的埋点适配器（#323 §M0：CHAT_START / COMMENT / TRANSACTION_START / PURCHASE）。
 *
 * 这些事件不该由客户端上报：评论成功、下单成功这些事实只有服务端知道，客户端重试/断网
 * 会让它们丢失或重复。各业务模块只依赖这个窄接口，不依赖推荐模块的 store / 游标 / 召回，
 * 依赖方向保持"业务模块 ← 一个只写事件的适配器"。
 *
 * 适配器内部不做错误处理：`RecommendationService.recordDomainEvent` 已经把异常全包了
 * （埋点失败只写日志），所以调用方可以安全地 `await` 它而不会让主流程变成 500。
 */
export interface RecommendationDomainRecorder {
  record(
    c: Context,
    input: {
      /** 已登录用户；匿名行为没有服务端确证路径，这里必填。 */
      viewerId: string
      /** 内部 uuid（业务模块已经解析过公开 id）。 */
      listingId: string
      eventType: RecommendationEventType
      occurredAt?: Date
    },
  ): Promise<void>
}

export function createRecommendationDomainRecorder(
  service: RecommendationService,
): RecommendationDomainRecorder {
  return {
    async record(c, input) {
      await service.recordDomainEvent({
        viewerId: input.viewerId,
        anonymousSessionId: readAnonymousSessionId(c),
        listingId: input.listingId,
        eventType: input.eventType,
        context: readRecommendationContext(c),
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      })
    },
  }
}
