import { isPublicId, PUBLIC_ID_PREFIX, type PublicIdPrefix } from '@fish/shared/public-id'
import { z } from 'zod'

/** Each resource has its own schema/type; no cross-resource ID can pass validation. */
export function publicIdSchema<P extends PublicIdPrefix>(prefix: P) {
  return z.custom<`${P}_${string}`>((value) => isPublicId(prefix, value), {
    error: `需要规范的 ${prefix}_ Public ID`,
  })
}

export const UserIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.user)
export const ListingIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.listing)
export const WishIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.wish)
export const MatchIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.match)
export const ConversationIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.conversation)
export const MessageIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.message)
export const TransactionIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.transaction)
export const CommentIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.comment)
export const NotificationIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.notification)
export const ReportIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.report)
export const MediaIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.media)
export const ModerationRecordIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.moderationRecord)
export const AuditLogIdSchema = publicIdSchema(PUBLIC_ID_PREFIX.auditLog)

export type UserId = z.infer<typeof UserIdSchema>
export type ListingId = z.infer<typeof ListingIdSchema>
export type WishId = z.infer<typeof WishIdSchema>
export type MatchId = z.infer<typeof MatchIdSchema>
export type ConversationId = z.infer<typeof ConversationIdSchema>
export type MessageId = z.infer<typeof MessageIdSchema>
export type TransactionId = z.infer<typeof TransactionIdSchema>
export type CommentId = z.infer<typeof CommentIdSchema>
export type NotificationId = z.infer<typeof NotificationIdSchema>
export type ReportId = z.infer<typeof ReportIdSchema>
export type MediaId = z.infer<typeof MediaIdSchema>
export type ModerationRecordId = z.infer<typeof ModerationRecordIdSchema>
export type AuditLogId = z.infer<typeof AuditLogIdSchema>
