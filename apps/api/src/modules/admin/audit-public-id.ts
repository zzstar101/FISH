import type { AdminAuditTargetType } from '@fish/contracts/admin/schema'
import {
  decodePublicId,
  encodePublicId,
  isPublicId,
  PUBLIC_ID_PREFIX,
  type PublicIdPrefix,
} from '@fish/shared/public-id'

const targets = {
  USER: { prefix: PUBLIC_ID_PREFIX.user, table: 'users' },
  LISTING: { prefix: PUBLIC_ID_PREFIX.listing, table: 'listings' },
  MODERATION_RECORD: {
    prefix: PUBLIC_ID_PREFIX.moderationRecord,
    table: 'listing_moderation_records',
  },
  REPORT: { prefix: PUBLIC_ID_PREFIX.report, table: 'reports' },
  USER_RESTRICTION: { prefix: PUBLIC_ID_PREFIX.userRestriction, table: 'user_restrictions' },
} as const satisfies Record<AdminAuditTargetType, { prefix: PublicIdPrefix; table: string }>

export function auditTargetInfo(type: AdminAuditTargetType) {
  return targets[type]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Never emit a raw or unprovable historical resource ID from an audit response. */
export async function projectAuditId(
  prefix: PublicIdPrefix,
  table: string,
  value: unknown,
  resolveLegacy: (table: string, oldId: string) => Promise<string | null>,
): Promise<string | null> {
  if (isPublicId(prefix, value)) return value
  if (typeof value !== 'string' || !UUID.test(value)) return null
  try {
    return encodePublicId(prefix, value)
  } catch {
    const replacement = await resolveLegacy(table, value)
    if (!replacement) return null
    try {
      return encodePublicId(prefix, replacement)
    } catch {
      return null
    }
  }
}

export function decodeAuditFilter(
  type: AdminAuditTargetType | undefined,
  value: string,
): { id: string; table: string } | null {
  const possible = type ? [targets[type]] : Object.values(targets)
  for (const { prefix, table } of possible) {
    if (isPublicId(prefix, value)) return { id: decodePublicId(prefix, value), table }
  }
  return null
}

/** Database JSON stays verbatim; only known nested references are projected at read time. */
export async function projectAuditSnapshot(
  value: unknown,
  resolveLegacy: (table: string, oldId: string) => Promise<string | null>,
): Promise<unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const result = { ...value } as Record<string, unknown>
  for (const [key, prefix, table] of [
    ['sourceReportId', PUBLIC_ID_PREFIX.report, 'reports'],
    ['manualRecordId', PUBLIC_ID_PREFIX.moderationRecord, 'listing_moderation_records'],
    ['reporterId', PUBLIC_ID_PREFIX.user, 'users'],
  ] as const) {
    if (key in result && result[key] !== null) {
      const publicId = await projectAuditId(prefix, table, result[key], resolveLegacy)
      if (publicId) result[key] = publicId
      else delete result[key]
    }
  }
  if ('targetId' in result && result.targetId !== null) {
    const targetType = result.targetType
    const target =
      typeof targetType === 'string' && Object.hasOwn(targets, targetType)
        ? targets[targetType as AdminAuditTargetType]
        : null
    const publicId = target
      ? await projectAuditId(target.prefix, target.table, result.targetId, resolveLegacy)
      : null
    if (publicId) result.targetId = publicId
    else delete result.targetId
  }
  return result
}
