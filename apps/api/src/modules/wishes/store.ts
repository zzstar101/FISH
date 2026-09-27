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
    row: WishRow,
    activeLimit: number,
    createdAfter: Date,
  ): Promise<CreateWishResult>
  findById(id: string): Promise<WishRow | null>
  listByUser(
    userId: string,
    filter: { status?: WishStatus; limit: number; offset: number },
  ): Promise<{ rows: WishRow[]; total: number }>
  update(id: string, fields: EditableWishFields, updatedAt: Date): Promise<WishRow | null>
  updateStatusIfActive(
    id: string,
    status: 'CLOSED' | 'FULFILLED',
    updatedAt: Date,
  ): Promise<WishRow | null>
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

        // 愿望与 MATCH_WISH job 用同一条语句写入（数据修改型 CTE，PG 保证必执行）：
        // 任一步失败整体回滚，不产生"愿望已落库但没有 job"的孤儿行。
        const created = firstWishRow(
          await tx.execute(sql`
          WITH inserted AS (
            INSERT INTO wishes (id, user_id, keyword, category, budget_min_cents, budget_max_cents,
                                description, accept_similar, status, created_at, updated_at)
            VALUES (${row.id}, ${row.user_id}, ${row.keyword}, ${row.category}, ${row.budget_min_cents},
                    ${row.budget_max_cents}, ${row.description}, ${row.accept_similar}, ${row.status},
                    ${row.created_at}, ${row.updated_at})
            RETURNING *
          ), match_job AS (
            INSERT INTO jobs (id, type, payload)
            SELECT ${newId()}, 'MATCH_WISH', jsonb_build_object('wishId', inserted.id::text)
            FROM inserted
            RETURNING id
          )
          SELECT * FROM inserted
        `),
        )
        if (!created) throw new Error('创建愿望后未返回记录')
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

    async update(id, fields, updatedAt) {
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
        sql`updated_at = ${updatedAt}`,
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

    async updateStatusIfActive(id, status, updatedAt) {
      return firstWishRow(
        await db.execute(sql`
        UPDATE wishes SET status = ${status}, updated_at = ${updatedAt}
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
