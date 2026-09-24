import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { sql } from 'drizzle-orm'
import { insertSystemWithin, type MessageRow } from '../messages/store'

/** transactions 表的行（snake_case 与 DB 列名一致）。 */
export interface TransactionRow {
  id: string
  conversation_id: string
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
export type AcceptResult =
  | { kind: 'created'; row: TransactionRow; message: MessageRow }
  | { kind: 'listing-not-active' }

/** DTO 内嵌商品摘要的 DB 投影；cover 只给 objectKey，URL 由 service 经 MediaStorage 拼。 */
export interface TxListingBrief {
  id: string
  title: string
  priceCents: number
  status: string
  coverObjectKey: string | null
}

/** DTO 内嵌对方用户摘要的 DB 投影。 */
export interface TxUserBrief {
  id: string
  nickname: string
  avatarUrl: string | null
}

/** transaction_meetup_tokens 的行（#70）。状态不落列，由 service 按 consumed 派生。 */
export interface MeetupTokenRow {
  transaction_id: string
  token_hash: string
  code_hash: string
  issued_by: string
  issued_at: Date | string
  consumed_at: Date | string | null
  consumed_by: string | null
  failed_attempts: number
  locked_until: Date | string | null
}

/** 核销时出示的凭证（QR token 或 6 位码）——service 已哈希，store 只比对列。 */
export type MeetupConsumeInput = { kind: 'qr'; hash: string } | { kind: 'code'; hash: string }

/** 原子核销的结果细分：'ok' 之外的分支都由条件更新 0 行后的**当前行状态**诊断得出。 */
export type MeetupConsumeResult =
  | { kind: 'ok'; row: MeetupTokenRow }
  | { kind: 'not-found' }
  | { kind: 'consumed' }
  | { kind: 'locked' }
  | { kind: 'invalid' }

export interface TransactionStore {
  findConversation(conversationId: string, viewerId: string): Promise<ConversationLookup>
  /** 一批交易的 listing 摘要（每个商品取 sort_order = 0 的封面）；查过但无图显式 null。 */
  listingBriefs(listingIds: string[]): Promise<Map<string, TxListingBrief>>
  /** 一批交易对方用户的摘要（uuid 主键查询，结果必在；缺失键 = 查过但不存在）。 */
  userBriefs(userIds: string[]): Promise<Map<string, TxUserBrief>>
  /**
   * 卖家接受并创建交易（契约：唯一建行端点）。原子性 =
   * 条件更新 `UPDATE listings SET status='RESERVED' WHERE id = ? AND status='ACTIVE'`
   * （0 行 → listing-not-active）+ transactions 部分唯一索引兜底（重复 live 交易会
   * 让事务整体失败，调用方同样收到 listing-not-active 语义）。
   *
   * `tx.accepted` 的 SYSTEM 消息在**同一个事务**里写入（#40-3），因此不会出现
   * 「交易已创建、确认消息却永久缺失」的部分成功。交易 id 只有插入后才存在，
   * 所以 content 由调用方以回调形式给出（序列化仍是 service 的职责）。
   */
  accept(
    brief: TxBrief,
    amountCents: number,
    buildSystemContent: (transactionId: string) => string,
  ): Promise<AcceptResult>
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
  findMeetupToken(transactionId: string): Promise<MeetupTokenRow | null>
  /**
   * 确保并读取面交凭证（#70；#175 一单一码）：一行对应一笔交易**唯一**的那枚凭证。
   * 行不存在时按传入哈希创建；已存在时返回同一行——**未核销**才把哈希对齐到传入值
   * （派生码恒定，正常行等于无操作；对改动前签发的随机码历史行是一次性自愈），
   * 已核销的行不复活、不重写哈希（#175 没有重签动作，consumed 是终点）。
   * 每次调用都复位 failed_attempts / locked_until（#175 冻结：卖家重新取码是现场
   * 解锁的唯一路径），issued_at / consumed_at / consumed_by 一律不动。
   * **原子性（防 TOCTOU）**：事务内先 `SELECT … FOR UPDATE` 锁定交易行并校验
   * PENDING_MEETUP + 卖家身份，校验通过才写凭证行——201 的承诺是「持锁那一刻
   * 交易仍可出示」；cancel/complete 与 issue 并发时在交易行锁上串行化，终态交易
   * 不会拿到新凭证（返回 null，service 据此给 409）。
   */
  upsertMeetupToken(
    transactionId: string,
    input: { tokenHash: string; codeHash: string; issuedBy: string },
  ): Promise<MeetupTokenRow | null>
  /**
   * 原子核销（#70 的「一次性」）：匹配明文哈希 + 未消费 + 未锁定的条件更新
   * （#147：无过期路径，凭证在 PENDING_MEETUP 生命周期内有效），并发重复核销
   * 只有一者成功（其余按当前行状态诊断，见 MeetupConsumeResult）。
   * 成功核销在**同一事务**里给卖家盖面交确认（seller_confirmed_at 保持已值）——
   * 展示码即卖家对面交的同意；买家侧确认由客户端按 nextAction 再调 confirm。
   * 若买家侧已先行单侧确认（#11 允许停在 PENDING），核销就是**第二侧确认事件**：
   * 同事务镜像 confirm 的合并语义，把交易推进 COMPLETED + listing SOLD（无条件，
   * 与 confirm 同一论证：交易完成必然连带商品售出），并**同事务删除凭证行**
   * （#147 终态销毁）。
   * 与 cancel / complete 的并发（#147 起不再有窗口）：本方法自事务开头就 `FOR UPDATE`
   * 锁定交易行，与 cancel / confirm / upsert 的顺序一致（先交易行、后凭证行），二者在
   * 交易行锁上串行化——因此不会 AB-BA 死锁，也不存在「核销读到 PENDING、随后被取消」
   * 的中间态。若取锁时交易已是终态，抛 MeetupConsumeRaceError（service 映射 409）；
   * 终态以 transactions 为唯一真相。
   */
  consumeMeetupToken(
    transactionId: string,
    userId: string,
    presented: MeetupConsumeInput,
  ): Promise<MeetupConsumeResult>
  /**
   * 核销失败累计；达到阈值置 locked_until（防 6 位码被爆破）。
   * `generation` 是诊断「不匹配」那一刻读到的行哈希：计数只在行仍是**同一代凭证**
   * 时生效——哈希换代（历史行自愈）后，并发中的旧请求无法把失败记到新码上，
   * 多个过期请求也不能把刚对齐的码立即锁死。
   * 锁定到期后计数刻意不归零：再错一次立即重新锁定（持续计数），卖家重新取码时才清零。
   */
  recordMeetupTokenFailure(
    transactionId: string,
    generation: { tokenHash: string; codeHash: string },
    maxAttempts: number,
    lockSeconds: number,
  ): Promise<{ failedAttempts: number; lockedUntil: Date | string | null } | null>
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

const MEETUP_TOKEN_COLUMNS = sql`transaction_id, token_hash, code_hash, issued_by,
  issued_at, consumed_at, consumed_by, failed_attempts, locked_until`

function toMeetupTokenRow(row: Record<string, unknown>): MeetupTokenRow {
  return {
    transaction_id: row.transaction_id as string,
    token_hash: row.token_hash as string,
    code_hash: row.code_hash as string,
    issued_by: row.issued_by as string,
    issued_at: row.issued_at as Date,
    consumed_at: (row.consumed_at as Date | null) ?? null,
    consumed_by: (row.consumed_by as string | null) ?? null,
    failed_attempts: row.failed_attempts as number,
    locked_until: (row.locked_until as Date | null) ?? null,
  }
}

/** 交易核销事务内发现交易已离开 PENDING_MEETUP：抛出以回滚消费，service 重读后给出 409。 */
export class MeetupConsumeRaceError extends Error {
  constructor(readonly transactionId: string) {
    super(`核销时交易已离开 PENDING_MEETUP：transaction=${transactionId}`)
    this.name = 'MeetupConsumeRaceError'
  }
}

/** 条件更新 0 行后的诊断：按当前行状态区分消费/锁定/不匹配。 */
async function diagnoseMeetupToken(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  transactionId: string,
): Promise<Exclude<MeetupConsumeResult, { kind: 'ok' }>['kind']> {
  const result = await tx.execute(sql`
    SELECT ${MEETUP_TOKEN_COLUMNS},
           (locked_until IS NOT NULL AND locked_until > now()) AS is_locked
    FROM transaction_meetup_tokens
    WHERE transaction_id = ${transactionId}
  `)
  const row = rowsOf(result)[0]
  if (!row) return 'not-found'
  if (row.consumed_at != null) return 'consumed'
  if (row.is_locked === true) return 'locked'
  return 'invalid'
}

function toRow(row: Record<string, unknown>): TransactionRow {
  return {
    id: row.id as string,
    conversation_id: row.conversation_id as string,
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

    async listingBriefs(listingIds) {
      const map = new Map<string, TxListingBrief>()
      if (listingIds.length === 0) return map
      const result = await db.execute(sql`
        SELECT l.id, l.title, l.price_cents, l.status::text AS status,
               li.object_key AS cover_object_key
        FROM listings l
        LEFT JOIN LATERAL (
          -- 只认 0 号图（#6 契约 §1「下标即 sortOrder，0 = 封面」）。取"最小 sort_order"会在
          -- 缺少 0 号图的脏数据下把非封面图当封面，与 profile 侧对同一张订单卡的口径分叉
          -- （#40/F3）；profile 与 listings feed 都用 sort_order = 0。
          SELECT object_key FROM listing_images
          WHERE listing_id = l.id AND sort_order = 0
          LIMIT 1
        ) li ON TRUE
        WHERE l.id IN (${sql.join(
          listingIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `)
      for (const row of rowsOf(result)) {
        map.set(row.id as string, {
          id: row.id as string,
          title: row.title as string,
          priceCents: row.price_cents as number,
          status: row.status as string,
          coverObjectKey: (row.cover_object_key as string | null) ?? null,
        })
      }
      return map
    },

    async userBriefs(userIds) {
      const map = new Map<string, TxUserBrief>()
      if (userIds.length === 0) return map
      const result = await db.execute(sql`
        SELECT id, nickname, avatar_url FROM users
        WHERE id IN (${sql.join(
          userIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `)
      for (const row of rowsOf(result)) {
        map.set(row.id as string, {
          id: row.id as string,
          nickname: row.nickname as string,
          avatarUrl: (row.avatar_url as string | null) ?? null,
        })
      }
      return map
    },

    async accept(brief, amountCents, buildSystemContent) {
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

        // ③ `tx.accepted` 与交易行同一事务（#40-3）：消息写失败则整笔回滚，
        //    不会留下「交易已创建、确认消息永久缺失」的部分成功。
        const transactionId = row.id as string
        const linked = await tx.execute(sql`
          SELECT t.*, c.id AS conversation_id
          FROM transactions t
          JOIN conversations c
            ON c.listing_id = t.listing_id
           AND c.buyer_id = t.buyer_id
           AND c.seller_id = t.seller_id
          WHERE t.id = ${transactionId}
        `)
        const linkedRow = rowsOf(linked)[0]
        if (!linkedRow) throw new Error(`交易缺少对应会话：transaction=${transactionId}`)
        const message = await insertSystemWithin(tx, brief.id, buildSystemContent(transactionId))
        return { kind: 'created', row: toRow(linkedRow), message }
      })
    },

