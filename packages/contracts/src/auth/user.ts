import { z } from 'zod'
import { UserIdSchema } from '../system/public-id'

/**
 * 校园认证状态。值域与 `users.auth_status`（#2 冻结）一致，这里只是对外镜像，
 * 因此**没有第三个「审核中」态**。#68 后 VERIFIED 只能由校园邮箱验证产生
 * （见 `auth/verification.ts`），注册不再给出结论。
 */
export const AuthStatusSchema = z.enum(['UNVERIFIED', 'VERIFIED'])

export type AuthStatus = z.infer<typeof AuthStatusSchema>

/**
 * 对外人类可读标识（#703）：10 位数字字符串，值域 `1000000000`–`9999999999`。
 *
 * 与 `UserIdSchema`（`usr_...` TypeID）共存：`usr_` 是协议 ID，本字段只做展示与后台
 * 精确定位，端上不提供按它搜人。
 */
export const UidSchema = z.string().regex(/^[1-9]\d{9}$/, 'UID 必须是首位非 0 的 10 位数字')

export type Uid = z.infer<typeof UidSchema>

/**
 * 对外可见的用户资料：`GET /me` 与登录响应共用同一份，
 * 前端登录后无需再打 `/me`。
 *
 * 刻意不含真实姓名、班级等敏感字段；学号 / 密码凭据列已随 #703 删除，不再存在。
 *
 * #86（2026-09-22 产品冻结）：
 * - `campus` 已整体移除——产品不采集、不公开校区，无可见性开关（#86 F 节）；
 * - 手机号只出派生态 `phoneBound` / `maskedPhone`，明文只存服务端（#86 C 节）。
 */
export const MeSchema = z.object({
  id: UserIdSchema,
  /** 人类可读 UID（10 位数字字符串），展示为「UID 1234567890」。 */
  uid: UidSchema,
  nickname: z.string(),
  avatarUrl: z.url().nullable(),
  authStatus: AuthStatusSchema,
  verifiedAt: z.iso.datetime().nullable(),
  /** 是否已绑定手机号。绑定状态本身不敏感，可展示；明文手机号不出服务端。 */
  phoneBound: z.boolean(),
  /** 脱敏手机号（`138****8000`）；未绑定为 `null`。 */
  maskedPhone: z.string().nullable(),
  /**
   * 个性签名（#179）：本人可见的自我介绍原文，`null` = 未填写或已清空。
   * 服务端已 trim 归一化（空串不落库）；允许多行，展示层是否只取首行由客户端定
   * （miniapp 的 `signatureFirstLine`）。修改走 `PATCH /profile` 的 `signature` 字段。
   */
  signature: z.string().nullable(),
})

export type Me = z.infer<typeof MeSchema>
