import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'

/** transactions 表的行（snake_case 与 DB 列名一致）。 */
export interface TransactionRow {
  id: string
  listing_id: string
  buyer_id: string
  seller_id: string
  amount_cents: number
  status: string
  buyer_confirmed_at: Date | string | null
  seller_confirmed_at: Date | string | null
  completed_at: Date | string | null
  cancelled_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

/** 会话定位所需的最小投影（conversation 唯一对应 (listing, buyer)）。 */
export interface TxBrief {
  id: string
  buyerId: string
  sellerId: string
  listingId: string
  listingStatus: string
}

/** 会话定位失败的原因细分：service 据此映射 404 / 403 / 409。 */
export type ConversationLookup = { kind: 'not-found' } | { kind: 'ok'; brief: TxBrief }

/** 接受的结果细分：条件更新失败 = 商品已非 ACTIVE（并发输掉或状态漂移）。 */
export type AcceptResult = { kind: 'created'; row: TransactionRow } | { kind: 'listing-not-active' }

export interface TransactionStore {
  findConversation(conversationId: string, viewerId: string): Promise<ConversationLookup>
  /**
   * 卖家接受并创建交易（契约：唯一建行端点）。原子性 =
   * 条件更新 `UPDATE listings SET status='RESERVED' WHERE id = ? AND status='ACTIVE'`
   * （0 行 → listing-not-active）+ transactions 部分唯一索引兜底（重复 live 交易会
   * 让事务整体失败，调用方同样收到 listing-not-active 语义）。
   */
  accept(brief: TxBrief, amountCents: number): Promise<AcceptResult>
  findById(id: string): Promise<TransactionRow | null>
  /** 我的交易页（DESC + limit+1 判底行；lastCreatedAtCursor 仅本查询填充）。 */
  listForUser(
    viewerId: string,
    filter: {
      role?: 'buyer' | 'seller'
      status?: 'PENDING_MEETUP' | 'COMPLETED' | 'CANCELLED'
      limit: number
      cursor: { sortKey: string; id: string } | null
    },
  ): Promise<TransactionRow[]>
  /**
   * 查看者一侧确认面交。已在 CANCELLED 上返回 'cancelled'；否则推进本侧时间戳，
   * 双侧齐时同事务置 COMPLETED + completed_at + listing SOLD。
   */
  confirm(
    id: string,
    viewerId: string,
    role: 'buyer' | 'seller',
  ): Promise<{ kind: 'ok'; row: TransactionRow } | { kind: 'cancelled' }>
  /** 取消：PENDING_MEETUP → CANCELLED + listing 恢复 ACTIVE（COMPLETED 交给 service 拒绝）。 */
  cancel(
    id: string,
    viewerId: string,
  ): Promise<{ kind: 'ok'; row: TransactionRow } | { kind: 'not-cancellable' | 'not-found' }>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function toRow(row: Record<string, unknown>): TransactionRow {
  return {
    id: row.id as string,
    listing_id: row.listing_id as string,
    buyer_id: row.buyer_id as string,
    seller_id: row.seller_id as string,
    amount_cents: row.amount_cents as number,
    status: row.status as string,
    buyer_confirmed_at: (row.buyer_confirmed_at as Date | string | null) ?? null,
    seller_confirmed_at: (row.seller_confirmed_at as Date | string | null) ?? null,
    completed_at: (row.completed_at as Date | string | null) ?? null,
    cancelled_at: (row.cancelled_at as Date | string | null) ?? null,
    created_at: row.created_at as Date | string,
    updated_at: row.updated_at as Date | string,
  }
}

const TX_COLUMNS = sql`id, listing_id, buyer_id, seller_id, amount_cents, status::text,
  buyer_confirmed_at, seller_confirmed_at, completed_at, cancelled_at, created_at, updated_at`

/**
 * 唯一索引冲突（SQLSTATE 23505）的形状探测：drizzle 0.45 把驱动错误包进
 * DrizzleQueryError（.code 为 undefined），真正的 Bun PostgresError 在 .cause 上，
 * 且 SQLSTATE 放在 .errno（.code 是 ERR_POSTGRES_SERVER_ERROR）——所以沿 cause 链
 * 递归找 errno/code。（形状实测于真库；依赖升级后若形状变化，集成测试会先红。）
 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const err = error as { code?: string; errno?: string; cause?: unknown }
  if (err.code === '23505' || err.errno === '23505') return true
  return isUniqueViolation(err.cause)
}

export function createSqlTransactionStore(db: Db): TransactionStore {
  return {
    async findConversation(conversationId, viewerId) {
      const result = await db.execute(sql`
        SELECT c.id, c.buyer_id, c.seller_id, c.listing_id, l.status::text AS listing_status
        FROM conversations c JOIN listings l ON l.id = c.listing_id
        WHERE c.id = ${conversationId} AND ${viewerId} IN (c.buyer_id, c.seller_id)
      `)
      const row = rowsOf(result)[0]
      if (!row) return { kind: 'not-found' }
      return {
        kind: 'ok',
        brief: {
          id: row.id as string,
          buyerId: row.buyer_id as string,
          sellerId: row.seller_id as string,
          listingId: row.listing_id as string,
          listingStatus: row.listing_status as string,
        },
      }
    },

    async accept(brief, amountCents) {
      return db.transaction(async (tx) => {
        // ① 条件更新锁定 Listing：0 行 = 已被并发买家锁定 / 已售 / 已下架。
        // ② 部分唯一索引 transactions_listing_id_live_uq 兜底同一 listing 的第二笔 live 交易。
        const lock = await tx.execute(sql`
          UPDATE listings SET status = 'RESERVED', updated_at = now()
          WHERE id = ${brief.listingId} AND status = 'ACTIVE'
          RETURNING id
        `)
        if (rowsOf(lock).length === 0) return { kind: 'listing-not-active' }

        const insert = await tx
          .execute(sql`
          INSERT INTO transactions (id, listing_id, buyer_id, seller_id, amount_cents)
          VALUES (${newId()}, ${brief.listingId}, ${brief.buyerId}, ${brief.sellerId}, ${amountCents})
          RETURNING ${TX_COLUMNS}
        `)
          .catch((error: unknown) => {
            // ② 部分唯一索引兜底（接口注释承诺的 listing-not-active 语义）：
            // listing 状态漂移出不变量（如被第三方改回 ACTIVE）时，同一 listing 的
            // 第二笔 live 交易在这里被 23505 拦下，映射成与条件更新相同的失败语义。
            if (isUniqueViolation(error)) return { rows: [] as Record<string, unknown>[] }
            throw error
          })
        const row = rowsOf(insert)[0]
        if (!row) return { kind: 'listing-not-active' }
        return { kind: 'created', row: toRow(row) }
      })
    },

    async findById(id) {
      const result = await db.execute(sql`SELECT ${TX_COLUMNS} FROM transactions WHERE id = ${id}`)
      const row = rowsOf(result)[0]
      return row ? toRow(row) : null
    },

    async listForUser(viewerId, { role, status, limit, cursor }) {
      const conditions = [sql`(${viewerId} IN (t.buyer_id, t.seller_id))`]
      if (role === 'buyer') conditions.push(sql`t.buyer_id = ${viewerId}`)
      if (role === 'seller') conditions.push(sql`t.seller_id = ${viewerId}`)
      if (status) conditions.push(sql`t.status = ${status}`)
      if (cursor) {
        // 行值比较 + 幂等排序键：同 (created_at, id) 元组的行不可能重复出现
        conditions.push(
          sql`(t.created_at, t.id) < (${cursor.sortKey}::timestamptz, ${cursor.id}::uuid)`,
        )
      }

      const result = await db.execute(sql`
        SELECT t.*, to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 AS created_at_cursor
        FROM transactions t
        WHERE ${sql.join(conditions, sql` AND `)}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${limit + 1}
      `)
      return rowsOf(result).map((row) => {
        const mapped = toRow(row)
        // created_at_cursor 透传给 service 生成游标（微秒精度，JS Date 只有毫秒）
        ;(mapped as TransactionRow & { created_at_cursor?: string }).created_at_cursor =
          row.created_at_cursor as string
        return mapped
      })
    },

    async confirm(id, viewerId, role) {
      return db.transaction(async (tx) => {
        // 条件更新：只允许 PENDING_MEETUP 上确认（CANCELLED → 返回给 service 409；
        // COMPLETED 上重复确认走幂等分支，见下）。
        const stamped = await tx.execute(sql`
          UPDATE transactions SET
            buyer_confirmed_at = CASE WHEN ${role} = 'buyer' THEN now() ELSE buyer_confirmed_at END,
            seller_confirmed_at = CASE WHEN ${role} = 'seller' THEN now() ELSE seller_confirmed_at END,
            updated_at = now()
          WHERE id = ${id} AND ${viewerId} IN (buyer_id, seller_id)
            AND status = 'PENDING_MEETUP'
          RETURNING ${TX_COLUMNS}
        `)
        const row = rowsOf(stamped)[0]
        if (!row) {
          // 没推进时间戳的两种可能：交易在 COMPLETED（幂等返回现状）或 CANCELLED（拒绝）
          const existing = await tx.execute(
            sql`SELECT ${TX_COLUMNS} FROM transactions WHERE id = ${id} AND ${viewerId} IN (buyer_id, seller_id)`,
          )
          const current = rowsOf(existing)[0]
          if (!current) return { kind: 'cancelled' } // 不可达：participant 校验在 service 已做
          if (current.status === 'CANCELLED') return { kind: 'cancelled' }
          return { kind: 'ok', row: toRow(current) } // COMPLETED：幂等
        }

        // 双侧确认齐 → 同事务完成交易并 SOLD 商品；CHECK 约束保证 completed_at 与 status 一致。
        const merged = toRow(row)
        if (merged.buyer_confirmed_at && merged.seller_confirmed_at) {
          const done = await tx.execute(sql`
            WITH txn AS (
              UPDATE transactions SET status = 'COMPLETED', completed_at = now(), updated_at = now()
              WHERE id = ${id} AND status = 'PENDING_MEETUP'
              RETURNING ${TX_COLUMNS}
            ), listing AS (
              UPDATE listings l SET status = 'SOLD', updated_at = now()
              FROM txn WHERE l.id = txn.listing_id AND l.status = 'RESERVED'
            )
            SELECT ${TX_COLUMNS} FROM txn
          `)
          const doneRow = rowsOf(done)[0]
          if (doneRow) return { kind: 'ok', row: toRow(doneRow) }
        }
        return { kind: 'ok', row: merged }
      })
    },

    async cancel(id, viewerId) {
      return db.transaction(async (tx) => {
        const cancelled = await tx.execute(sql`
          WITH txn AS (
            UPDATE transactions SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
            WHERE id = ${id} AND ${viewerId} IN (buyer_id, seller_id) AND status = 'PENDING_MEETUP'
            RETURNING ${TX_COLUMNS}
          ), listing AS (
            UPDATE listings l SET status = 'ACTIVE', updated_at = now()
            FROM txn WHERE l.id = txn.listing_id AND l.status = 'RESERVED'
          )
          SELECT ${TX_COLUMNS} FROM txn
        `)
        const row = rowsOf(cancelled)[0]
        if (row) return { kind: 'ok', row: toRow(row) }

        // 没取消成功：区分 COMPLETED（拒绝）与 CANCELLED（幂等）
        const existing = await tx.execute(
          sql`SELECT ${TX_COLUMNS} FROM transactions WHERE id = ${id} AND ${viewerId} IN (buyer_id, seller_id)`,
        )
        const current = rowsOf(existing)[0]
        if (!current) return { kind: 'not-found' }
        if (current.status === 'COMPLETED') return { kind: 'not-cancellable' }
        return { kind: 'ok', row: toRow(current) } // 已 CANCELLED：幂等返回现状
      })
    },
  }
}