    async findById(id) {
      const result = await db.execute(sql`
        SELECT t.*, c.id AS conversation_id
        FROM transactions t
        JOIN conversations c
          ON c.listing_id = t.listing_id
         AND c.buyer_id = t.buyer_id
         AND c.seller_id = t.seller_id
        WHERE t.id = ${id}
      `)
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
        SELECT t.*, c.id AS conversation_id,
               to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 AS created_at_cursor
        FROM transactions t
        JOIN conversations c
          ON c.listing_id = t.listing_id
         AND c.buyer_id = t.buyer_id
         AND c.seller_id = t.seller_id
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
          const linked = await tx.execute(sql`
            SELECT t.*, c.id AS conversation_id
            FROM transactions t
            JOIN conversations c
              ON c.listing_id = t.listing_id
             AND c.buyer_id = t.buyer_id
             AND c.seller_id = t.seller_id
            WHERE t.id = ${id}
          `)
          const linkedRow = rowsOf(linked)[0]
          if (!linkedRow) return { kind: 'cancelled' }
          return { kind: 'ok', row: toRow(linkedRow) } // COMPLETED：幂等
        }

        const linked = await tx.execute(sql`
          SELECT t.*, c.id AS conversation_id
          FROM transactions t
          JOIN conversations c
            ON c.listing_id = t.listing_id
           AND c.buyer_id = t.buyer_id
           AND c.seller_id = t.seller_id
          WHERE t.id = ${id}
        `)
        const linkedRow = rowsOf(linked)[0]
        if (!linkedRow) return { kind: 'cancelled' }

