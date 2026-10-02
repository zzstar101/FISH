import {
  INTEREST_STRATEGY_VERSION,
  interestLookbackStart,
} from '@fish/contracts/recommendation/interest'
import {
  composeRecommendationStrategyVersion,
  RANK_NEGATIVE_FEEDBACK_EVENT_TYPES,
  RANK_STRATEGY_VERSION,
  RECOMMENDATION_SNAPSHOT_MAX_ITEMS,
  RECOMMENDATION_STRATEGY_VERSION_RULE,
} from '@fish/contracts/recommendation/rank'
import { RECALL_STRATEGY_VERSION } from '@fish/contracts/recommendation/recall'
import {
  RECOMMENDATION_FEED_ATTRIBUTED_EVENT_TYPES,
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
import { resolveRecommendationIdentity } from './identity'
import type { InterestRefreshQueue } from './interest-queue'
import { buildNegativeFeedbackSignals, type NegativeFeedbackSignals } from './rank/feedback'
import { rerankCandidates } from './rank/rerank'
import { type ScoredCandidate, scoreCandidates } from './rank/score'
import type { RecommendationRecall } from './recall/service'
import type {
  RecommendationEventRecord,
  RecommendationRequestItemRecord,
  RecommendationRequestRow,
  RecommendationStore,
} from './store'

/**
 * 推荐模块的错误：路由层把它映射成 `errorBody(code, message, details)` + HTTP status。
 *
 * 只暴露 `VALIDATION_FAILED`（422）：对客户端而言"游标不可用"与"契约校验失败"是同一类处置
 * （丢掉游标重开一次推荐请求）。
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

/** `(requestId, listingId)` 复合键：同一商品可能出现在多次请求里，键必须带上请求。 */
function attributionKey(requestId: string, listingId: string): string {
  return `${requestId}:${listingId}`
}

export function createRecommendationService(deps: {
  store: RecommendationStore
  /**
   * 复用确定性 Feed 的读路径：R1 不重写列表查询。R4 起多了一个 `listCardsByIds` —— 排序结果的
   * 顺序由推荐层决定，商品层因此需要"给我这几件的卡片"这条读路径。
   */
  listings: Pick<ListingService, 'listFeed' | 'listCardsByIds'>
  /** 多路召回（R3）。整层不抛错的约定由它自己保证，这里仍然兜一层。 */
  recall: RecommendationRecall
  /**
   * 长期画像重算的投递口（#323 R2）。登录用户的行为一落库就投一条 `REFRESH_USER_INTEREST`；
   * 匿名行为不投（长期画像只给登录用户），session 画像由 api 请求时实时算、不落库。
   */
  interest: InterestRefreshQueue
  /** 便于测试注入固定时钟；缺省取系统时间。 */
  clock?: () => Date
}): RecommendationService {
  const { store, listings, recall, interest } = deps
  const clock = deps.clock ?? (() => new Date())

  /**
   * 投递长期画像重算。**失败不能让行为写入变成 500**：事件已经落库，客户端重试也只会撞
   * `event_id` 唯一索引；投递失败时这个用户的画像停在旧数据上，由 R6 的补算兜住，而不是把
   * "埋点投递不上"变成用户可见的失败（埋点是旁路，与 `recordDomainEvent` 的取舍一致）。
   *
   * 去重后逐个投：一条批量事件里同一用户的多次行为（一屏曝光 + 一次点开）只需一次重算，
   * 而 `jobs` 的部分唯一索引本来也只允许一条待跑 job。
   */
  async function enqueueInterestRefresh(userIds: Iterable<string>): Promise<void> {
    for (const userId of userIds) {
      try {
        await interest.enqueue(userId)
      } catch (error) {
        console.error('[recommendation] 兴趣画像重算投递失败', { userId }, error)
      }
    }
  }

  /**
   * 降级路径 & R1 旧游标的翻页路径：直接把商品 Feed 的 `newest` 页包上推荐上下文。
   *
   * 内层商品游标由 listings 层校验（`listings/service.ts` 的 `decodeFeedCursor`）：坏游标在那里
   * 抛 `ListingServiceError(VALIDATION_FAILED)`。推荐层必须把这条 422 语义接下来，否则它会冒到
   * `app.onError`（只处理 HTTPException）变成 500 —— 同一个坏游标在 `GET /listings` 是 422。
   */
  async function serveByNewest(input: {
    viewerId: string | null
    requestId: string
    strategyVersion: string
    limit: number
    listingCursor?: string
  }): Promise<RecommendationFeedResponse> {
    let page: Awaited<ReturnType<typeof listings.listFeed>>
    try {
      page = await listings.listFeed(input.viewerId, {
        sort: 'newest',
        limit: input.limit,
        ...(input.listingCursor === undefined ? {} : { cursor: input.listingCursor }),
      })
    } catch (error) {
      if (error instanceof ListingServiceError && error.code === 'VALIDATION_FAILED') {
        throw invalidCursor()
      }
      throw error
    }

    return RecommendationFeedResponseSchema.parse({
      requestId: input.requestId,
      strategyVersion: input.strategyVersion,
      items: page.items,
      nextCursor:
        page.nextCursor === null
          ? null
          : encodeRecommendationCursor({
              kind: 'passthrough',
              listingCursor: page.nextCursor,
              requestId: input.requestId,
            }),
    })
  }

  /** 读排序用的负反馈信号；失败返回 `null`（`negativeFeedback` 进明细的 `missing`，不是 0）。 */
  async function loadNegativeFeedback(
    viewerId: string | null,
    sessionId: string,
    now: Date,
  ): Promise<NegativeFeedbackSignals | null> {
    const identity = resolveRecommendationIdentity({
      userId: viewerId,
      anonymousSessionId: sessionId,
    })
    // 无身份 = 冷启动，没有"这个人的负反馈"可言：空信号是**已知的** 0，不是未知。
    if (identity === null) return buildNegativeFeedbackSignals({ events: [], now })
    try {
      const events = await store.findNegativeFeedbackEvents({
        identity,
        // 复用 R2 的长期回看窗口（180 天）+ 长期半衰期（14 天）：负反馈是"态度"，不是瞬时状态。
        since: interestLookbackStart(now),
        eventTypes: RANK_NEGATIVE_FEEDBACK_EVENT_TYPES,
      })
      return buildNegativeFeedbackSignals({ events, now })
    } catch (error) {
      console.warn('[recommendation] 负反馈读取失败，本次排序缺少 negativeFeedback 特征：', error)
      return null
    }
  }

  /**
   * 首次请求：召回 → 规则排序 → 重排 → 落快照 → 返回第一页。
   *
   * **快照的顺序按"真正发出去的卡片"编号**：`listCardsByIds` 是可见性的最终真值，它可能丢掉
   * 在召回之后、发卡片之前被下架的商品。丢掉的那几条从快照里移除，其余位置顺延 —— 否则客户端
   * 数出来的第 N 位与服务端记下的第 N 位会错开，归因真值当场失效。
   */
  async function createRankedFeed(input: {
    viewerId: string | null
    sessionId: string
    limit: number
  }): Promise<RecommendationFeedResponse> {
    const requestId = newId()
    const now = clock()

    let scored: ScoredCandidate[] = []
    let feedback: NegativeFeedbackSignals | null = null
    try {
      const recalled = await recall.recall({
        userId: input.viewerId,
        anonymousSessionId: input.sessionId,
      })
      feedback = await loadNegativeFeedback(input.viewerId, input.sessionId, now)
      scored = scoreCandidates({ candidates: recalled.candidates, feedback })
    } catch (error) {
      // 召回层自己保证不抛；这一层是纵深防御 —— 首页不能因为推荐管线里任何一处没守约而 500。
      console.warn('[recommendation] 召回/排序失败，本次 Feed 降级为 newest 透传：', error)
      scored = []
    }

    if (scored.length === 0) {
      // 冷启动（新用户、空库）或整条管线失败：退化成 R1 行为（newest + `rec-v1-none`），并且
      // **不写快照** —— 翻页继续走商品游标，语义与 R1 完全一致。
      const request = await store.createRequest({
        id: requestId,
        userId: input.viewerId,
        anonymousSessionId: input.sessionId,
        strategyVersion: RECOMMENDATION_STRATEGY_VERSION_NONE,
      })
      return serveByNewest({
        viewerId: input.viewerId,
        requestId: request.id,
        strategyVersion: request.strategyVersion,
        limit: input.limit,
      })
    }

    const reranked = rerankCandidates({
      scored,
      hiddenListingIds: feedback?.hiddenListingIds ?? new Set(),
      // 探索打散用 requestId 当种子：同一请求可重放，不同请求看到不同的探索位。
      seed: requestId,
      limit: RECOMMENDATION_SNAPSHOT_MAX_ITEMS,
    })

    const ordered = reranked.items
    const pageIds = ordered.slice(0, input.limit).map((item) => item.candidate.listingId)
    // `listCardsByIds` 按传入顺序返回，查不到的 id 不出现 ⇒ key 顺序就是真正发出去的商品顺序。
    const cards = await listings.listCardsByIds(input.viewerId, pageIds)
    const servedIds = [...cards.keys()]
    const orderedById = new Map(ordered.map((item) => [item.candidate.listingId, item]))

    const snapshotIds = [
      ...servedIds,
      ...ordered.slice(pageIds.length).map((item) => item.candidate.listingId),
    ]

    const strategyVersion = composeRecommendationStrategyVersion([
      RECOMMENDATION_STRATEGY_VERSION_RULE,
      INTEREST_STRATEGY_VERSION,
      RECALL_STRATEGY_VERSION,
      RANK_STRATEGY_VERSION,
    ])

    const request = await store.createRequest({
      id: requestId,
      userId: input.viewerId,
      anonymousSessionId: input.sessionId,
      strategyVersion,
    })

    const rows = buildSnapshotRows(request.id, snapshotIds, orderedById)
    let nextCursor: string | null = null
    try {
      await store.insertRequestItems(rows)
      if (servedIds.length < rows.length) {
        nextCursor = encodeRecommendationCursor({
          kind: 'snapshot',
          requestId: request.id,
          offset: servedIds.length,
        })
      }
    } catch (error) {
      // 快照写不进去 ⇒ 后续页拿不到稳定的顺序真值。宁可这一轮只能看第一页（`nextCursor=null`），
      // 也不要发一个会让第 2 页顺序错乱、归因全错的游标。
      console.error('[recommendation] 推荐快照写入失败，本次不提供后续页游标', error)
    }

    return RecommendationFeedResponseSchema.parse({
      requestId: request.id,
      strategyVersion: request.strategyVersion,
      items: [...cards.values()],
      nextCursor,
    })
  }

  /** 快照页：顺序已经冻结，翻页只是切片（不重跑召回/排序，否则同一批商品会重复或漏掉）。 */
  async function serveFromSnapshot(input: {
    viewerId: string | null
    row: RecommendationRequestRow
    offset: number
    limit: number
  }): Promise<RecommendationFeedResponse> {
    const items = await store.findRequestItems(input.row.id)
    const slice = items.slice(input.offset, input.offset + input.limit)
    const cards = await listings.listCardsByIds(
      input.viewerId,
      slice.map((item) => item.listingId),
    )
    // offset 前进的是**快照行数**而不是返回的卡片数：被跳过的行不应再被翻到。
    const nextOffset = input.offset + slice.length

    return RecommendationFeedResponseSchema.parse({
      requestId: input.row.id,
      strategyVersion: input.row.strategyVersion,
      items: [...cards.values()],
      nextCursor:
        nextOffset < items.length
          ? encodeRecommendationCursor({
              kind: 'snapshot',
              requestId: input.row.id,
              offset: nextOffset,
            })
          : null,
    })
  }

  return {
    async startFeed({ viewerId, anonymousSessionId, limit, cursor }) {
      const issuedAnonymousSessionId = anonymousSessionId ?? newId()
      const sessionId = anonymousSessionId ?? issuedAnonymousSessionId
      const issued = anonymousSessionId === null ? issuedAnonymousSessionId : null

      if (cursor === undefined) {
        return {
          response: await createRankedFeed({ viewerId, sessionId, limit }),
          issuedAnonymousSessionId: issued,
        }
      }

      const decoded = decodeRecommendationCursor(cursor)
      if (decoded === null) throw invalidCursor()

      const [row] = await store.findRequests([decoded.requestId])
      if (row === undefined || !ownsRequest(row, viewerId, sessionId)) throw invalidCursor()

      // 游标形状必须与请求行当时实际走的策略匹配。否则客户端只要自造一个
      // `{requestId, listingCursor}`，就能把一次**排序**请求变成 newest 透传：发出去的卡片没有快照行，
      // 它们随后的曝光会被归因层按 `attribution_not_found` 拒收 —— 用户侧表现为数据丢失。
      // 反向同理：`rec-v1-none` 的请求没有快照，snapshot 游标只会翻出空页。
      // 旧版（R1–R3）游标对应的请求行版本恒为 `rec-v1-none`（见 §7.1），所以这条校验不误伤在途游标。
      const degraded = row.strategyVersion === RECOMMENDATION_STRATEGY_VERSION_NONE
      if (degraded !== (decoded.kind === 'passthrough')) throw invalidCursor()

      // 翻页复用**原请求行**：不新建 request，否则同一次滚动会被拆成两次推荐请求，
      // 客户端算出的 position 会从 0 重来，曝光序号在服务端出现重复。
      const response =
        decoded.kind === 'snapshot'
          ? await serveFromSnapshot({ viewerId, row, offset: decoded.offset, limit })
          : await serveByNewest({
              viewerId,
              requestId: row.id,
              strategyVersion: row.strategyVersion,
              limit,
              listingCursor: decoded.listingCursor,
            })

      return { response, issuedAnonymousSessionId: issued }
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
            .filter((id): id is string => id !== null && id !== undefined)
            // 与 readAnonymousSessionId 同理：契约接受大写 uuid，PG 的 uuid 列回读是小写，
            // 不规范化就会把大写 requestId 判成 `request_not_found`。
            .map((id) => id.toLowerCase()),
        ),
      ]

      // 批量预取：单条事件一次查询会在 50 条批量下变成 100 次往返。
      const [existingListingIds, requestRows, attributions] = await Promise.all([
        store.findExistingListingIds([...new Set(listingIds)]),
        store.findRequests(requestIds),
        // 归因只可能命中 `(requestId, listingId)` 这两个键，所以把本批的商品 id 一起下推：
        // 不过滤就得把每个请求的整份快照（最坏 50 × 200 行）都拉回来再在内存里挑。
        store.findRequestItemAttribution({
          requestIds,
          listingIds: [...new Set(listingIds)],
        }),
      ])
      const knownListings = new Set(existingListingIds)
      const requestsById = new Map(requestRows.map((row) => [row.id, row]))
      // 服务端归因真值：排序模式下 position/source 只认快照，客户端上报一律作废。
      const attributionByKey = new Map(
        attributions.map((row) => [
          attributionKey(row.requestId, row.listingId),
          { position: row.position, source: row.primarySource },
        ]),
      )

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
        // 会话标识与 requestId 一律先规范化成小写再比对/落库：契约与小程序的 `isUuidShape`
        // 都接受大写，而 PG 的 uuid 列回读必然是小写，保留原样大小写会让 `ownsRequest` 误判。
        let anonymousSessionId = event.anonymousSessionId?.toLowerCase() ?? null
        const requestId = event.requestId?.toLowerCase() ?? null

        // position / source 只在有 requestId 时才有语义：脱离推荐请求的"第 3 位"是噪声。
        let position: number | null = null
        let source: RecommendationEventRecord['source'] = null

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

          // `rec-v1-none` = R1 的 newest 透传（没有快照）：沿用 R1 口径，客户端上报的 position
          // 就是唯一可用信息，source 缺省补 `fresh`。
          if (row.strategyVersion === RECOMMENDATION_STRATEGY_VERSION_NONE) {
            position = event.position ?? null
            source = event.source ?? 'fresh'
          } else {
            // 排序模式：命中快照才认这条曝光/行为，位置与通道以服务端当时返回的为准。
            const hit = attributionByKey.get(attributionKey(requestId, listingId))
            if (hit !== undefined) {
              position = hit.position
              source = hit.source
            } else if (
              (RECOMMENDATION_FEED_ATTRIBUTED_EVENT_TYPES as readonly string[]).includes(
                event.eventType,
              )
            ) {
              // `IMPRESSION` / `QUICK_SKIP` 在库里被 CHECK 约束要求"必须带 position"，而排序模式
              // 下拿不到快照行就意味着服务端无法证明这条曝光真的发生过 —— 直接拒收，而不是写一条
              // 会撞 CHECK 让整批 INSERT 失败（连带把同批其它合法事件一起丢掉的）记录。
              reject('attribution_not_found')
              return
            }
          }
        }

        accepted.push({
          eventId: event.eventId,
          userId,
          anonymousSessionId,
          requestId,
          listingId,
          eventType: event.eventType,
          position,
          source,
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

      // 长期画像的重算入口：**只看这次落库行为里的登录用户**。匿名会话的行为不投 job——
      // 长期画像只给登录用户（R2 决策），给匿名会话建长期画像等于凭空造一条跨设备身份。
      await enqueueInterestRefresh(
        new Set(
          accepted
            .map((record) => record.userId)
            .filter((userId): userId is string => userId !== null),
        ),
      )

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
        // `PURCHASE` 是商品级唯一事实：确认成交对已 COMPLETED 的交易是幂等返回（store 层直接
        // 返回既有行），而我们每次都新生成 `eventId`，`event_id` 唯一索引对这类重复无效——
        // 卖家重复点确认或重放 `POST /transactions/:id/confirm` 就能无界放大最强的正样本。
        // 按「一个商品只会成交一次」在写入前查一次：商品成交即转 SOLD，同一商品的第二条成交
        // 事件在业务上不存在（真要重卖，R6 也会按 listing 去重）。
        if (eventType === 'PURCHASE' && (await store.hasListingEvent(listingId, eventType))) {
          return
        }

        // 服务端写路径已经证明"行为发生了"，所以事件本身必须落库；只有**归因**可以丢。
        // 因此这里不用 ingest 的"归属不符就拒收"策略：归因对不上就退化成无归因事件。
        let requestId: string | null = null
        let userId = viewerId
        let sessionId = anonymousSessionId
        let position: number | null = null
        let source: RecommendationEventRecord['source'] = null

        if (context.requestId !== null) {
          const [row] = await store.findRequests([context.requestId])
          if (row && ownsRequest(row, viewerId, anonymousSessionId)) {
            requestId = row.id
            userId = row.userId
            sessionId = row.anonymousSessionId

            if (row.strategyVersion === RECOMMENDATION_STRATEGY_VERSION_NONE) {
              position = context.position
              source = context.source
            } else {
              // 排序模式：客户端带来的归因头只是**待校验的声明**，以快照为准。查不到就退化成
              // 无归因（而不是相信客户端）—— 这正是 R1 起推迟的"服务端曝光归因真值"。
              const items = await store.findRequestItemAttribution({
                requestIds: [row.id],
                listingIds: [listingId],
              })
              const hit = items.find((item) => item.listingId === listingId)
              position = hit?.position ?? null
              source = hit?.primarySource ?? null
            }
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
            position,
            source,
            metadata: {},
            occurredAt: occurredAt ?? new Date(),
          },
        ])

        // 强正反馈（收藏/发起会话/下单/成交）是画像里权重最高的一批行为，写入后必须立刻触发重算：
        // 靠"下一条客户端行为"来带动重算会让最强的信号迟迟不生效（用户成交后可能几小时不再刷首页）。
        // 归因缺失（`userId === null`）时没有长期画像可重算，跳过。
        if (userId !== null) {
          await enqueueInterestRefresh([userId])
        }
      } catch (error) {
        // 埋点是旁路：写失败绝不能把用户已经成功的评论/下单变成 500。
        console.error('[recommendation] 领域事件写入失败', { eventType, listingId }, error)
      }
    },
  }
}

/** 把重排后的顺序写成快照行；`position` 用输出下标，保证与发出去的顺序一一对应。 */
function buildSnapshotRows(
  requestId: string,
  listingIds: readonly string[],
  orderedById: ReadonlyMap<string, ScoredCandidate>,
): RecommendationRequestItemRecord[] {
  const rows: RecommendationRequestItemRecord[] = []
  for (const listingId of listingIds) {
    const item = orderedById.get(listingId)
    if (item === undefined) continue
    // `recallSources` 由 R3 保证按通道优先级有序，`[0]` 即 primarySource。
    const primarySource = item.candidate.recallSources[0]
    if (primarySource === undefined) continue
    rows.push({
      requestId,
      position: rows.length,
      listingId,
      primarySource,
      sources: [...item.candidate.recallSources],
      rankScore: item.rankScore,
      rankBreakdown: item.breakdown,
    })
  }
  return rows
}
