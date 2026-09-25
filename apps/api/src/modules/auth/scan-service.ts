import type { Me } from '@fish/contracts/auth/user'
import type { Db } from '@fish/db/client'
import { users } from '@fish/db/schema/users'
import { eq } from 'drizzle-orm'
import { AuthError } from './errors'
import { toMe, type UserRow } from './me'
import {
  createScanTicketStore,
  SCAN_TICKET_CLEANUP_LIMIT,
  SCAN_TICKET_TTL_MS,
  type ScanTicketLookup,
  type ScanTicketStore,
} from './scan-store'
import type { Sessions } from './session'

/**
 * Web 扫码登录的票据流程（#197）。
 *
 * 职责边界：码怎么生成、状态怎么推导、错误怎么归类在这里；持久化与并发保护在
 * `scan-store.ts`（条件 UPDATE，不预先读后写）。
 *
 * 冻结语义：
 * - **错误对外只出一类**：不存在 / verifier 错 / 已消费一律 404 `SCAN_TICKET_INVALID`，
 *   否则这个匿名可调的端点就成了票据枚举接口。只有持正确 verifier 的调用者才拿得到
 *   细化状态（含 `expired`）。
 * - `confirm` 需要已登录身份（由路由的 `requireAuth` 保证）；同人重复确认幂等，
 *   换人一律 409 `SCAN_TICKET_CONFLICT`——一张票**不能被改绑**。
 * - `exchange` 在**同一事务**里消费票据 + 建会话：并发重复兑换只有一个能拿到会话，
 *   另一个拿到统一的 404。
 */

/** 16 随机字节 → base64url 22 字符（微信 scene 上限 32，且字符集不含 `%`）。 */
const TICKET_BYTES = 16
/** 32 随机字节 → 64 字符 hex。 */
const VERIFIER_BYTES = 32

function sha256Hex(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

function generateTicket(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(TICKET_BYTES))).toString('base64url')
}

function generateVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export type ScanTicketStatus = 'pending' | 'confirmed' | 'expired'

export type ScanTicketUser = { id: string; nickname: string; avatarUrl: string | null }

