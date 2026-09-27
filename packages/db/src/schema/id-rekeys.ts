import { pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core'

/** Durable lookup for historical UUIDv4 values kept in immutable audit/system-message payloads. */
export const idRekeys = pgTable(
  'id_rekeys',
  {
    resourceTable: text('resource_table').notNull(),
    oldId: uuid('old_id').notNull(),
    newId: uuid('new_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.resourceTable, table.oldId] }),
    unique('id_rekeys_table_new_uq').on(table.resourceTable, table.newId),
  ],
)
