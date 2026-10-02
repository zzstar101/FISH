import type { WishCategory, WishStatus } from '@fish/contracts/wishes/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { type SQL, sql } from 'drizzle-orm'

/** 愿望持久化接口。DB schema/migration 由 Dev A 通过 DB CHANGE REQUEST 落地。 */
export interface WishRow {
  id: string
  user_id: string
  keyword: string
  category: string
  budget_min_cents: number
  budget_max_cents: number
  description: string | null
  accept_similar: boolean
  status: string
  created_at: Date | string
  updated_at: Date | string
  /** 匹配数（来自 matches 表）。仅 findById / listByUser 填充，缺省视为 0。 */
  match_count?: number
}

/**
 * 新建愿望的入参：`updated_at` 由数据库 `now()` 生成（见 `packages/db/src/schema/common.ts`
 * 的时钟说明——`updated_at` 是 #322 的向量新鲜度版本号，必须与 DB 同源）。
 *
 * `created_at` 仍由调用方给：它只用于软幂等窗口（`created_at >= createdAfter`）与展示，两侧
 * 都是应用钟，且测试靠回拨它把行挪到窗口外（`store.test.ts` 的 `oldRow`）。
 */
export type NewWishRow = Omit<WishRow, 'updated_at'>

export interface PoolRow {
  keyword: string
  category: string
  want_count: number
  median_budget_cents: number
}

export interface EditableWishFields {
  keyword?: string
  category?: WishCategory
  budgetMinCents?: number
  budgetMaxCents?: number
  description?: string | null
  acceptSimilar?: boolean
}

export type CreateWishResult =
  | { kind: 'created'; row: WishRow }
  | { kind: 'duplicate'; row: WishRow }
  | { kind: 'active-limit' }

export interface WishStore {
  createOrGetRecent(
    row: NewWishRow,
    activeLimit: number,
    createdAfter: Date,
  ): Promise<CreateWishResult>
  findById(id: string): Promise<WishRow | null>
  listByUser(
    userId: string,
    filter: { status?: WishStatus; limit: number; offset: number },
  ): Promise<{ rows: WishRow[]; total: number }>
  update(id: string, fields: EditableWishFields): Promise<WishRow | null>
  updateStatusIfActive(id: string, status: 'CLOSED' | 'FULFILLED'): Promise<WishRow | null>
  aggregatePool(minCount: number, limit: number): Promise<PoolRow[]>
}

function toRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function toWishRow(row: Record<string, unknown>): WishRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    keyword: String(row.keyword),
    category: String(row.category),
    budget_min_cents: Number(row.budget_min_cents),
    budget_max_cents: Number(row.budget_max_cents),
    description:
      row.description === null || row.description === undefined ? null : String(row.description),
    accept_similar: Boolean(row.accept_similar),
    status: String(row.status),
    created_at: row.created_at as Date | string,
    updated_at: row.updated_at as Date | string,
    match_count: row.match_count === undefined ? undefined : Number(row.match_count),
  }
}

function firstWishRow(result: unknown): WishRow | null {
  const row = toRows(result)[0]
  return row ? toWishRow(row) : null
}

