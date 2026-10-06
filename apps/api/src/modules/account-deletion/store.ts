import type {
  AccountDeletionState,
  AccountDeletionStatus,
} from '@fish/contracts/account-deletion/schema'
import type { Db } from '@fish/db/client'
import { userRestrictions } from '@fish/db/schema/governance'
import { listings } from '@fish/db/schema/listings'
import { sessions } from '@fish/db/schema/sessions'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { and, eq, inArray, ne, or, sql } from 'drizzle-orm'
import { ACTIVE_RESTRICTION_WHERE } from '../governance/store'

/**
 * 账号注销的持久化（Issue #464）。表结构见 `packages/db/src/schema/users.ts` 的
 * `account_status` 三态 + `deletion_requested_at` / `purge_scheduled_at`（外加一条
 * CHECK：状态与两个时间戳同进同出）。
 *
 * ## 为什么资格校验要放进事务里，而不是 service 先查一遍再写
 *
 * 冻结口径的两条硬阻塞（未完成交易 / 生效中的 BAN）与「下架在架商品」之间有竞态：
 * 先查「没有未完成交易」再下架，中间可以插进一笔新交易（`transactions/store.ts` 的 `accept`
 * 就是买家接受卖家报价，那一刻才 INSERT transactions）。所以顺序被钉死为
 * **锁账号行 → 下架商品（条件 UPDATE 拿商品行锁）→ 复查未完成交易 → 落状态**：
 *
 * - 卖家一侧：`accept` 对商品行做的是 `UPDATE listings … WHERE id = ? AND status = 'ACTIVE'`，
 *   与本方法第 ③ 步的 `UPDATE listings … WHERE seller_id = ?` 争同一把行锁，于是两者严格
 *   串行。谁先拿到锁，谁的结果对后者可见（READ COMMITTED 下条件 UPDATE 会重新求值），
 *   不存在「注销已生效、同时又多出一笔待面交交易」的交错。
 * - 买家一侧：注销人的商品不是那笔交易的商品，行锁锁不住它 —— 这一侧只剩「复查窗口」，
 *   由 worker 在去标识化前**再查一次**兜底（见 `apps/worker/src/jobs/account-deletion/purge.ts`
 *   的「有未完成交易就推迟」）。
 *
 * 复查发现阻塞时必须**回滚**（第 ③ 步已经把商品下架了），所以用抛出哨兵异常而不是 return：
 * 从 `db.transaction` 回调里 return 是**提交**，会把「本应被拒绝的申请」连带下架一起落库。
 *
 * ## 幂等
 *
 * 重复申请不重置 7 天计时（`DELETION_REQUESTED` 直接返回既有状态），撤回后再申请是一次全新
 * 的申请（新时间戳）。并发靠 `SELECT … FOR UPDATE` 串行：READ COMMITTED 下拿到锁后会重读
 * 最新已提交版本，第二个请求看到的是 `DELETION_REQUESTED`。
 */

/** 一次申请里最多回报几个对方昵称（错误信息用；总数另算，不受它限制）。 */
export const BLOCKING_TRANSACTION_SAMPLE_LIMIT = 3

/** 阻塞资格的交易：只回报错误信息真正用得上的对方昵称（总数另算）。 */
export interface BlockingTransaction {
  transactionId: string
  counterpartyNickname: string | null
}

/** 未完成交易的汇总：总数 + 至多 {@link BLOCKING_TRANSACTION_SAMPLE_LIMIT} 条样本。 */
export interface BlockingTransactions {
  total: number
  samples: BlockingTransaction[]
}

export type RequestDeletionOutcome =
  /** 已在冷静期内：幂等命中，**不重置**计时、不再下架、不再撤销会话。 */
  | { kind: 'already-requested'; status: AccountDeletionStatus }
  /** 生效中的 BAN：封禁中的账号不能靠注销把自己抹掉。 */
  | { kind: 'blocked-banned' }
  /** 存在未完成交易（`PENDING_MEETUP`），买 / 卖任一侧；事务已回滚。 */
  | { kind: 'blocked-pending-transaction'; blocking: BlockingTransactions }
  | {
      kind: 'requested'
      status: AccountDeletionStatus
      /** 本次被下架（→ `OFFLINE`）的在架商品数；撤回不恢复上架。 */
      offlinedListingCount: number
    }
  /**
   * 账号已被 worker 去标识化（`DELETED`）。窄竞态：`requireAuth` 读到 `DELETION_REQUESTED`
   * 放行后、本事务 `FOR UPDATE` 拿到锁之前，到期清理提交了。**不抛裸 Error**——那会变成 500，
   * 而正确语义是「这个身份已经不存在了」（调用方翻成 401）。
   */
  | { kind: 'gone' }

