import {
  RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES,
  RECOMMENDATION_STRATEGY_VERSION_NONE,
  type RecommendationEventIngestResponse,
  type RecommendationEventInput,
  type RecommendationEventType,
  type RecommendationFeedResponse,
  RecommendationFeedResponseSchema,
} from '@fish/contracts/recommendation/schema'
import type { ApiErrorDetail } from '@fish/contracts/system/error'
import { newId } from '@fish/db/ids'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { type ListingService, ListingServiceError } from '../listings/service'
import type { RecommendationContext } from './context'
import { decodeRecommendationCursor, encodeRecommendationCursor } from './cursor'
import type {
  RecommendationEventRecord,
  RecommendationRequestRow,
  RecommendationStore,
} from './store'

/**
 * 推荐模块的错误：路由层把它映射成 `errorBody(code, message, details)` + HTTP status。
 *
 * 只暴露 `VALIDATION_FAILED`（422）：R1 的失败面只有"游标不可用"与"契约校验失败"，
 * 两者对客户端都是同一类处置（丢掉游标重开一次推荐请求）。
 *
 * `status` 必须是**字面量联合**（而不是 `number`）：Hono 的 `c.json(body, status)` 只接受
 * `ContentfulStatusCode`，宽化成 `number` 会直接在路由层编译失败。
 */
export class RecommendationServiceError extends Error {
  constructor(
    readonly status: 422,
    readonly code: 'VALIDATION_FAILED',
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message)
    this.name = 'RecommendationServiceError'
  }
}

export interface RecommendationFeedPage {
  response: RecommendationFeedResponse
  /** 客户端没带会话标识时服务端新发的那个；路由层据此回写响应头。 */
  issuedAnonymousSessionId: string | null
}

export interface RecommendationService {
  /** 开启（或继续）一次推荐请求：返回 `requestId` + 商品卡片页。 */
  startFeed(input: {
    viewerId: string | null
    anonymousSessionId: string | null
    limit: number
    cursor?: string
  }): Promise<RecommendationFeedPage>

  /** 批量写入客户端行为事件。 */
  ingest(input: {
    viewerId: string | null
    events: RecommendationEventInput[]
  }): Promise<RecommendationEventIngestResponse>

  /** 服务端已确证的行为（评论/会话/下单）落事件；归因缺失不算错误，写失败不影响主流程。 */
  recordDomainEvent(input: {
    viewerId: string | null
    anonymousSessionId: string | null
    listingId: string
    eventType: RecommendationEventType
    context: RecommendationContext
    occurredAt?: Date
  }): Promise<void>
}

/** 允许的时钟偏差：客户端时钟快于服务端时的容忍上限。 */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1_000

/** 事件保留期（#323 §M0 retention 决定）：早于保留期的补发没有价值，直接拒收。 */
const EVENT_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000

function invalidCursor(): RecommendationServiceError {
  return new RecommendationServiceError(422, 'VALIDATION_FAILED', 'cursor 无效', [
    { field: 'cursor', message: 'cursor 无效' },
  ])
}

/**
 * 归属校验：请求行是这次推荐请求的身份真值。
 *
 * - 登录用户发起的请求：以 `user_id` 为准（token 解析出的 userId 是唯一真值，会话标识不参与）；
 * - 匿名请求：以 `anonymous_session_id` 为准。
 *
 * 两种都不匹配即"这不是你的推荐请求"——但对外与"请求不存在"返回同一个 422：
 * 区分开等于把"某个 requestId 是否存在"变成可探测的预言机。
 */
function ownsRequest(
  row: RecommendationRequestRow,
  viewerId: string | null,
  anonymousSessionId: string | null,
): boolean {
  if (row.userId !== null) return row.userId === viewerId
  return row.anonymousSessionId === anonymousSessionId
}

