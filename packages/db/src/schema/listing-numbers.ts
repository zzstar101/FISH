import { sql } from 'drizzle-orm'
import { bigint, check, pgTable, unique, uuid } from 'drizzle-orm/pg-core'

/** Append-only reservation; deliberately no FK to listings, so physical deletion keeps the number occupied. */
export const listingNumbers = pgTable(
  'listing_numbers',
  {
    listingNo: bigint('listing_no', { mode: 'bigint' }).primaryKey(),
    listingId: uuid('listing_id').notNull().unique(),
  },
  (table) => [
    unique('listing_numbers_no_id_uq').on(table.listingNo, table.listingId),
    check(
      'listing_numbers_twelve_digits',
      sql`${table.listingNo} BETWEEN 100000000000 AND 999999999999`,
    ),
  ],
)