export interface AccountDeletionStore {
  /**
   * 读注销状态。行不存在（或已是 `DELETED`，即去标识化已完成）返回 null ——
   * 后者不可能带着有效会话到达这里（见 `auth/service.ts` 的 `loadViewer`）。
   */
  loadStatus(userId: string): Promise<AccountDeletionStatus | null>
  requestDeletion(input: {
    userId: string
    now: Date
    purgeScheduledAt: Date
    /** 要保留的那枚会话令牌哈希（当前设备）；null = 撤销全部。 */
    keepTokenHash: string | null
  }): Promise<RequestDeletionOutcome>
  /** 撤回申请。不在冷静期内是幂等的空操作（回当前状态）；已被去标识化则回 `gone`。 */
  withdrawDeletion(input: {
    userId: string
    now: Date
  }): Promise<{ kind: 'withdrawn' | 'noop'; status: AccountDeletionStatus } | { kind: 'gone' }>
}

/** 状态列 + 两个时间戳：三者的读法只在这里写一次。 */
const STATUS_COLUMNS = {
  accountStatus: users.accountStatus,
  deletionRequestedAt: users.deletionRequestedAt,
  purgeScheduledAt: users.purgeScheduledAt,
} as const

type StatusRow = {
  accountStatus: AccountDeletionState | 'DELETED'
  deletionRequestedAt: Date | null
  purgeScheduledAt: Date | null
}

/**
 * DB 行 → 契约状态。`DELETED` 不是对外的值域（见契约注释），所以**每个调用点都必须先把它
 * 挡成 `gone` / `null`**；这里是不可达的不变量断言，不是可预期的失败路径（对抗性审查 m1：
 * 曾经唯一的 DELETED 处理就是在这个断言里抛裸 Error，于是竞态会变成 500）。
 */
function toStatus(row: StatusRow): AccountDeletionStatus {
  if (row.accountStatus === 'DELETED') {
    throw new Error('账号注销：已注销账号不应进入对外状态投影（调用方漏了 DELETED 分支）')
  }
  return {
    status: row.accountStatus,
    requestedAt: row.deletionRequestedAt?.toISOString() ?? null,
    purgeScheduledAt: row.purgeScheduledAt?.toISOString() ?? null,
  }
}

/**
 * 复查未完成交易：一条带窗口函数的查询同时给出总数与样本（`count(*) over ()` 在 LIMIT
 * 之前求值，所以 `total` 是全量）。对方昵称用 `CASE` 从买 / 卖两侧取另一侧，
 * 不需要两次查询或应用层拼装。
 */
