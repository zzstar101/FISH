import type { Db } from '@fish/db/client'
import { loginTickets } from '@fish/db/schema/login-tickets'
import { users } from '@fish/db/schema/users'
import { and, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { washAvatarUrl } from './me'

/**
 * 扫码登录票据的持久化（#197）。
 *
 * 并发语义（同 #68 验证码的做法）：**不预先 SELECT 再写**，一律走条件 UPDATE，
 * 更新行数为 0 时再回读一次用于分类失败原因——否则两个并发请求会同时通过检查（TOCTOU）。
 * - 绑定：`bound_user_id IS NULL OR bound_user_id = $me`，所以「同人重复确认」幂等、
 *   「他人抢绑」必然 0 行。
 * - 兑换：同一条 UPDATE 里同时校验 verifier 哈希、已绑定、未消费、未过期，命中才拿得到
 *   `bound_user_id`；这条 UPDATE 与建会话在同一个事务里（见 service）。
 *
 * **过期一律以数据库时间为准，且用 `clock_timestamp()` 而不是 `now()`**：
 * - 不用调用方传进来的 JS 时间——条件 UPDATE 可能因行锁排队而晚于取时间的那一刻执行；
 * - 不用 `now()`——它是**事务开始时间**，兑换的事务若在 `expires_at` 前开始、却因行锁等到
 *   过期之后才执行 UPDATE，`expires_at > now()` 仍为真，过期票就会被兑换掉。
 *   `clock_timestamp()` 取的是语句执行时的真实时刻，没有这个窗口。
 * `find` 因此把同一个 `clock_timestamp()` 一并查出来，供上层分类失败原因时使用同一时钟。
 */

/** 票据有效期（#197 决策：5 分钟）。 */
export const SCAN_TICKET_TTL_MS = 5 * 60 * 1000

/** 每次建票顺带清理的过期行上限：有界，不引新基础设施。 */
export const SCAN_TICKET_CLEANUP_LIMIT = 200

/**
 * 过期后的**保留窗口**：清理只删「过期超过这么久」的行。
 *
 * 为什么不删刚过期的行：持正确 verifier 的浏览器要能在 `expiresAt` 之后仍看到
 * `expired`（前端据此提示「二维码已过期，请重新获取」）。若一过期就被无关的建票流量
 * 清掉，同一个 verifier 会时而是 `expired`、时而是 404，语义不确定。
 */
export const SCAN_TICKET_RETENTION_MS = 60 * 60 * 1000

/** 普通连接，或事务句柄（兑换要在同一事务里消费票据 + 建会话）。 */
type ScanExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export type ScanTicketLookup = {
  /** 用于比对：只有持正确 verifier 的调用者才算数。 */
  verifierHash: string
  boundUserId: string | null
  consumedAt: Date | null
  expiresAt: Date
  /** 数据库侧的「现在」：过期判定与失败分类都以它为准。 */
  dbNow: Date
  /** 已绑定时投影出的公开账号子集；未绑定时为 null。 */
  user: { id: string; nickname: string; avatarUrl: string | null } | null
}

export interface ScanTicketStore {
  /**
   * 落一张新票。`expires_at` 由**数据库**算（`clock_timestamp() + ttl`）并回传，避免
   * API 进程与数据库的时钟偏差把 TTL 拉长或缩短。
   */
  insert(
    executor: ScanExecutor,
    input: { ticketHash: string; verifierHash: string; ttlMs: number },
  ): Promise<{ expiresAt: Date }>
  /** 按哈希取票，并顺带 left join 出公开账号投影（一条查询，不 N+1）。 */
  find(executor: ScanExecutor, ticketHash: string): Promise<ScanTicketLookup | null>
  /** 条件绑定；返回是否真的绑定成功（0 行时由 service 回读分类）。 */
  bind(executor: ScanExecutor, input: { ticketHash: string; userId: string }): Promise<boolean>
  /**
   * 条件兑换；未命中返回 null。命中时**必须再看 `stillLive`**：
   * 条件谓词可能在行锁等待之前就被求值（见文件头），调用方拿到 `stillLive === false`
   * 要抛错让事务整体回滚，否则会把过期票兑换成会话。
   */
  consume(
    executor: ScanExecutor,
    input: { ticketHash: string; verifierHash: string },
  ): Promise<{ boundUserId: string; stillLive: boolean } | null>
  /** 用**此刻**的库时间判断票是否仍有效（复核用，见文件头）。 */
  isLive(executor: ScanExecutor, ticketHash: string): Promise<boolean>
  /** 有界清理过期行；返回删除条数（供 smoke/测试观察）。 */
  deleteExpired(executor: ScanExecutor, input: { limit: number }): Promise<number>
}

export function createScanTicketStore(db: Db): ScanTicketStore {
  /** 一条只读语句：`expires_at > clock_timestamp()`。它执行时才算数，不受行锁等待前的求值影响。 */
  async function isLive(executor: ScanExecutor, ticketHash: string): Promise<boolean> {
    const rows = await executor
      .select({ live: sql<boolean>`${loginTickets.expiresAt} > clock_timestamp()` })
      .from(loginTickets)
      .where(eq(loginTickets.ticketHash, ticketHash))
      .limit(1)
    return rows[0]?.live === true
  }

  return {
    isLive,

    async insert(executor, input) {
      const rows = await executor
        .insert(loginTickets)
        .values({
          ticketHash: input.ticketHash,
          verifierHash: input.verifierHash,
          expiresAt: sql`clock_timestamp() + ${input.ttlMs} * interval '1 millisecond'`,
        })
        .returning({ expiresAt: loginTickets.expiresAt })
      const row = rows[0]
      if (!row) throw new Error('INSERT login_tickets 未返回行')
      return { expiresAt: row.expiresAt }
    },

    async find(executor, ticketHash) {
      const rows = await executor
        .select({
          verifierHash: loginTickets.verifierHash,
          boundUserId: loginTickets.boundUserId,
          consumedAt: loginTickets.consumedAt,
          expiresAt: loginTickets.expiresAt,
          dbNow: sql<Date>`clock_timestamp()`,
          userId: users.id,
          nickname: users.nickname,
          avatarUrl: users.avatarUrl,
        })
        .from(loginTickets)
        .leftJoin(users, eq(users.id, loginTickets.boundUserId))
        .where(eq(loginTickets.ticketHash, ticketHash))
        .limit(1)

      const row = rows[0]
      if (!row) return null
      return {
        verifierHash: row.verifierHash,
        boundUserId: row.boundUserId,
        consumedAt: row.consumedAt,
        expiresAt: row.expiresAt,
        dbNow: row.dbNow,
        user:
          row.userId !== null && row.nickname !== null
            ? {
                id: row.userId,
                nickname: row.nickname,
                // 库里是裸 text，契约要求 z.url()：脏值必须在这里降级，否则前端解析会抛。
                avatarUrl: washAvatarUrl(row.avatarUrl ?? null),
              }
            : null,
      }
    },

    async bind(executor, input) {
      const rows = await executor
        .update(loginTickets)
        // 同人重复确认必须幂等：`bound_at` 只在首次绑定那一笔写入（coalesce 保住旧值），
        // 否则第二次确认会把它刷成新时间，后续若拿它做审计/保留期就失真。
        .set({
          boundUserId: input.userId,
          boundAt: sql`coalesce(${loginTickets.boundAt}, clock_timestamp())`,
        })
        .where(
          and(
            eq(loginTickets.ticketHash, input.ticketHash),
            isNull(loginTickets.consumedAt),
            gt(loginTickets.expiresAt, sql`clock_timestamp()`),
            // 同人重复确认幂等；换人必然 0 行。
            or(isNull(loginTickets.boundUserId), eq(loginTickets.boundUserId, input.userId)),
          ),
        )
        .returning({ id: loginTickets.id })
      return rows.length > 0
    },

    async consume(executor, input) {
      const rows = await executor
        .update(loginTickets)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(loginTickets.ticketHash, input.ticketHash),
            eq(loginTickets.verifierHash, input.verifierHash),
            isNotNull(loginTickets.boundUserId),
            isNull(loginTickets.consumedAt),
            gt(loginTickets.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ boundUserId: loginTickets.boundUserId })
      const boundUserId = rows[0]?.boundUserId
      if (boundUserId === undefined || boundUserId === null) return null
      return { boundUserId, stillLive: await isLive(executor, input.ticketHash) }
    },

    async deleteExpired(executor, input) {
      const rows = await executor
        .delete(loginTickets)
        .where(
          inArray(
            loginTickets.id,
            db
              .select({ id: loginTickets.id })
              .from(loginTickets)
              // 只删「过期超过保留窗口」的行：刚过期的行要留给持正确 verifier 的浏览器
              // 看 `expired`（见 SCAN_TICKET_RETENTION_MS 的说明）。
              .where(
                lte(
                  loginTickets.expiresAt,
                  sql`clock_timestamp() - ${SCAN_TICKET_RETENTION_MS} * interval '1 millisecond'`,
                ),
              )
              .limit(input.limit),
          ),
        )
        .returning({ id: loginTickets.id })
      return rows.length
    },
  }
}
