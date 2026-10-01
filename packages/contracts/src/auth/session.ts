import { z } from 'zod'
import { MeSchema } from './user'

/**
 * 学号即账号。整个后端只有这一处定义长度与字符集：
 * Mock Provider 的判定规则也从它派生，避免「注册校验」与「认证判定」各写一份而漂移。
 *
 * #86（2026-09-22 产品冻结）后的现状：Miniapp 主身份是微信（`POST /auth/wechat/session`）；
 * 学号注册 / 登录保留为 Web 端 legacy 入口与存量账号的登录方式，#86 E 节再统一迁移。
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
export const PasswordSchema = z.string().min(8, '密码至少 8 个字符').max(32, '密码最多 32 个字符')

export const NicknameSchema = z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 个字符')

/** `.strict()`：多余字段直接 422，而不是静默丢弃。#86 F 节：不再采集校区。 */
export const RegisterRequestSchema = z.strictObject({
  studentNo: StudentNoSchema,
  password: PasswordSchema,
  nickname: NicknameSchema,
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
  /** #86 A：code2Session 换取失败（code 无效 / 过期 / 已用 / 映射损坏）。 */
  'WECHAT_CODE_INVALID',
  /**
   * #86 评审 P1：`WECHAT_TRANSPORT=off` 时微信登录 / 手机号绑定入口关闭。
   * 503——不是客户端错误，也不是服务端故障，是「该能力未开通」的显式状态；
   * 端上据此引导「微信登录暂不可用」，而不是当作登录失败无限重试。
   */
  'WECHAT_DISABLED',
  /** #86 C：phone code 解析失败（stub 下即「不是 11 位手机号」，live 下 40029 / 40163）。422。 */
  'PHONE_CODE_INVALID',
  /**
   * #204：手机号换取的上游故障——凭证失效（已顺手丢弃缓存）/ 超时 / 不可达 / 响应畸形 /
   * 其它 errcode（频控、系统繁忙、接口未授权……）。502。
   *
   * 与 422 `PHONE_CODE_INVALID` 的分工是 #204 的冻结项：**不把平台故障伪装成用户 code 错误**，
   * 否则用户会对着一个必然失败的上游反复重试同一枚 code。取值同时被
   * `@fish/contracts/auth/phone` 的 `PhoneErrorCodeSchema` 收窄（派生自本联合，不另立一份字面量）。
   */
  'PHONE_UPSTREAM_UNAVAILABLE',
  /** #86 C：手机号已被其他账号绑定（唯一索引兜底并发换绑）。409。 */
  'PHONE_ALREADY_BOUND',
])

export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>
