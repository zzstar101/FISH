import type { Me } from '@fish/contracts/auth/user'
import type { WechatSessionRequest } from '@fish/contracts/auth/wechat'
import type { Db } from '@fish/db/client'
import { users, wechatIdentities } from '@fish/db/schema/users'
import { eq } from 'drizzle-orm'
import { AuthError } from './errors'
import { toMe, type UserRow } from './me'
import type { Sessions } from './session'
import { isUniqueViolation } from './unique'

/**
 * 微信 code exchange Provider（#86 A 节）。
 *
 * 与邮件验证码 Provider（`verification-provider.ts`）同一拆分原则：**边界协议**在这里，
 * 存储与登录语义在 service。真实实现要调微信 `jscode2session`（需 AppSecret）；
 * 当前仓库没有 AppSecret，`stub` 实现从 code **确定性派生** openid，让「换同一个 code
 * 得到同一个用户」的幂等语义在本地可演示、可测试。
 *
 * 安全边界（#86 冻结）：openid / session_key 只存在于服务端与微信之间；
 * 客户端上报的任何身份字段都不被信任，本接口的入参只有 `code`。
 */
export interface WechatIdentityProvider {
  /**
   * code → 微信身份。返回值是服务端与微信侧核实的**可信**结果。
   * 换取失败（code 无效 / 过期 / 已用）抛 `WechatExchangeError`。
   */
  exchange(code: string): Promise<{ openid: string; unionid: string | null }>
}

/** code 换取失败的统一信号；router 翻译成 401 WECHAT_CODE_INVALID。 */
export class WechatExchangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WechatExchangeError'
  }
}

/**
 * stub Provider：`code` 即身份种子。形状与真实 openid 一致（`o` 前缀 + 27 位 base 字符），
 * 同一 code 恒得同一 openid——真实接口里 code 一次性，但「同一微信用户多次登录」
 * 的幂等性由 openid 唯一索引承担，stub 的确定性只是让这一语义在测试里可复现。
 *
 * #86 评审 P1：stub **不验证微信签发的凭证**，只能由 `WECHAT_TRANSPORT=stub` 显式开启
 * （loader 在 `NODE_ENV=production` 下直接拒绝）；装配层不会无条件注入它。
 */
export function createStubWechatIdentityProvider(): WechatIdentityProvider {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
  return {
    async exchange(code: string) {
      // 确定性哈希（非加密用途；openid 不是秘密，stub 只需要稳定映射）。
      const digest = new Bun.CryptoHasher('sha256').update(`wechat-stub:${code}`).digest('hex')
      let suffix = ''
      for (let i = 0; i < 27; i += 1) {
        const byte = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16)
        suffix += ALPHABET[byte % ALPHABET.length]
      }
      return { openid: `o${suffix}`, unionid: null }
    },
  }
}

/**
 * live Provider：真实 `jscode2session`（GET api.weixin.qq.com，appid+secret+code）。
 *
 * - `errcode` 非 0（code 无效 / 过期 / 已用 / appid-secret 不匹配）→ `WechatExchangeError`，
 *   router 翻译成 401 `WECHAT_CODE_INVALID`——不建会话、不建映射。
 * - AppSecret 只存在于服务端进程，绝不进日志（错误信息只带 errcode/errmsg，不带 URL）。
 */
export function createLiveWechatIdentityProvider(deps: {
  appid: string
  appSecret: string
}): WechatIdentityProvider {
  return {
    async exchange(code: string) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session')
      url.searchParams.set('appid', deps.appid)
      url.searchParams.set('secret', deps.appSecret)
      url.searchParams.set('js_code', code)
      url.searchParams.set('grant_type', 'authorization_code')
      const res = await fetch(url)
      if (!res.ok) {
        throw new WechatExchangeError(`jscode2session HTTP ${res.status}`)
      }
      const body = (await res.json()) as {
        openid?: string
        unionid?: string
        errcode?: number
        errmsg?: string
      }
      // 40029 code 无效 / 40163 code 已用 / 45011 频率限制 / 40013 appid 不匹配……
      if (body.errcode !== undefined && body.errcode !== 0) {
        throw new WechatExchangeError(
          `jscode2session errcode=${body.errcode} errmsg=${body.errmsg ?? ''}`,
        )
      }
      if (!body.openid) {
        throw new WechatExchangeError('jscode2session 响应缺少 openid')
      }
      return { openid: body.openid, unionid: body.unionid ?? null }
    },
  }
}

