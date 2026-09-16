import { z } from 'zod'

/**
 * 校园认证状态。值域与 `users.auth_status`（#2 冻结）一致，这里只是对外镜像，
 * 因此**没有第三个「审核中」态**。#68 后 VERIFIED 只能由校园邮箱验证产生
 * （见 `auth/verification.ts`），注册不再给出结论。
 */
export const AuthStatusSchema = z.enum(['UNVERIFIED', 'VERIFIED'])

export type AuthStatus = z.infer<typeof AuthStatusSchema>

/** 校区值域，与 seed 中已有的 `'肇庆'` / `'广州'` 一致。 */
export const CampusSchema = z.enum(['肇庆', '广州'])

export type Campus = z.infer<typeof CampusSchema>

/**
 * 对外可见的用户资料：`GET /me` 与登录 / 注册响应共用同一份，
 * 前端登录后无需再打 `/me`。
 *
 * 刻意不含 `studentNo`、真实姓名、班级——#3 验收要求不公开完整学号等敏感字段；
 * 表里的 `student_no` / `password_hash` 永远不进入这个类型。
 */
export const MeSchema = z.object({
  id: z.uuid(),
  nickname: z.string(),
  avatarUrl: z.url().nullable(),
  campus: CampusSchema.nullable(),
  authStatus: AuthStatusSchema,
  verifiedAt: z.iso.datetime().nullable(),
})

export type Me = z.infer<typeof MeSchema>
