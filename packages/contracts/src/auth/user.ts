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
 * 对外可见的用户资料：`GET /me` 与登录 / 注册响应共用同一份，
 * 前端登录后无需再打 `/me`。
 *
 * 刻意不含 `studentNo`、真实姓名、班级——#3 验收要求不公开完整学号等敏感字段；
 * 表里的 `student_no` / `password_hash` 永远不进入这个类型。
 *
 * #86（2026-09-22 产品冻结）：
 * - `campus` 已整体移除——产品不采集、不公开校区，无可见性开关（#86 F 节）；
 * - 手机号只出派生态 `phoneBound` / `maskedPhone`，明文只存服务端（#86 C 节）。
 */
export const MeSchema = z.object({
  id: UserIdSchema,
  nickname: z.string(),
  avatarUrl: z.url().nullable(),
  authStatus: AuthStatusSchema,
  verifiedAt: z.iso.datetime().nullable(),
  /** 是否已绑定手机号。绑定状态本身不敏感，可展示；明文手机号不出服务端。 */
  phoneBound: z.boolean(),
  /** 脱敏手机号（`138****8000`）；未绑定为 `null`。 */
  maskedPhone: z.string().nullable(),
})

export type Me = z.infer<typeof MeSchema>
