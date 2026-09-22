import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { primaryKey, timestamps } from './common'

/** 校园认证状态。#68 后 VERIFIED 只能由「教育邮箱验证码验证成功」事务写入。 */
export const authStatusEnum = pgEnum('auth_status', ['UNVERIFIED', 'VERIFIED'])

export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN'])

export const users = pgTable(
  'users',
  {
    ...primaryKey(),
    /**
     * 学号即账号（#3）。#86（2026-09-22 产品冻结）后微信是 Miniapp 主身份：微信注册的
     * 用户没有学号（NULL）。学号登录仍保留到 E 期（#86 E 节）迁移完成，此后列退出登录键。
     * API 不返回该列（`studentNoMasked` 等管理投影除外，见 admin 契约）。
     */
    studentNo: text('student_no').unique(),
    /**
     * 密码哈希（#3：argon2id，见 `seed.ts`）。微信注册用户没有密码（NULL），
     * 学号登录必须校验非空后再比（NULL 哈希意味着该账号不能走密码登录）。
     */
    passwordHash: text('password_hash'),
    nickname: text('nickname').notNull(),
    avatarUrl: text('avatar_url'),
    authStatus: authStatusEnum('auth_status').notNull().default('UNVERIFIED'),
    verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
    /**
     * 校园认证的唯一绑定（#68）。NULL = 从未完成过校园邮箱验证；非 NULL 只能由
     * 验证成功事务写入（见 auth 模块 verification-store.ts），注册不改它，
     * #68 后新注册一律 UNVERIFIED。唯一索引保证一个校园邮箱至多绑一个账号。
     */
    campusEmail: text('campus_email'),
    /**
     * 已验证手机号（#86 C 节）。只由「getPhoneNumber code 换取手机号」流程写入；
     * 服务端保存，任何 DTO 只出 `phoneBound` / `maskedPhone` 派生态，不出明文。
     */
    phone: text('phone').unique(),
    /** 管理授权依据（#73）；只由 `requireAdmin` 读取，普通用户 `Me` DTO 不暴露它。 */
    role: userRoleEnum('role').notNull().default('USER'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('users_campus_email_uq').on(table.campusEmail)],
)

/**
 * 微信身份映射（#86 A 节）：openid/unionid -> FISH user 的唯一绑定。
 *
 * 刻意独立成表而不塞进 users：一个 user 理论上可有多条微信身份（unionid 合并）、
 * 映射有自己的生命周期（绑定/解绑），且不能把外部身份凭据混进账号主表。
 * `openid` 全局唯一索引 = 「同一 appid + openid 唯一映射」的并发防线（#86 A）。
 */
export const wechatIdentities = pgTable(
  'wechat_identities',
  {
    ...primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 微信 openid；stub 模式下由服务端从 code 确定性派生，形状与真实值一致（`o` 开头 28 位）。 */
    openid: text('openid').notNull(),
    /** 微信 unionid；主体未绑定开放平台时为 NULL。 */
    unionid: text('unionid'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('wechat_identities_openid_uq').on(table.openid),
    uniqueIndex('wechat_identities_user_uq').on(table.userId),
  ],
)
