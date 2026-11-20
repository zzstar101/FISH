import { z } from 'zod'

/**
 * #694 M8 存量图片补审 job 的 payload 契约。
 *
 * 一次只审一个对象键：批大小由 scheduler 控制，单个对象失败/重试不会拖住整批；
 * 对象字节、归属和可见性都在 handler 运行时现查，payload 不保存审核结论。
 */
export const LEGACY_MEDIA_AUDIT_JOB_TYPE = 'LEGACY_MEDIA_AUDIT'

export const LegacyMediaAuditJobPayloadSchema = z.strictObject({
  objectKey: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/),
})

export type LegacyMediaAuditJobPayload = z.infer<typeof LegacyMediaAuditJobPayloadSchema>
