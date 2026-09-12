import type { WishCategory, WishStatus } from '@fish/contracts/wishes/schema'
import type { Db } from '@fish/db/client'
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
          SELECT * FROM wishes
          WHERE user_id = ${row.user_id} AND keyword = ${row.keyword} AND category = ${row.category}
            AND status = 'ACTIVE' AND created_at > ${createdAfter}
          ORDER BY created_at DESC
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

        const created = firstWishRow(
          await tx.execute(sql`
          INSERT INTO wishes (id, user_id, keyword, category, budget_min_cents, budget_max_cents,
                              description, accept_similar, status, created_at, updated_at)
          VALUES (${row.id}, ${row.user_id}, ${row.keyword}, ${row.category}, ${row.budget_min_cents},
                  ${row.budget_max_cents}, ${row.description}, ${row.accept_similar}, ${row.status},
                  ${row.created_at}, ${row.updated_at})
          RETURNING *
        `),
        )
        if (!created) throw new Error('创建愿望后未返回记录')
        return { kind: 'created', row: created } as const
      })
    },

    async findById(id) {
      return firstWishRow(await db.execute(sql`SELECT * FROM wishes WHERE id = ${id} LIMIT 1`))
    },

    async listByUser(userId, { status, limit, offset }) {
      const where = status
        ? sql`WHERE user_id = ${userId} AND status = ${status}`
        : sql`WHERE user_id = ${userId}`
      const rows = await db.execute(sql`
        SELECT * FROM wishes ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `)
      const totalResult = await db.execute(sql`SELECT count(*)::int AS total FROM wishes ${where}`)
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
        RETURNING *
      `),
      )
    },

    async updateStatusIfActive(id, status, updatedAt) {
      return firstWishRow(
        await db.execute(sql`
        UPDATE wishes SET status = ${status}, updated_at = ${updatedAt}
        WHERE id = ${id} AND status = 'ACTIVE'
        RETURNING *
      `),
      )
    },

    async aggregatePool(minCount, limit) {
      const result = await db.execute(sql`
        SELECT keyword, category, count(*)::int AS want_count,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY budget_max_cents)::float8 AS median_budget_cents
        FROM wishes
        WHERE status = 'ACTIVE'
        GROUP BY keyword, category
        HAVING count(*) >= ${minCount}
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