export function createSqlWishStore(db: Db): WishStore {
  return {
    async createOrGetRecent(row, activeLimit, createdAfter) {
      return db.transaction(async (tx) => {
        // 同一 user_id 的短事务串行化，令查重、ACTIVE 配额与插入成为原子操作。
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.user_id}))`)
        const duplicate = firstWishRow(
          await tx.execute(sql`
          SELECT w.*, (SELECT count(*)::int FROM matches m WHERE m.wish_id = w.id) AS match_count
          FROM wishes w
          WHERE w.user_id = ${row.user_id} AND w.keyword = ${row.keyword} AND w.category = ${row.category}
            AND w.status = 'ACTIVE' AND w.created_at > ${createdAfter}
          ORDER BY w.created_at DESC
          LIMIT 1
        `),
        )
        if (duplicate) return { kind: 'duplicate', row: duplicate } as const

        const countResult = await tx.execute(sql`
          SELECT count(*)::int AS count FROM wishes
          WHERE user_id = ${row.user_id} AND status = 'ACTIVE'
        `)
        if (Number(toRows(countResult)[0]?.count ?? 0) >= activeLimit) {
          return { kind: 'active-limit' } as const
        }

        // 愿望与首批 job 在同一个事务里写：任一步失败整体回滚，不产生"愿望已落库但没有 job"
        // 的孤儿行。**从 #322 M4 起不再是"一条 CTE"而是三句**——为的是让 job 的插入顺序显式可读，
        // 事务边界不变（都在这一个 `db.transaction` 里），回滚语义一个字节不动。
        //
        // **顺序即语义（#322 M4）**：必须先投 `EMBED_WISH`、再投 `MATCH_WISH`。队列按 `(run_at, id)`
        // 领取，而 `run_at` 缺省取事务时间、`id = newId() = Bun.randomUUIDv7()`（同毫秒单调递增）
        // ⇒ 后一句插入的 job 两项都更大，先领到的一定是 `EMBED_WISH`。反序（含旧版把 MATCH_WISH
        // 写在前面）会让首轮 MATCH 跑在愿望自身向量落库之前：引擎按 M2 降级契约把该愿望的**所有**
        // match 行落成 `ranking_version = 1`，而 `EMBED_WISH` 跑完不会回头重投 MATCH ⇒ 新建愿望
        // 会永久停在 v1，直到被编辑。
        const created = firstWishRow(
          await tx.execute(sql`
          INSERT INTO wishes (id, user_id, keyword, category, budget_min_cents, budget_max_cents,
                              description, accept_similar, status, created_at, updated_at)
          VALUES (${row.id}, ${row.user_id}, ${row.keyword}, ${row.category}, ${row.budget_min_cents},
                  ${row.budget_max_cents}, ${row.description}, ${row.accept_similar}, ${row.status},
                  ${row.created_at}, now())
          RETURNING *
        `),
        )
        if (!created) throw new Error('创建愿望后未返回记录')

        await tx.execute(sql`
          INSERT INTO jobs (id, type, payload)
          VALUES (${newId()}, 'EMBED_WISH', jsonb_build_object('wishId', ${created.id}::text))
        `)
        await tx.execute(sql`
          INSERT INTO jobs (id, type, payload)
          VALUES (${newId()}, 'MATCH_WISH', jsonb_build_object('wishId', ${created.id}::text))
        `)

        return { kind: 'created', row: created } as const
      })
    },

    async findById(id) {
      return firstWishRow(
        await db.execute(sql`
        SELECT w.*, (SELECT count(*)::int FROM matches m WHERE m.wish_id = w.id) AS match_count
        FROM wishes w WHERE w.id = ${id} LIMIT 1
      `),
      )
    },

    async listByUser(userId, { status, limit, offset }) {
      const where = status
        ? sql`WHERE w.user_id = ${userId} AND w.status = ${status}`
        : sql`WHERE w.user_id = ${userId}`
      const rows = await db.execute(sql`
        SELECT w.*, (SELECT count(*)::int FROM matches m WHERE m.wish_id = w.id) AS match_count
        FROM wishes w ${where}
        ORDER BY w.created_at DESC, w.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `)
      const totalResult = await db.execute(
        sql`SELECT count(*)::int AS total FROM wishes w ${where}`,
      )
      return {
        rows: toRows(rows).map(toWishRow),
        total: Number(toRows(totalResult)[0]?.total ?? 0),
      }
    },

    async update(id, fields) {
      const sets: (SQL | undefined)[] = [
        fields.keyword !== undefined ? sql`keyword = ${fields.keyword}` : undefined,
        fields.category !== undefined ? sql`category = ${fields.category}` : undefined,
        fields.budgetMinCents !== undefined
          ? sql`budget_min_cents = ${fields.budgetMinCents}`
          : undefined,
        fields.budgetMaxCents !== undefined
          ? sql`budget_max_cents = ${fields.budgetMaxCents}`
          : undefined,
        fields.description !== undefined ? sql`description = ${fields.description}` : undefined,
        fields.acceptSimilar !== undefined
          ? sql`accept_similar = ${fields.acceptSimilar}`
          : undefined,
        sql`updated_at = now()`,
      ]
      return firstWishRow(
        await db.execute(sql`
        UPDATE wishes SET ${sql.join(
          sets.filter((fragment): fragment is SQL => fragment !== undefined),
          sql`, `,
        )}
        WHERE id = ${id} AND status = 'ACTIVE'
        RETURNING *, (SELECT count(*)::int FROM matches m WHERE m.wish_id = wishes.id) AS match_count
      `),
      )
    },

    async updateStatusIfActive(id, status) {
      return firstWishRow(
        await db.execute(sql`
        UPDATE wishes SET status = ${status}, updated_at = now()
        WHERE id = ${id} AND status = 'ACTIVE'
        RETURNING *, (SELECT count(*)::int FROM matches m WHERE m.wish_id = wishes.id) AS match_count
      `),
      )
    },

    async aggregatePool(minCount, limit) {
      const result = await db.execute(sql`
        SELECT keyword, category, count(*)::int AS want_count,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY budget_max_cents)::float8 AS median_budget_cents
        FROM wishes
        -- category / budget_max_cents 在 #2 的 schema 里可空（为 #8 的「不限分类」预留）；
        -- 需求池输出契约要求二者非空，这里显式过滤，避免 NULL 经 String(null) 变成 "null" 后让整个 /pool 400。
        WHERE status = 'ACTIVE' AND category IS NOT NULL AND budget_max_cents IS NOT NULL
        GROUP BY keyword, category
        -- 隐私门槛按「去重用户数」而非行数：同一用户刷多条不得把小组抬进需求池。
        HAVING count(DISTINCT user_id) >= ${minCount}
        ORDER BY want_count DESC, keyword ASC
        LIMIT ${limit}
      `)
      return toRows(result).map((row) => ({
        keyword: String(row.keyword),
        category: String(row.category),
        want_count: Number(row.want_count),
        median_budget_cents: Math.round(Number(row.median_budget_cents)),
      }))
    },
  }
}
