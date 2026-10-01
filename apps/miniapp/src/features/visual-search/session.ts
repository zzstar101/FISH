/**
 * 匿名识图会话（#324 后端契约；匿名主体口径见 `apps/api/src/modules/visual-search/subject.ts`）。
 *
 * 服务端把匿名请求归到「客户端带回来的会话 + 出口 IP」两个**稳定**主体上，会话标识走的是
 * 推荐域那一份唯一实现（`readAnonymousSessionId`，头名 `x-anonymous-session-id`）。
 * 客户端这边它承担两件事：
 *
 * 1. **查询图归属**：对象键（`visual-search/{subject}/…`）与台账都按主体派生。上传与搜索
 *    必须带同一个 id —— 换了 id，服务端会认为这个 `objectKey` 不属于你，搜索直接 400
 *    （防「引用他人查询图」的第二道闸）。
 * 2. **匿名限流桶**：会话是匿名配额的两个桶之一（另一个是 IP）。每次请求现造一个新 id 只
 *    会把会话桶重置，IP 桶照旧记账（`apps/api/src/modules/visual-search/rate-limit.ts`），
 *    所以没有「换 id 免额度」这回事。
 *
 * 生命周期与登录态无关（与推荐域同一取舍）：未登录也要有。登录后主体按 userId 归
 * （`subject.ts` 的 `viewerId` 分支），这个 id 不参与归属。
 *
 * TTL 180 天与推荐域一致：这是隐私口径（不留长期稳定的可追踪标识）而不是功能需要。
 */
import Taro from '@tarojs/taro'
import { isUuidShaped, randomUuidV4 } from '@/lib/uuid'

/** 存储 key：与推荐域的 `fish.recommendation.sessionId` **分开**（两个功能各自独立过期） */
const SESSION_KEY = 'fish.visualSearch.sessionId'

/** 会话有效期：180 天 */
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000

type StoredSession = { id: string; expiresAt: number }

function readStoredSession(): StoredSession | null {
  try {
    const raw: unknown = Taro.getStorageSync(SESSION_KEY)
    if (typeof raw !== 'object' || raw === null) return null
    const candidate = raw as { id?: unknown; expiresAt?: unknown }
    if (typeof candidate.id !== 'string' || !isUuidShaped(candidate.id)) return null
    // 过期即当作不存在：留着一个过期值会让服务端把它当成"这个主体的历史记录"，额度也会跟着错位
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

/** 当前会话 id；没有或已过期返回 null */
export function currentVisualSearchSessionId(): string | null {
  return readStoredSession()?.id ?? null
}

/** 取会话 id，缺失或过期就地生成一个并落盘 */
export function ensureVisualSearchSessionId(): string {
  const stored = readStoredSession()
  if (stored) return stored.id
  const id = randomUuidV4()
  writeStoredSession(id)
  return id
}

/**
 * 采纳服务端回写的会话 id。
 *
 * 服务端只在客户端没带（或带的值不合法）时才签发，并写在 `x-anonymous-session-id` 响应头里
 * （`apps/api/src/modules/visual-search/router.ts` 的 `resolveSubject`）。**必须覆盖本地**：
 * 上传拿到的对象键属于服务端这次用的主体，不采纳的话下次搜索带的是另一个 id，必然 400。
 */
export function adoptVisualSearchSessionId(issued: string | undefined): void {
  if (!issued || !isUuidShaped(issued)) return
  if (readStoredSession()?.id === issued) return
  writeStoredSession(issued)
}
