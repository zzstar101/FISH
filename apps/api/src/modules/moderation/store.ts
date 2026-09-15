import type { Db } from '@fish/db/client'
import { listingModerationRecords } from '@fish/db/schema/moderation'
import { desc, eq } from 'drizzle-orm'

export type ModerationRecord = typeof listingModerationRecords.$inferSelect

export interface ModerationStore {
  listByListing(listingId: string, limit?: number): Promise<ModerationRecord[]>
  getById(id: string): Promise<ModerationRecord | null>
}

export function createSqlModerationStore(db: Db): ModerationStore {
  return {
    async listByListing(listingId, limit = 50) {
      return db
        .select()
        .from(listingModerationRecords)
        .where(eq(listingModerationRecords.listingId, listingId))
        .orderBy(desc(listingModerationRecords.createdAt), desc(listingModerationRecords.id))
        .limit(Math.min(Math.max(limit, 1), 100))
    },

    async getById(id) {
      const rows = await db
        .select()
        .from(listingModerationRecords)
        .where(eq(listingModerationRecords.id, id))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