/** 微信注册用户的占位昵称：`鱼友_ab12`（取 openid 中段，稳定且可读）。 */
function placeholderNickname(openid: string): string {
  return `鱼友_${openid.slice(5, 9)}`
}

/**
 * 微信身份 → FISH user（#86 A 节）。
 *
 * - 已有映射：直接按 user 建会话（登录）。
 * - 新 openid：事务里「建 user + 建映射 + 建会话」同生共死——与会话写入失败会留下
 *   「有映射但登不进去」的孤儿，重试只会撞唯一索引。
 * - 并发首登：两个请求同时 INSERT 同一 openid，一个成功一个撞 `wechat_identities_openid_uq`，
 *   失败方重读映射后走登录路径（幂等，两边最终登进同一账号）。
 */
export function createWechatAuthService(deps: {
  db: Db
  sessions: Sessions
  provider: WechatIdentityProvider
}) {
  const { db, sessions, provider } = deps

  async function findIdentity(
    executor: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
    openid: string,
  ): Promise<{ userId: string } | null> {
    const rows = await executor
      .select({ userId: wechatIdentities.userId })
      .from(wechatIdentities)
      .where(eq(wechatIdentities.openid, openid))
      .limit(1)
    return rows[0] ?? null
  }

  async function loadUser(userId: string): Promise<UserRow | null> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1)
    return rows[0] ?? null
  }

  return {
    /**
     * wx.login code → （自动建号）→ fish_session。
     * logout 只销毁会话不解绑身份；换账号 = 换 code（不同 openid 映射到不同 user），天然不串号。
     */
    async signIn(
      input: WechatSessionRequest,
    ): Promise<{ user: Me; token: string; expiresAt: Date }> {
      let identity: { openid: string; unionid: string | null }
      try {
        identity = await provider.exchange(input.code)
      } catch {
        throw new AuthError('WECHAT_CODE_INVALID', 401, '微信登录凭证无效或已过期')
      }

      const existing = await findIdentity(db, identity.openid)
      if (existing) {
        const row = await loadUser(existing.userId)
        if (!row) throw new AuthError('WECHAT_CODE_INVALID', 401, '微信身份映射损坏')
        const { token, expiresAt } = await sessions.create(row.id)
        return { user: toMe(row), token, expiresAt }
      }

      try {
        const created = await db.transaction(async (tx) => {
          const inserted = await tx
            .insert(users)
            .values({
              // #86：微信是主身份，学号 / 密码留空（E 节迁移后列退出登录键）。
              studentNo: null,
              passwordHash: null,
              nickname: placeholderNickname(identity.openid),
              authStatus: 'UNVERIFIED',
              verifiedAt: null,
            })
            .returning()
          const row = inserted[0]
          if (!row) throw new Error('INSERT users 未返回行')
          await tx.insert(wechatIdentities).values({
            userId: row.id,
            openid: identity.openid,
            unionid: identity.unionid,
          })
          return { row, ...(await sessions.createWith(tx, row.id)) }
        })
        return { user: toMe(created.row), token: created.token, expiresAt: created.expiresAt }
      } catch (error) {
        // 并发首登：另一个请求先建好了映射。重读后按登录处理；用户行也被对方建好。
        // 败者可能在胜者事务提交前就撞了唯一索引，此时重读为空——短退避重试几次
        // （真实部署多实例时窗口存在；单机 stub 下最多出现一次）。重试耗尽才降级 401。
        if (isUniqueViolation(error)) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await Bun.sleep(50 * (attempt + 1))
            const raced = await findIdentity(db, identity.openid)
            if (!raced) continue
            const row = await loadUser(raced.userId)
            if (!row) continue
            const { token, expiresAt } = await sessions.create(row.id)
            return { user: toMe(row), token, expiresAt }
          }
          throw new AuthError('WECHAT_CODE_INVALID', 401, '微信身份映射冲突')
        }
        throw error
      }
    },
  }
}

export type WechatAuthService = ReturnType<typeof createWechatAuthService>
