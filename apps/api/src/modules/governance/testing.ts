import type { RestrictionGuard } from './guard'

/** Only for isolated router tests; app.ts always injects the DB-backed restriction guard. */
const allow: RestrictionGuard['write'] = async (_context, next) => {
  await next()
}

export const allowRestrictionGuard: RestrictionGuard = { publish: allow, write: allow }