export function createScanTicketService(deps: {
  db: Db
  sessions: Sessions
  store?: ScanTicketStore
}) {
  const store = deps.store ?? createScanTicketStore(deps.db)

  /** 统一的无差别失败：不存在 / verifier 错 / 已消费都用它。 */
  const invalid = () => new AuthError('SCAN_TICKET_INVALID', 404, '登录二维码无效或已过期')

  /** 过期判定只用数据库时间（`row.dbNow`），见 scan-store 的文件头说明。 */
  function deriveStatus(row: ScanTicketLookup): ScanTicketStatus {
    if (row.expiresAt.getTime() <= row.dbNow.getTime()) return 'expired'
    if (row.boundUserId !== null) return 'confirmed'
    return 'pending'
  }

  async function loadUser(
    executor: Db | Parameters<Parameters<Db['transaction']>[0]>[0],
    userId: string,
  ): Promise<UserRow | null> {
    const rows = await executor.select().from(users).where(eq(users.id, userId)).limit(1)
    return rows[0] ?? null
  }

  return {
    /**
     * 建票：只把两个哈希落库，明文只在返回值里出现一次。
     * 顺带做一次**有界**过期清理——票据创建频率高，不能像 sessions 那样放着不管。
     */
    async create(): Promise<{ ticket: string; verifier: string; expiresAt: Date }> {
      const ticket = generateTicket()
      const verifier = generateVerifier()

      // 过期时刻由数据库算：API 进程与数据库的时钟不必一致（见 scan-store 的 insert）。
      const expiresAt = await deps.db.transaction(async (tx) => {
        const inserted = await store.insert(tx, {
          ticketHash: sha256Hex(ticket),
          verifierHash: sha256Hex(verifier),
          ttlMs: SCAN_TICKET_TTL_MS,
        })
        await store.deleteExpired(tx, { limit: SCAN_TICKET_CLEANUP_LIMIT })
        return inserted.expiresAt
      })

      return { ticket, verifier, expiresAt }
    },

    /**
     * 查状态。verifier 不对或票不存在/已消费 → 统一 404；verifier 正确但已过期 →
     * 如实回 `expired`（这正是「只有发起方能看到细化状态」的意义）。
     */
    async status(input: {
      ticket: string
      verifier: string
    }): Promise<
      | { status: 'pending'; expiresAt: Date }
      | { status: 'expired'; expiresAt: Date }
      | { status: 'confirmed'; expiresAt: Date; user: ScanTicketUser }
    > {
      const row = await store.find(deps.db, sha256Hex(input.ticket))
      if (row === null) throw invalid()
      if (row.verifierHash !== sha256Hex(input.verifier)) throw invalid()
      // 已消费的票对谁都按「无效」处理：兑换成功后浏览器本就该停止轮询。
      if (row.consumedAt !== null) throw invalid()

      const status = deriveStatus(row)
      if (status === 'expired') return { status, expiresAt: row.expiresAt }
      if (status === 'confirmed') {
        // 账号被删时票据会级联消失；这里只作防御，不把它当正常路径。
        if (row.user === null) throw invalid()
        return { status, expiresAt: row.expiresAt, user: row.user }
      }
      return { status, expiresAt: row.expiresAt }
    },

    /** 小程序确认：绑定当前会话用户。同人幂等；他人 409；其余 404。 */
    async confirm(input: { ticket: string; userId: string }): Promise<void> {
      const ticketHash = sha256Hex(input.ticket)

      const bound = await store.bind(deps.db, { ticketHash, userId: input.userId })
      if (bound) return

      // 0 行：回读一次分类。绑定与分类是两次查询，但**判定依据始终是那次条件 UPDATE**，
      // 回读只用来把「抢绑」与「票没了」分开，不参与正确性。
      //
      // 只有**还活着**的票才谈得上「被别人占了」。已过期 / 已兑换的票即使当年绑给别人，
      // 也必须回到统一的 404——否则等于告诉调用者「这枚废票曾经绑给谁」。
      const row = await store.find(deps.db, ticketHash)
      const live =
        row !== null && row.consumedAt === null && row.expiresAt.getTime() > row.dbNow.getTime()
      if (live && row.boundUserId !== null && row.boundUserId !== input.userId) {
        throw new AuthError('SCAN_TICKET_CONFLICT', 409, '这枚登录二维码已被其他账号确认')
      }
      throw invalid()
    },

    /**
     * 浏览器兑换：同一事务里「消费票据 + 建会话」。
     * 未确认、verifier 不对、已消费、过期、票不存在——一律同一个 404。
     */
    async exchange(input: {
      ticket: string
      verifier: string
    }): Promise<{ user: Me; token: string; expiresAt: Date }> {
      const ticketHash = sha256Hex(input.ticket)
      const verifierHash = sha256Hex(input.verifier)

      const result = await deps.db.transaction(async (tx) => {
        const claimed = await store.consume(tx, { ticketHash, verifierHash })
        if (claimed === null) return null
        // 锁等待可能让 UPDATE 的谓词在过期后才生效（见 scan-store 文件头）：
        // 这里复核一次，过期就抛错回滚，绝不签发会话。
        if (!claimed.stillLive) throw invalid()

        const row = await loadUser(tx, claimed.boundUserId)
        // 抛错让整个事务回滚：否则「票据已被消费、却没有会话」会白烧掉这张票。
        if (row === null) throw invalid()
        return { user: toMe(row), ...(await deps.sessions.createWith(tx, row.id)) }
      })

      if (result === null) throw invalid()
      return result
    },
  }
}

export type ScanTicketService = ReturnType<typeof createScanTicketService>
