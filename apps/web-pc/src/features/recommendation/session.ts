/**
 * 匿名会话标识（#323 R1）。
 *
 * 服务端用 `(requestId, anonymousSessionId)` 校验事件归属：曝光事件的会话必须和
 * 推荐请求行上的会话一致，否则整条被判 `identity_mismatch` 拒收。所以这个值必须
 * 持久化——会话一丢，离线队列里补发的曝光就全部对不上号。
 * TTL 180 天与服务端的事件保留期一致。
 */
const SESSION_STORAGE_KEY = 'fish.recommendation.sessionId'
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1_000

type StoredSession = { id: string; expiresAt: number }

/**
 * 读取结果区分「存储不可用」和「存储可用但没有有效会话」：
 * 前者只能退回内存兜底（隐私模式 / 存储被禁用），后者说明确实该生成一个新的。
 * 不区分的话，内存里的旧值会盖住「已被清空或已过期」的存储，会话永远不刷新。
 */
type StoredSessionRead = { available: false } | { available: true; session: StoredSession | null }

/** localStorage 不可用时的兜底：至少保证同一页面生命周期内用的是同一个会话。 */
let memorySession: string | null = null

function readStoredSession(): StoredSessionRead {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY)
    if (raw === null) return { available: true, session: null }

    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { available: true, session: null }
    if (!('id' in parsed) || !('expiresAt' in parsed)) return { available: true, session: null }
    const { id, expiresAt } = parsed
    if (typeof id !== 'string' || id.length === 0) return { available: true, session: null }
    if (typeof expiresAt !== 'number' || expiresAt <= Date.now())
      return { available: true, session: null }
    return { available: true, session: { id, expiresAt } }
  } catch {
    // 存储被禁用或值被改坏：退回内存兜底。
    return { available: false }
  }
}

function writeSession(id: string): void {
  try {
    const value: StoredSession = { id, expiresAt: Date.now() + SESSION_TTL_MS }
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // 写不进去也不能让埋点把页面拖崩：埋点是旁路。
  }
}

/** 读取当前匿名会话；没有、已过期或存储不可用时返回 null（不生成）。 */
export function readAnonymousSessionId(): string | null {
  const stored = readStoredSession()
  return stored.available ? (stored.session?.id ?? null) : memorySession
}

/** 读取当前匿名会话，缺失或过期时生成一个 UUIDv4 并持久化。 */
export function ensureAnonymousSessionId(): string {
  const stored = readStoredSession()
  if (stored.available) {
    if (stored.session !== null) return stored.session.id
    const created = crypto.randomUUID()
    writeSession(created)
    return created
  }

  memorySession ??= crypto.randomUUID()
  return memorySession
}

/**
 * 采纳服务端补发的会话标识。
 *
 * 客户端没带会话、或带的值服务端不认（比如本地存储被清过）时，服务端会在响应头
 * 回写一个新的。不采纳的话每次请求都会换会话，会话级信号全废。
 */
export function adoptAnonymousSessionId(id: string): void {
  if (id.length === 0) return
  memorySession = id
  writeSession(id)
}
