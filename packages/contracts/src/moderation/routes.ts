/** Moderation routes consumed by the Admin console. API paths are root-level. */
export const MODERATION_ROUTES = {
  queue: '/admin/moderation/queue',
  detail: (recordId: string) => `/admin/moderation/${recordId}`,
  decision: (recordId: string) => `/admin/moderation/${recordId}/decision`,
} as const
