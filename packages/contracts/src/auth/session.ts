import { z } from 'zod'
import { MeSchema } from './user'

/**
 * 昵称（注册已随 #703 下线，本 schema 仍被资料编辑等入口使用）。
 */
export const NicknameSchema = z.string().trim().min(1, '请填写昵称').max(20, '昵称最多 20 个字符')

/** 登录 / `GET /me` 的统一响应体。 */
export const AuthResponseSchema = z.object({ user: MeSchema })

export type AuthResponse = z.infer<typeof AuthResponseSchema>

/** 认证域错误码。跨 domain 的通用码在 `@fish/contracts/system/error`；商品域另有自己的取值（`ListingErrorCodeSchema`）。 */
export const AuthErrorCodeSchema = z.enum([
  'UNAUTHENTICATED',
  /** #86 A：code2Session 换取失败（code 无效 / 过期 / 已用 / 映射损坏）。 */
  'WECHAT_CODE_INVALID',
  /**
   * #86 评审 P1：`WECHAT_TRANSPORT=off` 时微信登录 / 手机号绑定入口关闭。
   * 503——不是客户端错误，也不是服务端故障，是「该能力未开通」的显式状态；
   * 端上据此引导「微信登录暂不可用」，而不是当作登录失败无限重试。
   */
  'WECHAT_DISABLED',
  /** #86 C：phone code 解析失败（stub 下即「不是 11 位手机号」；live 下是微信判 code 无效 / 过期 / 已用）。422。 */
  'PHONE_CODE_INVALID',
  /**
   * #204：微信换取成功，但返回的号码不是 11 位大陆手机号（本产品只服务大陆号）。
   * 422——用户侧可纠正（换号或走其它绑定方式），与上游故障分开。
   */
  'PHONE_NUMBER_UNSUPPORTED',
  /**
   * #204：手机号换取的上游故障（不可达 / 超时 / 凭证失效重试一次后仍失败 / 响应结构非法）。
   * 502——「稍后再试」；不得伪装成 code 错误，否则用户会对着正确授权反复重试。
   */
  'PHONE_UPSTREAM_FAILED',
  /** #86 C：手机号已被其他账号绑定（唯一索引兜底并发换绑）。409。 */
  'PHONE_ALREADY_BOUND',
  /**
   * #514：已登录但未绑定手机号，不能使用该写入口（权限矩阵见 `auth/phone.ts`）。403。
   * 端上据此弹出绑定引导（小程序）或给出去小程序绑定的路径（PC），而不是当作普通失败。
   */
  'PHONE_REQUIRED',
])

export type AuthErrorCode = z.infer<typeof AuthErrorCodeSchema>
