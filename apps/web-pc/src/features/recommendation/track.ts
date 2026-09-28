import type {
  RecommendationEventInput,
  RecommendationEventType,
} from '@fish/contracts/recommendation/schema'
import type { ListingId } from '@fish/contracts/system/public-id'
import { enqueueRecommendationEvent } from './queue'
import { ensureAnonymousSessionId } from './session'

/**
 * 归因表：从推荐卡片点进详情时记下 `(requestId, position)`，详情页据此把
 * DETAIL_VIEW / LONG_VIEW / IMAGE_VIEW 挂回那次推荐请求。
 *
 * 内存 Map + sessionStorage 兜底：PC 站详情是同标签页路由跳转，内存通常就够；但用户
 * 可能在详情页刷新或复制链接新开标签页，那时只剩 sessionStorage 能接上归因。
 * 30 分钟 TTL：归因只对「紧接着发生的浏览」有意义，过期的归因会把无关行为算进推荐效果。
 */
const ATTRIBUTION_STORAGE_KEY = 'fish.recommendation.attribution'
const ATTRIBUTION_TTL_MS = 30 * 60 * 1_000

export type RecommendationAttribution = { requestId: string; position: number }

type AttributionEntry = RecommendationAttribution & { expiresAt: number }

const attributionMemory = new Map<string, AttributionEntry>()

function isAttributionEntry(value: unknown): value is AttributionEntry {
  if (typeof value !== 'object' || value === null) return false
  if (!('requestId' in value) || !('position' in value) || !('expiresAt' in value)) return false
  return (
    typeof value.requestId === 'string' &&
    typeof value.position === 'number' &&
    typeof value.expiresAt === 'number'
  )
}

function readAttributionStore(): Record<string, AttributionEntry> {
  let raw: string | null
  try {
    raw = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}

  const entries = parsed as Record<string, unknown>
  const store: Record<string, AttributionEntry> = {}
  for (const [listingId, entry] of Object.entries(entries)) {
    if (isAttributionEntry(entry)) store[listingId] = entry
  }
  return store
}

/** 记下这张卡片来自哪次推荐请求的哪个位置。 */
export function rememberAttribution(
  listingId: ListingId,
  attribution: RecommendationAttribution,
): void {
  const entry: AttributionEntry = { ...attribution, expiresAt: Date.now() + ATTRIBUTION_TTL_MS }
  attributionMemory.set(listingId, entry)

  const store = readAttributionStore()
  const now = Date.now()
  for (const [id, existing] of Object.entries(store)) {
    if (existing.expiresAt <= now) delete store[id]
  }
  store[listingId] = entry
  try {
    window.sessionStorage.setItem(ATTRIBUTION_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 写不进去就只用内存，归因降级但不影响主流程。
  }
}

/** 读取归因；没有或已过期返回 null（搜索、分类进来的浏览本来就没有归因）。 */
export function readAttribution(listingId: ListingId): RecommendationAttribution | null {
  const now = Date.now()

  // 存储优先：它才是跨刷新、跨标签页的权威记录；内存 Map 只兜「存储写不进去」（隐私模式、
  // 配额）的情况。反过来先读内存的话，同一标签页里上一段浏览留下的旧归因会盖住存储里的新值。
  const stored = readAttributionStore()[listingId]
  if (stored !== undefined) {
    if (stored.expiresAt > now) return { requestId: stored.requestId, position: stored.position }
    attributionMemory.delete(listingId)
    return null
  }

  const memory = attributionMemory.get(listingId)
  if (memory === undefined) return null
  if (memory.expiresAt > now) return { requestId: memory.requestId, position: memory.position }
  attributionMemory.delete(listingId)
  return null
}

export type TrackEventInput = {
  listingId: ListingId
  eventType: RecommendationEventType
  requestId?: string | null
  position?: number | null
  metadata?: Record<string, unknown>
}

/**
 * 上报一条行为事件。
 *
 * - `eventId` 在这里生成一次，之后重试沿用（服务端靠它去重）；
 * - `anonymousSessionId` 在**入队时**固化：离线队列补发时用户可能已经换了会话，
 *   到 flush 时再取会把历史行为记到新会话上；
 * - `source` 刻意不传：召回通道是服务端的知识，客户端猜错会污染归因；
 * - 没有 `requestId` 时不带 `position`：位置只在某次推荐请求内才有意义。
 */
export function trackEvent(input: TrackEventInput): void {
  const event: RecommendationEventInput = {
    eventId: crypto.randomUUID(),
    listingId: input.listingId,
    eventType: input.eventType,
    anonymousSessionId: ensureAnonymousSessionId(),
    occurredAt: new Date().toISOString(),
  }

  if (input.requestId !== undefined && input.requestId !== null) event.requestId = input.requestId
  if (input.position !== undefined && input.position !== null) event.position = input.position
  if (input.metadata !== undefined) event.metadata = input.metadata

  enqueueRecommendationEvent(event)
}

/** 上报一条挂在某商品上的事件，归因自动取。没有归因就不带 requestId，事件照发。 */
export function trackListingEvent(input: {
  listingId: ListingId
  eventType: RecommendationEventType
  metadata?: Record<string, unknown>
}): void {
  const attribution = readAttribution(input.listingId)
  trackEvent({
    listingId: input.listingId,
    eventType: input.eventType,
    requestId: attribution?.requestId ?? null,
    position: attribution?.position ?? null,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  })
}