async function countBlockingTransactions(
  executor: TransactionExecutor,
  userId: string,
): Promise<BlockingTransactions> {
  const rows = await executor
    .select({
      transactionId: transactions.id,
      counterpartyNickname: users.nickname,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(transactions)
    .leftJoin(
      users,
      sql`${users.id} = case when ${transactions.buyerId} = ${userId} then ${transactions.sellerId} else ${transactions.buyerId} end`,
    )
    .where(
      and(
        eq(transactions.status, 'PENDING_MEETUP'),
        or(eq(transactions.buyerId, userId), eq(transactions.sellerId, userId)),
      ),
    )
    .orderBy(transactions.createdAt)
    .limit(BLOCKING_TRANSACTION_SAMPLE_LIMIT)

  const samples: BlockingTransaction[] = rows.map((row) => ({
    transactionId: row.transactionId,
    counterpartyNickname: row.counterpartyNickname,
  }))
  return { total: rows[0]?.total ?? 0, samples }
}

/** 事务句柄（与 `auth/session.ts` 的 `SessionExecutor` 同一取法：Drizzle 的 PgTransaction）。 */
type TransactionExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

/** 复查发现阻塞时用它把整个事务掀掉（见文件头「必须回滚」）。 */
class BlockedPendingTransaction extends Error {
  constructor(readonly blocking: BlockingTransactions) {
    super('账号注销被未完成交易阻塞')
    this.name = 'BlockedPendingTransaction'
  }
}

export function createSqlAccountDeletionStore(db: Db): AccountDeletionStore {
  return {
    async loadStatus(userId) {
      const rows = await db.select(STATUS_COLUMNS).from(users).where(eq(users.id, userId)).limit(1)
      const row = rows[0]
      if (!row) return null
      if (row.accountStatus === 'DELETED') return null
      return toStatus(row)
    },

    async requestDeletion(input) {
      try {
        return await db.transaction(async (tx) => {
          // ① 锁账号行：与并发的重复申请 / 撤回 / 到期清理互斥。必须**先拿锁再判状态**，
          //    否则两个并发申请会各自读到 ACTIVE。
          const locked = await tx
            .select(STATUS_COLUMNS)
            .from(users)
            .where(eq(users.id, input.userId))
            .limit(1)
            .for('update')
          const row = locked[0]
          if (!row) {
            // requireAuth 刚读过同一行；到这里说明账号在同一请求内被物理删除（本仓库没有
            // 任何路径会物理删除 users）。抛错失败关闭，而不是当作「可以注销」继续写。
            throw new Error(`账号注销：users 行不存在（user=${input.userId}）`)
          }
          if (row.accountStatus === 'DELETED') {
            // 到期清理赢了这个竞态（见 `RequestDeletionOutcome.gone`）：回显式结果而非抛错，
            // 否则一个纯竞态会变成 500。
            return { kind: 'gone' }
          }
          if (row.accountStatus === 'DELETION_REQUESTED') {
            return { kind: 'already-requested', status: toStatus(row) }
          }

          // ② 封禁检查：生效中的 BAN 是硬阻塞（注销不能成为「一键解除封禁」的通道）。
          //    「生效中」的判定**引用** governance 的 `ACTIVE_RESTRICTION_WHERE`，不复制谓词：
          //    `expires_at` 是惰性过期（到期行在表里仍是 ACTIVE），裸 `status = 'ACTIVE'`
          //    会把已过期封禁也判成生效中，注销被永久 403。
          const banned = await tx
            .select({ id: userRestrictions.id })
            .from(userRestrictions)
            .where(
              and(
                eq(userRestrictions.userId, input.userId),
                eq(userRestrictions.type, 'BAN'),
                ACTIVE_RESTRICTION_WHERE,
              ),
            )
            .limit(1)
          if (banned.length > 0) return { kind: 'blocked-banned' }

          // ③ 下架在架商品：条件 UPDATE 顺带拿到商品行锁，与 accept 的
          //    `UPDATE listings SET status='RESERVED' WHERE id=? AND status='ACTIVE'` 串行。
          //    这一步同时是「注销后不能新增交易」的实现：交易创建要求商品仍是 ACTIVE
          //    （`transactions/service.ts` 的 `LISTING_NOT_ACTIVE`）。
          const offlined = await tx
            .update(listings)
            .set({ status: 'OFFLINE', updatedAt: input.now })
            .where(
              and(
                eq(listings.sellerId, input.userId),
                inArray(listings.status, ['ACTIVE', 'RESERVED']),
              ),
            )
            .returning({ id: listings.id })

          // ④ 复查（在下架之后）：卖家一侧的并发 accept 已被第 ③ 步的行锁排到我们前面或后面，
          //    所以这里看到的就是终局；买家一侧仍有极小窗口，由 worker 侧兜底。
          const blocking = await countBlockingTransactions(tx, input.userId)
          if (blocking.total > 0) throw new BlockedPendingTransaction(blocking)

          // ⑤ 落状态。CHECK 约束保证两个时间戳与状态同进同出。
          const updated = await tx
            .update(users)
            .set({
              accountStatus: 'DELETION_REQUESTED',
              deletionRequestedAt: input.now,
              purgeScheduledAt: input.purgeScheduledAt,
              updatedAt: input.now,
            })
            .where(eq(users.id, input.userId))
            .returning(STATUS_COLUMNS)
          const updatedRow = updated[0]
          if (!updatedRow) throw new Error(`账号注销：状态写入未返回行（user=${input.userId}）`)

          // ⑥ 撤销**其他**会话：当前设备保留（否则用户连状态都读不到、也没法撤回）。
          //    已撤销设备上的 WS 由 service 断开（hub.closeUser）。
          await tx
            .delete(sessions)
            .where(
              input.keepTokenHash === null
                ? eq(sessions.userId, input.userId)
                : and(
                    eq(sessions.userId, input.userId),
                    ne(sessions.tokenHash, input.keepTokenHash),
                  ),
            )

          return {
            kind: 'requested',
            status: toStatus(updatedRow),
            offlinedListingCount: offlined.length,
          }
        })
      } catch (error) {
        if (error instanceof BlockedPendingTransaction) {
          return { kind: 'blocked-pending-transaction', blocking: error.blocking }
        }
        throw error
      }
    },

    async withdrawDeletion(input) {
      return db.transaction(async (tx) => {
        const locked = await tx
          .select(STATUS_COLUMNS)
          .from(users)
          .where(eq(users.id, input.userId))
          .limit(1)
          .for('update')
        const row = locked[0]
        if (!row) throw new Error(`账号注销撤回：users 行不存在（user=${input.userId}）`)
        // 到期清理赢了这个竞态：账号已去标识化，没有可撤回的状态（见 `RequestDeletionOutcome.gone`）。
        if (row.accountStatus === 'DELETED') return { kind: 'gone' }
        // 不在冷静期内（含 `ACTIVE`）：幂等空操作，回当前状态。
        if (row.accountStatus !== 'DELETION_REQUESTED') {
          return { kind: 'noop' as const, status: toStatus(row) }
        }

        const updated = await tx
          .update(users)
          .set({
            accountStatus: 'ACTIVE',
            deletionRequestedAt: null,
            purgeScheduledAt: null,
            updatedAt: input.now,
          })
          .where(eq(users.id, input.userId))
          .returning(STATUS_COLUMNS)
        const updatedRow = updated[0]
        if (!updatedRow) throw new Error(`账号注销撤回：状态写入未返回行（user=${input.userId}）`)

        // 注意：商品**不**恢复上架（冻结口径 Q17）。下架是账号注销流程的一部分，
        // 撤回申请只把账号状态还原，商品要用户自己重新上架 —— 端上在申请时就会提示这一点。
        return { kind: 'withdrawn' as const, status: toStatus(updatedRow) }
      })
    },
  }
}
