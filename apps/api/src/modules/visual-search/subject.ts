import { newId } from '@fish/db/ids'
import type { Context } from 'hono'
import { normalizeIp } from '../listings/trusted-ip'
// 匿名会话标识的读写只有一份实现（`x-anonymous-session-id` 的校验 + 小写归一化）。
// 各模块自己再写一遍 UUID 校验，迟早会和推荐模块的口径漂移。
import { readAnonymousSessionId } from '../recommendation/context'
import type { VisualSearchAttemptSubject } from './rate-limit'

/**
 * 查询图的主体归属（#324 M2）。
 *
 * 主体标识决定三件事，且三件事必须用**同一个**值：
 * 1. 对象键路径（`visual-search/{subject}/…`）——防"引用他人查询图"的第一道；
 * 2. 台账归属（`visual_query_images.subject_key`）——第二道；
 * 3. 限流计数（`visual_search_attempts`）——额度按主体算。
 *
 * 登录用户直接用 userId（uuid，满足对象键的 `SUBJECT_PATTERN`）；
 * 匿名用**会话标识的 HMAC**：对象键与限流表里因此都不出现原始 IP，
 * 且 HMAC 后的十六进制串同样满足 `SUBJECT_PATTERN`。
 *
 * 匿名请求的 `attempts` 只收**稳定身份**：客户端带回来的会话 + 出口 IP；
 * IP 无法归因时落到共享兜底桶（fail-closed，见 `resolve` 内注释）。
 */
export type VisualSearchSubject = {
  /** 落 `visual_query_images.subject_type` 的值：只有 `user` / `session` 两种（表上有 CHECK）。 */
  subjectType: 'user' | 'session'
  subjectKey: string
}

export type ResolvedVisualSearchSubject = {
  /** 对象键与台账使用的主体。 */
  key: VisualSearchSubject
  /** 限流要过的全部主体（匿名是两条）。 */
  attempts: VisualSearchAttemptSubject[]
  /**
   * 本次请求**新签发**的会话标识（客户端没带时）。路由负责写进响应头；
   * 客户端下次必须带回来，否则上传与搜索会被算成两个不同主体。
   */
  issuedSessionId: string | null
}

export type VisualSearchSubjectResolver = {
  resolve(
    c: Context,
    viewerId: string | null,
    clientIp: string | null,
  ): Promise<ResolvedVisualSearchSubject>
}

/** 领域分隔：同一把密钥下，查询图会话与出口 IP 的摘要不可互相推导。 */
const SESSION_SCOPE = 'visual-search-session'
const IP_SCOPE = 'visual-search-ip'

/**
 * IP 无法归因时共享的兜底主体（不是 IP 字面量，`normalizeIp` 也不会产出它，因此不可能与真实 IP 撞桶）。
 *
 * 存在的意义是 fail-closed：宁可让「所有无法归因的流量」共用一份额度（配置错了会立刻表现为
 * 大面积 429，逼部署方去设 `LISTING_LOOKUP_TRUSTED_PROXY_IP`），也不能让伪造转发头
 * 变成"IP 主体消失 ⇒ 无限配额"。
 */
const UNATTRIBUTED_IP_SUBJECT = 'unattributed'

export function createVisualSearchSubjectResolver(secret: string): VisualSearchSubjectResolver {
  const encoder = new TextEncoder()
  const keyPromise = crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  async function digest(scope: string, value: string): Promise<string> {
    const signature = await crypto.subtle.sign(
      'HMAC',
      await keyPromise,
      encoder.encode(`${scope}:${value}`),
    )
    return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    )
  }

  return {
    async resolve(c, viewerId, clientIp) {
      if (viewerId) {
        return {
          key: { subjectType: 'user', subjectKey: viewerId },
          attempts: [{ subjectType: 'user', subjectKey: viewerId }],
          issuedSessionId: null,
        }
      }

      const sessionId = readAnonymousSessionId(c)
      const ip = normalizeIp(clientIp)

      // 对象键与台账使用的主体：客户端没带会话就新签一个（路由回写到响应头，客户端下次带回来）。
      // 不在这里 4xx —— 拍照搜图是公开入口，一个缺失的带外头不该让功能不可用。
      const effectiveSessionId = sessionId ?? newId()
      const sessionKey = await digest(SESSION_SCOPE, effectiveSessionId)

      // 限流主体只收**稳定身份**，两条规则都必须是 fail-closed：
      //
      // 1. 新签发的会话本次没有任何历史，把它当配额桶等于**没有桶**（每个请求一个新桶，
      //    20/60s 永远打不满）。所以只有客户端带回来的会话才计入配额。
      // 2. IP 拿不到时（未配置可信代理 + 请求带转发头，见 `trusted-ip.ts`）**不能少一个桶**，
      //    否则伪造 `X-Forwarded-For` 就能让 IP 主体凭空消失、只剩上面那个每次新签的会话 ⇒
      //    限流被完全绕过。这里落到共享兜底桶：所有无法归因的流量共用一份额度。
      const attempts: VisualSearchAttemptSubject[] = []
      if (sessionId) {
        attempts.push({ subjectType: 'session', subjectKey: sessionKey })
      }
      attempts.push({
        subjectType: 'ip',
        subjectKey: await digest(IP_SCOPE, ip ?? UNATTRIBUTED_IP_SUBJECT),
      })

      return {
        key: { subjectType: 'session', subjectKey: sessionKey },
        attempts,
        issuedSessionId: sessionId ? null : effectiveSessionId,
      }
    },
  }
}
