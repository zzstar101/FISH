import { sql } from 'drizzle-orm'
import type { Db } from './client'
import { newListingNo } from './listing-no'

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  return []
}

/** Idempotent, transaction-per-row pre-constraint backfill. The API/worker must be stopped. */
export async function backfillIds(db: Db): Promise<void> {
  while (true) {
    const found = await db.transaction(async (tx) => {
      const row = rowsOf(
        await tx.execute(
          sql`SELECT id FROM listings WHERE listing_no IS NULL ORDER BY id LIMIT 1 FOR UPDATE`,
        ),
      )[0]
      if (!row) return false
      const listingId = String(row.id)
      const prior = rowsOf(
        await tx.execute(
          sql`SELECT listing_no FROM listing_numbers WHERE listing_id = ${listingId}::uuid`,
        ),
      )[0]
      let listingNo = prior?.listing_no === undefined ? undefined : BigInt(String(prior.listing_no))
      for (let attempt = 0; listingNo === undefined && attempt < 32; attempt++) {
        const candidate = newListingNo()
        const claimed = rowsOf(
          await tx.execute(sql`
            INSERT INTO listing_numbers (listing_no, listing_id)
            VALUES (${candidate}, ${listingId}::uuid)
            ON CONFLICT (listing_no) DO NOTHING RETURNING listing_no
          `),
        )[0]
        if (claimed) listingNo = candidate
      }
      if (listingNo === undefined) throw new Error(`无法为商品 ${listingId} 补唯一编号`)
      await tx.execute(
        sql`UPDATE listings SET listing_no = ${listingNo} WHERE id = ${listingId}::uuid`,
      )
      return true
    })
    if (!found) break
  }

  // UUIDv4 rows (including wishes) are rekeyed after the generated id_rekeys table exists.
}
