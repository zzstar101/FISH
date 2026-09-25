import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { primaryKey } from './common'

/** Rolling 60s exact-number lookup budget. Anonymous identities are keyed HMACs, never raw IPs. */
export const listingLookupAttempts = pgTable(
  'listing_lookup_attempts',
  {
    ...primaryKey(),
    subjectType: text('subject_type').notNull(),
    subjectKey: text('subject_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('listing_lookup_attempts_subject_time_idx').on(
      table.subjectType,
      table.subjectKey,
      table.createdAt,
    ),
    index('listing_lookup_attempts_created_at_idx').on(table.createdAt),
  ],
)
