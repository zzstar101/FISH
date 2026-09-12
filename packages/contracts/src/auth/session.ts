import { z } from 'zod'
import { CampusSchema, MeSchema } from './user'

/**
 * 学号即账号。整个后端只有这一处定义长度与字符集：
 * Mock Provider 的判定规则也从它派生，避免「注册校验」与「认证判定」各写一份而漂移。
 */
export const StudentNoSchema = z
  .string()
  .trim()
  .regex(/^\d{12}$/, '学号必须是 12 位数字')

/**
 * 不 trim：空格是合法密码字符。
 * 8–32 位是**契约里的产品规则**（#3 约定），不是哈希算法的限制：argon2id 没有 bcrypt 那样的
 * 72 字节输入截断问题，因此不要把它当成「为将来换算法留余量」。
 */
export const PasswordSchema = z.string().min(8).max(32)

export const NicknameSchema = z.string().trim().min(1).max(20)

/** `.strict()`：多余字段直接 422，而不是静默丢弃。 */
export const RegisterRequestSchema = z.strictObject({
  studentNo: StudentNoSchema,
  password: PasswordSchema,
  nickname: NicknameSchema,
  campus: CampusSchema,
})

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>

export const LoginRequestSchema = z.strictObject({
  studentNo: StudentNoSchema,
  password: PasswordSchema,
})

export type LoginRequest = z.infer<typeof LoginRequestSchema>

/** 登录 / 注册 / `GET /me` 的统一响应体。 */
export const AuthResponseSchema = z.object({ user: MeSchema })

export type AuthResponse = z.infer<typeof AuthResponseSchema>

/** 认证域错误码。跨 domain 的通用码在 `@fish/contracts/system/error`；商品域另有自己的取值（`ListingErrorCodeSchema`）。 */
export const AuthErrorCodeSchema = z.enum([
  'INVALID_CREDENTIALS',
  'STUDENT_NO_TAKEN',
  'UNAUTHENTICATED',
])

export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>