        // 双侧确认齐 → 同事务完成交易并 SOLD 商品；CHECK 约束保证 completed_at 与 status 一致。
        const merged = toRow(linkedRow)
        if (merged.buyer_confirmed_at && merged.seller_confirmed_at) {
          const done = await tx.execute(sql`
            WITH txn AS (
              UPDATE transactions SET status = 'COMPLETED', completed_at = now(), updated_at = now()
              WHERE id = ${id} AND status = 'PENDING_MEETUP'
              RETURNING ${TX_COLUMNS}
            ), listing AS (
              -- 刻意不筛 l.status = 'RESERVED'：契约冻结的是「完成后 Listing -> SOLD」。
              -- 带谓词时，若商品状态漂移出 RESERVED，这一步影响 0 行、而交易照样被标
              -- COMPLETED → 「交易已完成但商品未售出」的自相矛盾（#40-4）。
              -- 去掉谓词后，交易完成必然连带把商品置为 SOLD，不变量由构造保证。
              UPDATE listings l SET status = 'SOLD', updated_at = now()
              FROM txn WHERE l.id = txn.listing_id
            )
            SELECT txn.*, c.id AS conversation_id
            FROM txn JOIN conversations c
              ON c.listing_id = txn.listing_id
             AND c.buyer_id = txn.buyer_id
             AND c.seller_id = txn.seller_id
          `)
          const doneRow = rowsOf(done)[0]
          if (doneRow) {
            // #147 终态销毁：凭证随交易同事务删除，COMPLETED 后旧码不可再用。
            // 必须是独立语句（不能塞进上面 CTE）：本事务自开头就持有交易行锁，
            // 与 cancel 同款论证见 cancel 内注释——READ COMMITTED 下同一条 CTE 里
            // DELETE 对非目标表用语句开头快照，并发 issue 在本语句求值后提交的
            // 凭证行不可见，终态交易上凭证幸存（#76）。
            await tx.execute(
              sql`DELETE FROM transaction_meetup_tokens WHERE transaction_id = ${id}`,
            )
            return { kind: 'ok', row: toRow(doneRow) }
          }
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
            -- 契约冻结（packages/contracts/src/transactions/schema.ts:168-169）：cancel 恢复
            -- listing 是**无条件** RESERVED → ACTIVE（#6 禁止在 RESERVED 上手动下架，因此
            -- 取消那一刻商品必仍是 RESERVED，不需要条件更新）。带谓词时状态一旦漂移就退化成
            -- 「交易已 CANCELLED、商品却停在 OFFLINE」——与 confirm 侧同一论证（#40-4）。
            UPDATE listings l SET status = 'ACTIVE', updated_at = now()
            FROM txn WHERE l.id = txn.listing_id
          )
          SELECT txn.*, c.id AS conversation_id
          FROM txn JOIN conversations c
            ON c.listing_id = txn.listing_id
           AND c.buyer_id = txn.buyer_id
           AND c.seller_id = txn.seller_id
        `)
        const row = rowsOf(cancelled)[0]
        if (row) {
          // #147 终态销毁：凭证随交易同事务删除，CANCELLED 后旧码不可再用。
          // 必须是独立语句（不能塞进上面 CTE 的 token 分支）：READ COMMITTED 下，
          // 同一条 CTE 里 DELETE 对非目标表（这里即凭证表）用**语句开头**的快照，
          // 锁等待后的 EvalPlanQual 重评估只作用于 UPDATE/DELETE 的目标行本身。
          // 并发 issue（upsertMeetupToken）持交易行锁先提交了凭证行、本语句才开始
          // 求值时，DELETE 看不见那行 → CANCELLED 交易上凭证幸存（#76 修复的 flake：
          // 测试按「CANCELLED ⇒ token 必不存在」断言而红）。独立语句持有本事务已拿
          // 的交易行锁，issue 要么已被挡下（返回 null），要么已提交、这条 DELETE 的
          // 新快照必然看得到它。幂等重入时凭证已删，0 行无害。
          await tx.execute(sql`DELETE FROM transaction_meetup_tokens WHERE transaction_id = ${id}`)
          return { kind: 'ok', row: toRow(row) }
        }

        // 没取消成功：区分 COMPLETED（拒绝）与 CANCELLED（幂等）
        const existing = await tx.execute(sql`
          SELECT t.*, c.id AS conversation_id
          FROM transactions t
          JOIN conversations c
            ON c.listing_id = t.listing_id
           AND c.buyer_id = t.buyer_id
           AND c.seller_id = t.seller_id
          WHERE t.id = ${id} AND ${viewerId} IN (t.buyer_id, t.seller_id)
        `)
        const current = rowsOf(existing)[0]
        if (!current) return { kind: 'not-found' }
        if (current.status === 'COMPLETED') return { kind: 'not-cancellable' }
        return { kind: 'ok', row: toRow(current) } // 已 CANCELLED：幂等返回现状
      })
    },

    async findMeetupToken(transactionId) {
      const result = await db.execute(sql`
        SELECT transaction_id, token_hash, code_hash, issued_by,
               issued_at, consumed_at, consumed_by, failed_attempts, locked_until
        FROM transaction_meetup_tokens
        WHERE transaction_id = ${transactionId}
      `)
      const row = rowsOf(result)[0]
      return row ? toMeetupTokenRow(row) : null
    },

    async upsertMeetupToken(transactionId, input) {
      return db.transaction(async (tx) => {
        // 先锁交易行并校验状态与卖家（FOR UPDATE）：issue 与 cancel/complete 在交易行
        // 锁上串行化，杜绝「service 检查 PENDING 之后、写入之前交易进入终态」的窗口。
        const locked = await tx.execute(sql`
          SELECT id FROM transactions
          WHERE id = ${transactionId}
            AND status = 'PENDING_MEETUP'
            AND seller_id = ${input.issuedBy}
          FOR UPDATE
        `)
        if (rowsOf(locked).length === 0) return null
        const result = await tx.execute(sql`
          INSERT INTO transaction_meetup_tokens
            (transaction_id, token_hash, code_hash, issued_by)
          VALUES (${transactionId}, ${input.tokenHash}, ${input.codeHash}, ${input.issuedBy})
          ON CONFLICT (transaction_id) DO UPDATE SET
            -- #175：已核销的行**不复活、不重写哈希** —— 没有重签动作，consumed 是终点；
            -- 未核销时把哈希对齐到传入值（同一枚派生码的哈希是常量，等于无操作；
            -- 对改动前签发的随机码历史行，这一次对齐就是唯一一次「静默修好」）。
            token_hash = CASE
              WHEN transaction_meetup_tokens.consumed_at IS NULL THEN EXCLUDED.token_hash
              ELSE transaction_meetup_tokens.token_hash
            END,
            code_hash = CASE
              WHEN transaction_meetup_tokens.consumed_at IS NULL THEN EXCLUDED.code_hash
              ELSE transaction_meetup_tokens.code_hash
            END,
            issued_by = EXCLUDED.issued_by,
            -- 卖家重新取码 = 复位防爆破计数与锁定（#175 冻结：这是现场解锁的唯一路径）。
            failed_attempts = 0,
            locked_until = NULL
          RETURNING transaction_id, token_hash, code_hash, issued_by,
                    issued_at, consumed_at, consumed_by, failed_attempts, locked_until
        `)
        const row = rowsOf(result)[0]
        if (!row) throw new Error(`面交凭证签发失败：transaction=${transactionId}`)
        return toMeetupTokenRow(row)
      })
    },

    async consumeMeetupToken(transactionId, userId, presented) {
      return db.transaction(async (tx) => {
        // #147 锁序：**先交易行、后凭证行**，与 cancel / confirm / upsert 完全一致。
        // cancel / confirm 现在会在同一事务里 DELETE 凭证行（它们先锁交易行），若核销
        // 反向先锁凭证行再锁交易行，redeem × cancel 并发就是 AB-BA 死锁（40P01 →
        // 客户端 500）。统一锁序后，核销与终态迁移在交易行锁上串行化，既消除死锁，
        // 也让下面「stamp 落 0 行」的窗口不再可达（保留为防御性兜底）。
        const locked = await tx.execute(sql`
          SELECT id, status::text AS status FROM transactions
          WHERE id = ${transactionId} FOR UPDATE
        `)
        const lockedRow = rowsOf(locked)[0]
        if (!lockedRow) return { kind: 'not-found' }
        // 终态核销与 service 的 409 口径一致：拿到交易行锁后交易已离开 PENDING_MEETUP
        // （service 前置检查之后、取锁之前被 cancel/complete 抢先）时抛同一错误，
        // 由 service 映射成 409 TRANSACTION_NOT_IN_PENDING，而不是退化成 404。
        if (lockedRow.status !== 'PENDING_MEETUP') {
          throw new MeetupConsumeRaceError(transactionId)
        }
        // 条件更新承担全部竞态：明文哈希匹配 + 未消费 + 未锁定（#147：无过期路径，
        // 凭证在 PENDING_MEETUP 生命周期内有效），并发重复核销时只有一者拿到行，
        // 其余落到下方按行状态诊断。
        const column = presented.kind === 'qr' ? sql`token_hash` : sql`code_hash`
        const consumed = await tx.execute(sql`
          UPDATE transaction_meetup_tokens
          SET consumed_at = now(), consumed_by = ${userId}
          WHERE transaction_id = ${transactionId}
            AND ${column} = ${presented.hash}
            AND consumed_at IS NULL
            AND (locked_until IS NULL OR locked_until <= now())
          RETURNING transaction_id, token_hash, code_hash, issued_by,
                    issued_at, consumed_at, consumed_by, failed_attempts, locked_until
        `)
        const okRow = rowsOf(consumed)[0]
        if (okRow) {
          // 展示码 = 卖家对面交的同意：同一事务里盖卖家确认（已值保持，COALESCE 幂等）。
          // 交易行锁自事务开头持有，状态在锁内已校验为 PENDING_MEETUP，故这里必然命中；
          // 0 行仅作防御（不可达），仍抛同一错误交 service 定论。
          const stamped = await tx.execute(sql`
            UPDATE transactions
            SET seller_confirmed_at = COALESCE(seller_confirmed_at, now()), updated_at = now()
            WHERE id = ${transactionId} AND status = 'PENDING_MEETUP'
            RETURNING id
          `)
          if (rowsOf(stamped).length === 0) {
            throw new MeetupConsumeRaceError(transactionId)
          }
          // 买家侧已先行单侧确认（#11）时，本次核销就是第二侧确认事件：
          // 镜像 confirm 的合并语义（packages/contracts/src/transactions/schema.ts 状态机注释）
          // 在同一事务推进 COMPLETED + listing SOLD。listing 不带状态谓词——交易完成
          // 必然连带商品售出，否则会留下「交易已完成、商品未售出」的自相矛盾（#40-4 同款）。
          // 0 行 = 买家尚未确认，交易停在 PENDING 等客户端的 confirm（幂等）。
          const finished = await tx.execute(sql`
            WITH txn AS (
              UPDATE transactions SET status = 'COMPLETED', completed_at = now(), updated_at = now()
              WHERE id = ${transactionId} AND status = 'PENDING_MEETUP'
                AND buyer_confirmed_at IS NOT NULL AND seller_confirmed_at IS NOT NULL
              RETURNING id, listing_id
            ), listing AS (
              UPDATE listings l SET status = 'SOLD', updated_at = now()
              FROM txn WHERE l.id = txn.listing_id
            )
            SELECT id FROM txn
          `)
          // #147 终态销毁：推进 COMPLETED 的同事务删除凭证行。独立语句而不是上面的
          // CTE token 分支，理由与 cancel / confirm 相同（READ COMMITTED 快照论证见
          // cancel 内注释）；本事务自开头就持有交易行锁，issue 的 FOR UPDATE 拿不到
          // 交易行锁，不存在「DELETE 之后凭证复活」的一方。交易未推进（0 行）时
          // 凭证保留（仍是当前有效凭证），所以只在这里删。
          if (rowsOf(finished).length > 0) {
            await tx.execute(
              sql`DELETE FROM transaction_meetup_tokens WHERE transaction_id = ${transactionId}`,
            )
          }
          return { kind: 'ok', row: toMeetupTokenRow(okRow) }
        }
        return { kind: await diagnoseMeetupToken(tx, transactionId) }
      })
    },

    async recordMeetupTokenFailure(transactionId, generation, maxAttempts, lockSeconds) {
      // WHERE 绑定「诊断不匹配那一刻」的行哈希（凭证代际）：哈希换代（历史行自愈）后，
      // 并发旧请求的失败落 0 行（返回 null 被丢弃），不会累计到新一代凭证上。
      const result = await db.execute(sql`
        UPDATE transaction_meetup_tokens
        SET failed_attempts = failed_attempts + 1,
            locked_until = CASE
              WHEN failed_attempts + 1 >= ${maxAttempts}
                THEN now() + make_interval(secs => ${lockSeconds})
              ELSE locked_until
            END
        WHERE transaction_id = ${transactionId}
          AND token_hash = ${generation.tokenHash}
          AND code_hash = ${generation.codeHash}
        RETURNING failed_attempts, locked_until
      `)
      const row = rowsOf(result)[0]
      if (!row) return null
      return {
        failedAttempts: row.failed_attempts as number,
        lockedUntil: (row.locked_until as Date | string | null) ?? null,
      }
    },
  }
}
