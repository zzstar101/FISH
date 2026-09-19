import { jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, primaryKey } from './common'
import { listingStatusEnum, listings } from './listings'
import { users } from './users'

export const moderationDecisionEnum = pgEnum('moderation_decision', ['ALLOW', 'BLOCK', 'REVIEW'])

export const listingModerationRecords = pgTable('listing_moderation_records', {
  ...primaryKey(),
  listingId: uuid('listing_id').references(() => listings.id, { onDelete: 'set null' }),
  sellerId: uuid('seller_id')
    .notNull()
    .references(() => users.id),
  action: text('action').notNull(),
  titleSnapshot: text('title_snapshot').notNull(),
  descriptionSnapshot: text('description_snapshot').notNull(),
  decision: moderationDecisionEnum('decision').notNull(),
  matchedRules: jsonb('matched_rules').$type<string[]>().notNull(),
  matchedTermsMasked: jsonb('matched_terms_masked').$type<string[]>().notNull(),
  ruleVersion: text('rule_version').notNull(),
  priorListingStatus: listingStatusEnum('prior_listing_status'),
  createdAt: createdAt(),
})
