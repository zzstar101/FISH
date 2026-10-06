import { sql } from 'drizzle-orm'
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps, timestamptz } from './common'

/** 校园认证状态。#68 后 VERIFIED 只能由「教育邮箱验证码验证成功」事务写入。 */
export const authStatusEnum = pgEnum('auth_status', ['UNVERIFIED', 'VERIFIED'])

export const userRoleEnum = pgEnum('user_role', ['USER', 'ADMIN'])

/**
 * 账号状态（#464 账号注销）。
 *
 * - `ACTIVE`：正常账号。
 * - `DELETION_REQUESTED`：已申请注销，处于 7 天冷静期。写入口全禁（`requireAuth` 单点拦截）、
 *   其他会话已撤销、在架商品已下架；本人仍可读、可登出/重新登录、可撤回。
 * - `DELETED`：冷静期到期、已完成去标识化。凭据全部清空（密码 / 手机 / 校园邮箱 / 学号 /
 *   微信映射），因此无法再登录；公开主页 404。
 *
 * 用三态而不是布尔 `isDeleting`：撤回要把 `DELETION_REQUESTED` 写回 `ACTIVE`，而 `DELETED`
 * 是终态、不可回退——「可撤回的申请」与「已完成的注销」必须可区分，否则一次 UPDATE 就能把
 * 已注销账号复活。`DELETED` 行的 `id` 保留：交易 / 评价 / 留言 / 聊天 / 审计仍按外键指向它。
 */
export const accountStatusEnum = pgEnum('account_status', [
  'ACTIVE',
  'DELETION_REQUESTED',
  'DELETED',
])

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
    /**
     * 个性签名（#179，列由 #287 批量落迁移）。可空 = 未填写或已清空，两者不区分；
     * 长度与空白归一化由服务端把关（#179 尚未冻结上限，此处不落 CHECK）。
     */
    signature: text('signature'),
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
    /**
     * 账号状态（#464）。注销态本身是对外可见的（`GET /me/account-deletion`），
     * 但不进 `Me` DTO（#3 契约保持冻结），由注销模块自己的端点自报。
     */
    accountStatus: accountStatusEnum('account_status').notNull().default('ACTIVE'),
    /** 注销申请时刻（`DELETION_REQUESTED` 时非空）。 */
    deletionRequestedAt: timestamptz('deletion_requested_at'),
    /** 冷静期到期时刻 = 申请时刻 + 7 天（`DELETION_REQUESTED` 时非空）；worker 按它扫描。 */
    purgeScheduledAt: timestamptz('purge_scheduled_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('users_campus_email_uq').on(table.campusEmail),
    // worker 到期扫描（#464）：只扫冷静期内的行，按到期时刻取。没有这条部分索引就是每次全表扫。
    index('users_purge_scheduled_at_idx')
      .on(table.purgeScheduledAt)
      .where(sql`${table.accountStatus} = 'DELETION_REQUESTED'`),
    /*
     * 三态与两个时间戳必须同进同出（#464）：`DELETION_REQUESTED` 必须两个时间戳都非空，
     * 其余状态必须都为空。防的是「半状态」——有状态没时间戳的行 worker 永远扫不到，
     * 注销会静默卡死；有时间戳没状态的行会让撤回后的账号被误执行去标识化。
     */
    check(
      'users_account_deletion_timestamps_consistent',
      sql`(${table.accountStatus} = 'DELETION_REQUESTED') = (${table.deletionRequestedAt} IS NOT NULL AND ${table.purgeScheduledAt} IS NOT NULL)`,
    ),
  ],
)

/**
 * 微信身份映射（#86 A 节）：openid/unionid -> FISH user 的唯一绑定。
 *
 * 刻意独立成表而不塞进 users：映射有自己的生命周期（绑定/解绑），
 * 且不能把外部身份凭据混进账号主表。
 *
 * 当前**一个 user 最多一条微信身份**，由 `wechat_identities_user_uq` 强制（换微信账号 =
 * 换 user，不做合并）；将来若要支持 unionid 合并出的多身份，必须先删掉这个唯一索引。
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