export function createRecommendationService(deps: {
  store: RecommendationStore
  /** 复用确定性 Feed 的读路径：R1 不重写列表查询，只把结果包上推荐上下文。 */
  listings: Pick<ListingService, 'listFeed'>
}): RecommendationService {
  const { store, listings } = deps

  return {
    async startFeed({ viewerId, anonymousSessionId, limit, cursor }) {
      const issuedAnonymousSessionId = anonymousSessionId ?? newId()
      const sessionId = anonymousSessionId ?? issuedAnonymousSessionId

      let request: RecommendationRequestRow
      let listingCursor: string | undefined

      if (cursor === undefined) {
        request = await store.createRequest({
          userId: viewerId,
          anonymousSessionId: sessionId,
          strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
        })
      } else {
        const decoded = decodeRecommendationCursor(cursor)
        if (!decoded) throw invalidCursor()

        const [row] = await store.findRequests([decoded.requestId])
        if (!row || !ownsRequest(row, viewerId, sessionId)) throw invalidCursor()

        // 翻页复用**原请求行**：不新建 request，否则同一次滚动会被拆成两次推荐请求，
        // 客户端算出的 position 会从 0 重来，曝光序号在服务端出现重复。
        request = row
        listingCursor = decoded.listingCursor
      }

      // 内层商品游标由 listings 层校验（`listings/service.ts` 的 `decodeFeedCursor`）：坏游标在那里
      // 抛 `ListingServiceError(VALIDATION_FAILED)`。推荐层必须把这条 422 语义接下来，否则它会冒到
      // `app.onError`（只处理 HTTPException）变成 500 —— 同一个坏游标在 `GET /listings` 是 422。
      let page: Awaited<ReturnType<typeof listings.listFeed>>
      try {
        page = await listings.listFeed(viewerId, {
          sort: 'newest',
          limit,
          ...(listingCursor === undefined ? {} : { cursor: listingCursor }),
        })
      } catch (error) {
        if (error instanceof ListingServiceError && error.code === 'VALIDATION_FAILED') {
          throw invalidCursor()
        }
        throw error
      }

      const response = RecommendationFeedResponseSchema.parse({
        requestId: request.id,
        strategyVersion: request.strategyVersion,
        items: page.items,
        nextCursor:
          page.nextCursor === null
            ? null
            : encodeRecommendationCursor({
                listingCursor: page.nextCursor,
                requestId: request.id,
              }),
      })

      return {
        response,
        issuedAnonymousSessionId: anonymousSessionId === null ? issuedAnonymousSessionId : null,
      }
    },

    async ingest({ viewerId, events }) {
      const now = Date.now()
      const listingIds = events.map((event) =>
        decodePublicId(PUBLIC_ID_PREFIX.listing, event.listingId),
      )
      const requestIds = [
        ...new Set(
          events
            .map((event) => event.requestId)
            .filter((id): id is string => id !== null && id !== undefined),
        ),
      ]

      // 批量预取：单条事件一次查询会在 50 条批量下变成 100 次往返。
      const [existingListingIds, requestRows] = await Promise.all([
        store.findExistingListingIds([...new Set(listingIds)]),
        store.findRequests(requestIds),
      ])
      const knownListings = new Set(existingListingIds)
      const requestsById = new Map(requestRows.map((row) => [row.id, row]))

      const accepted: RecommendationEventRecord[] = []
      const rejectedReasons = new Map<string, number>()
      const reject = (reason: string) => {
        rejectedReasons.set(reason, (rejectedReasons.get(reason) ?? 0) + 1)
      }

      events.forEach((event, index) => {
        // 服务端确证类事件（评论/会话/交易）不接受客户端上报：这个端点是匿名可写的，照收就等于
        // 任何人都能伪造 PURCHASE / CHAT_START 污染训练数据。这四类的真值只有服务端写路径
        // （`recordDomainEvent`），所以表里出现它们必然是服务端写的。
        if (
          (RECOMMENDATION_SERVER_CONFIRMED_EVENT_TYPES as readonly string[]).includes(
            event.eventType,
          )
        ) {
          reject('server_confirmed_event_type')
          return
        }

        // 事件必须绑定真实商品：客户端可能把已删除/伪造的公开 id 发上来。
        const listingId = listingIds[index] as string
        if (!knownListings.has(listingId)) {
          reject('listing_not_found')
          return
        }

        const occurredAt = event.occurredAt === undefined ? now : Date.parse(event.occurredAt)
        if (occurredAt > now + MAX_CLOCK_SKEW_MS) {
          reject('occurred_at_in_future')
          return
        }
        if (occurredAt < now - EVENT_RETENTION_MS) {
          reject('occurred_at_too_old')
          return
        }

        let userId = viewerId
        let anonymousSessionId = event.anonymousSessionId ?? null
        const requestId = event.requestId ?? null

        if (requestId !== null) {
          const row = requestsById.get(requestId)
          if (!row) {
            reject('request_not_found')
            return
          }
          if (!ownsRequest(row, viewerId, anonymousSessionId)) {
            reject('identity_mismatch')
            return
          }
          // 归因身份以**请求行**为真值：匿名请求里的行为不因为"补发时已经登录"而记到账号上，
          // 反过来登录用户的请求也不会因为丢了会话标识而变成匿名行为。
          userId = row.userId
          anonymousSessionId = row.anonymousSessionId
        }

        accepted.push({
          eventId: event.eventId,
          userId,
          anonymousSessionId,
          requestId,
          listingId,
          eventType: event.eventType,
          // position / source 只在有 requestId 时才有语义：脱离推荐请求的"第 3 位"是噪声。
          position: requestId === null ? null : (event.position ?? null),
          // R1 的 Feed 是 `newest` 透传，只有 `fresh` 一条召回通道，所以客户端不带 source 时
          // 由服务端补上真值——**客户端不该猜召回通道**，那是服务端的知识：R3 起多路召回时
          // 通道映射由 Feed 侧记录（服务端知道每件商品来自哪一路），客户端仍然不需要改。
          source: requestId === null ? null : (event.source ?? 'fresh'),
          metadata: event.metadata ?? {},
          occurredAt: new Date(occurredAt),
        })
      })

      const inserted = await store.insertEvents(accepted)
      const rejected = events.length - accepted.length
      if (rejected > 0) {
        // 原因只写日志：客户端对这些原因无能为力，重试也不会变好。
        console.warn('[recommendation] 部分事件被拒收', {
          rejected,
          reasons: Object.fromEntries(rejectedReasons),
        })
      }

      return {
        accepted: inserted,
        // 撞唯一索引 = 客户端重试，是正常结果，不是错误。
        duplicates: accepted.length - inserted,
        rejected,
      }
    },

    async recordDomainEvent({
      viewerId,
      anonymousSessionId,
      listingId,
      eventType,
      context,
      occurredAt,
    }) {
      try {
        // 服务端写路径已经证明"行为发生了"，所以事件本身必须落库；只有**归因**可以丢。
        // 因此这里不用 ingest 的"归属不符就拒收"策略：归因对不上就退化成无归因事件。
        let requestId: string | null = null
        let userId = viewerId
        let sessionId = anonymousSessionId

        if (context.requestId !== null) {
          const [row] = await store.findRequests([context.requestId])
          if (row && ownsRequest(row, viewerId, anonymousSessionId)) {
            requestId = row.id
            userId = row.userId
            sessionId = row.anonymousSessionId
          }
        }

        await store.insertEvents([
          {
            eventId: newId(),
            userId,
            anonymousSessionId: sessionId,
            requestId,
            listingId,
            eventType,
            position: requestId === null ? null : context.position,
            source: requestId === null ? null : context.source,
            metadata: {},
            occurredAt: occurredAt ?? new Date(),
          },
        ])
      } catch (error) {
        // 埋点是旁路：写失败绝不能把用户已经成功的评论/下单变成 500。
        console.error('[recommendation] 领域事件写入失败', { eventType, listingId }, error)
      }
    },
  }
}
