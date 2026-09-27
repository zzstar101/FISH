import { sql } from 'drizzle-orm'

// User-scoped transaction lock shared by the write guard and admin restriction actions.
// Unlike a row lock it does not conflict with the protected write's FK checks or profile UPDATE
// on another DB connection. The first key namespaces it from other advisory locks in the app.
const key = (userId: string) => sql`hashtext('fish:user-restriction'), hashtext(${userId})`

export const lockUserWrites = (userId: string) => sql`
  SELECT pg_advisory_xact_lock(${key(userId)})
`

export const tryLockUserWrites = (userId: string) => sql`
  SELECT pg_try_advisory_xact_lock(${key(userId)}) AS locked
`
