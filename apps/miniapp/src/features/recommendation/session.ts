/**
 * 匿名推荐会话（Issue #323 R1 §3.1）。
 *
 * 服务端用这个 id 把「同一次滚动」里的推荐请求与随后的事件串起来。它的生命周期必须
 * **独立于登录态**：未登录时也要有（否则匿名用户的曝光事件全部因归属不符被拒），
 * 登录后仍沿用（换 id 会让这次会话里已发出的曝光与新事件分属两个会话）。
 *
 * TTL 180 天是隐私口径而不是功能需要：过期换新，避免一个长期稳定的可追踪标识。
 */
import Taro from '@tarojs/taro'
import { isUuidShaped, randomUuidV4 } from '@/lib/uuid'

/** 存储 key：规格固定值，不要改名（两端排查时按同一个 key 对齐） */
const SESSION_KEY = 'fish.recommendation.sessionId'

/** 会话有效期：180 天 */
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000

type StoredSession = { id: string; expiresAt: number }

function readStoredSession(): StoredSession | null {
  try {
    const raw: unknown = Taro.getStorageSync(SESSION_KEY)
    if (typeof raw !== 'object' || raw === null) return null
    const candidate = raw as { id?: unknown; expiresAt?: unknown }
    if (typeof candidate.id !== 'string' || !isUuidShaped(candidate.id)) return null
    // 过期即当作不存在：留着一个过期值会让服务端把新事件按 identity_mismatch 逐条拒掉
    if (typeof candidate.expiresAt !== 'number' || candidate.expiresAt <= Date.now()) return null
    return { id: candidate.id, expiresAt: candidate.expiresAt }
  } catch {
    return null
  }
}

function writeStoredSession(id: string): void {
  try {
    Taro.setStorageSync(SESSION_KEY, { id, expiresAt: Date.now() + SESSION_TTL_MS })
  } catch {
    /* 存储失败不致命：本次进程内仍可用返回值 */
  }
}

/** 当前会话 id；没有或已过期返回 null（事件在入队时取用，取不到就不带该字段） */
export function currentRecommendationSessionId(): string | null {
  return readStoredSession()?.id ?? null
}

/** 取会话 id，缺失或过期就地生成一个并落盘 */
export function ensureRecommendationSessionId(): string {
  const stored = readStoredSession()
  if (stored) return stored.id
  const id = randomUuidV4()
  writeStoredSession(id)
  return id
}

/**
 * 采纳服务端在响应头里补发的会话 id（规格 §2：服务端发现缺失时会补发并在响应头回写）。
 *
 * **必须覆盖本地**：这批曝光事件的 `anonymousSessionId` 要与服务端那条推荐请求行的归属一致，
 * 不一致会被逐条 `identity_mismatch` 拒收。所以 Feed 请求一回来就采纳，再生成曝光事件。
 */
export function adoptRecommendationSessionId(issued: string | undefined): void {
  if (!issued || !isUuidShaped(issued)) return
  if (readStoredSession()?.id === issued) return
  writeStoredSession(issued)
}
