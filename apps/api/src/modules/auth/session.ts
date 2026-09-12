import type { Db } from '@fish/db/client'
import { sessions } from '@fish/db/schema/sessions'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

/** 固定 30 天，不滑动续期（#3 决策：每请求写库不值得）。 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

const COOKIE_NAME = 'fish_session'

const hashToken = (token: string) => new Bun.CryptoHasher('sha256').update(token).digest('hex')

/** 32 字节随机令牌（hex 编码，64 字符）。明文只写给 cookie，库里只有哈希。 */
function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 会话存储。选它而不是无状态签名令牌，是为了让 `logout` 能**真正吊销**会话，
 * 同时不引入 `SESSION_SECRET` 这类新配置。多设备 / 多标签各占一行，互不影响。
 */
export function createSessions(db: Db) {
  return {
    async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
      const token = generateToken()
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
      await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt })
      return { token, expiresAt }
    },

    /** 校验令牌；过期行顺手删掉，因此「过期」不需要额外的清理任务。 */
    async resolve(token: string): Promise<{ userId: string } | null> {
      const rows = await db
        .select({ id: sessions.id, userId: sessions.userId, expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(eq(sessions.tokenHash, hashToken(token)))
        .limit(1)

      const row = rows[0]
      if (!row) return null
      if (row.expiresAt.getTime() <= Date.now()) {
        await db.delete(sessions).where(eq(sessions.id, row.id))
        return null
      }
      return { userId: row.userId }
    },

    /** 幂等：令牌不存在时什么也不做。 */
    async revoke(token: string): Promise<void> {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)))
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>

/**
 * 会话 cookie 的读写。
 *
 * `Secure` 由 `WEB_ORIGIN` 的 scheme 推导而非新增环境变量：本地 http 加 `Secure` 会让
 * cookie 直接被浏览器丢弃，生产 https 又必须加，而 WEB_ORIGIN 恰好就等于站点来源，
 * 两者不可能漂移。
 */
export function createSessionCookie(secure: boolean) {
  return {
    attach(c: Context, token: string, expiresAt: Date): void {
      setCookie(c, COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'Lax',
        path: '/',
        secure,
        expires: expiresAt,
      })
    },

    /** 清 cookie 时属性要与下发时一致，否则浏览器可能留下同名 cookie。 */
    clear(c: Context): void {
      deleteCookie(c, COOKIE_NAME, { path: '/', secure })
    },

    read(c: Context): string | undefined {
      return getCookie(c, COOKIE_NAME)
    },
  }
}

export type SessionCookie = ReturnType<typeof createSessionCookie>
