/**
 * 受控 Admin 初始化脚本（#73）。
 *
 * 用途：按**显式 UID / 手机号 / 用户 ID** 把一名用户提升为 `ADMIN`，并把提升写入
 * `admin_audit_logs`。`#703` 之后学号列已删除，人类可读标识是 10 位 UID。
 *
 * 自举规则（评审 P1 修复）：
 * - 系统**尚无任何 ADMIN** 时才允许省略 `--actor`（首次引导自举），审计 `actor_user_id`
 *   记 `NULL`（system bootstrap，不伪装成任何真实用户）；
 * - 系统已有 ADMIN 后必须显式传 `--actor <UID|手机号|用户 ID>`，且执行者必须是现有
 *   ADMIN，否则拒绝；
 * - 「计数检查 → 行锁 → 条件更新 → 审计写入」全部在同一个事务里完成，并发自举
 *   也只会成功一个（行锁串行化 + `WHERE role = 'USER'` 条件更新）。
 *
 * 这不是公开注册接口：必须在生产 / 部署人员手动执行，且不可被任何 HTTP 路由调用。
 * 把一名用户提升为 ADMIN 之后，管理后台（/admin）才对他开放 —— 用户 / 商品查询、
 * 概览、审计日志都要求 role = ADMIN。
 *
 * 用法（仓库根目录）：
 * ```bash
 * bun run db:promote -- 1234567890            # 仅限系统尚无 ADMIN 时（首次引导自举）
 * bun run db:promote -- 13798764006 --actor 1234567890 --reason "运营开通"
 * bun run db:promote -- 01a19715-23cd-7269-b5c2-f29353dc0ea5 --actor 13700000000
 * ```
 *
 * 提升与审计日志在同**一个数据库事务**里完成：任何一步失败整体回滚，不留
 * 「已提升但无记录」或「有记录但没提升」的假状态。
 *
 * 注意：不打印任何密钥；审计日志只写脱敏快照（这里 before/after 仅含 role）。
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import { createDb, type Db } from './client'
import { newId } from './ids'
import { jsonParam } from './json'
import { adminAuditLogs } from './schema/admin'
import { users } from './schema/users'

/** 事务内可预期的拒绝（并发失败、门卫拦截）：统一走 stderr + exit 1，不当未捕获异常打印。 */
class PromoteError extends Error {}

/** 已是 ADMIN 的幂等成功路径：事务回滚，但命令以 0 退出。 */
class AlreadyAdmin extends Error {}

function usage(code: number): never {
  console.error(
    [
      '用法：bun run db:promote -- <UID|手机号|用户 ID> [--actor <UID|手机号|用户 ID>] [--reason <原因>]',
      '  <标识>     被提升为 ADMIN 的用户：10 位 UID、11 位手机号或用户 UUID（必填）',
      '  --actor    执行提升操作的 Admin 的用户标识；系统已存在 ADMIN 时必填，且必须是现有 ADMIN',
      '             （仅系统尚无任何 ADMIN 时可省略，即首次引导自举）',
      '  --reason   审计原因（缺省：“管理后台初始化”）',
    ].join('\n'),
  )
  process.exit(code)
}

const args = process.argv.slice(2)
const target = args[0]
if (!target || target.startsWith('-')) usage(1)

let actor: string | null = null
let reason = '管理后台初始化'
for (let i = 1; i < args.length; i += 1) {
  if (args[i] === '--actor') {
    const value = args[i + 1]
    if (!value) usage(1)
    actor = value
    i += 1
  } else if (args[i] === '--reason') {
    const value = args[i + 1]
    // 与 `--actor` 同口径：缺值属用法错误。静默回落默认原因会让「忘了写原因」变成
    // 一条看起来正常的审计记录。
    if (!value) usage(1)
    reason = value
    i += 1
  } else {
    usage(1)
  }
}

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error('缺少 DATABASE_URL（在仓库根目录 cp .env.example .env）')
  process.exit(1)
}

const db = createDb(databaseUrl)

interface Identity {
  kind: 'id' | 'phone' | 'uid'
  value: string
  label: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/**
 * 与绑定端实际落库判据保持一致：apps/api/src/modules/auth/router.ts 只校验
 * `/^1\d{10}$/`（11 位、以 1 开头），并不收口到 `1[3-9]`。这里若更严，10/11/12
 * 开头的真实号码会被误判成无法识别。
 */
const PHONE_RE = /^1\d{10}$/
/** 人类可读 UID（#703）：10 位数字、无前导 0，与 11 位手机号不重叠。 */
const UID_RE = /^[1-9]\d{9}$/

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

interface PromoteUser {
  id: string
  role: string
  accountStatus: string
  phone: string | null
  uid: string
}

/**
 * 三种标识形状互不重叠：UUID、11 位手机号、10 位 UID。不做「手机号查不到就回退
 * UID」的猜测——输错一位就换列查只会给出误导性的结果。
 */
function parseIdentity(raw: string): Identity {
  if (UUID_RE.test(raw)) return { kind: 'id', value: raw.toLowerCase(), label: '用户 ID' }
  if (PHONE_RE.test(raw)) return { kind: 'phone', value: raw, label: '手机号' }
  if (UID_RE.test(raw)) return { kind: 'uid', value: raw, label: 'UID' }
  throw new PromoteError(`无法识别的用户标识：${raw}（应为 10 位 UID、11 位手机号或用户 UUID）`)
}

async function userByIdentity(tx: Tx, identity: Identity): Promise<PromoteUser | null> {
  const where =
    identity.kind === 'id'
      ? eq(users.id, identity.value)
      : identity.kind === 'phone'
        ? eq(users.phone, identity.value)
        : eq(users.uid, identity.value)
  const rows = await tx
    .select({
      id: users.id,
      role: users.role,
      accountStatus: users.accountStatus,
      phone: users.phone,
      uid: users.uid,
    })
    .from(users)
    .where(where)
    .limit(1)
  return rows[0] ?? null
}

/** 行锁之后重新核对标识仍指向同一行：防止解析与加锁之间号码被改绑。 */
function matchesIdentity(user: PromoteUser, identity: Identity): boolean {
  if (identity.kind === 'id') return user.id === identity.value
  if (identity.kind === 'phone') return user.phone === identity.value
  return user.uid === identity.value
}

const targetIdentity = parseIdentity(target)
const actorIdentity = actor === null ? null : parseIdentity(actor)

try {
  await db.transaction(async (tx) => {
    // 自举路径的全局串行化：target 行锁只串行化「同一目标」的并发，两个不同目标的
    // 并发自举互不冲突，都会在 READ COMMITTED 下看到 count=0、各自成功提交。固定
    // key 的事务级 advisory lock 把 bootstrap 路径整体串行化，锁内再查 count。
    if (actorIdentity === null) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fish:admin:bootstrap'))`)
    }

    // 解析 target / actor 都放进事务内：若在事务外解析，手机号在解析与提升之间被
    // 改绑，会把旧号主提升（或把审计记到过期 actor 上）。解析后还会在行锁下复查。
    const actorUser = actorIdentity === null ? null : await userByIdentity(tx, actorIdentity)
    if (actorIdentity !== null && actorUser === null) {
      throw new PromoteError(`--actor ${actorIdentity.label}不存在：${actor}`)
    }
    if (actorUser !== null) {
      if (actorUser.role !== 'ADMIN') {
        throw new PromoteError(`--actor 必须是现有 ADMIN：${actor}`)
      }
      if (actorUser.accountStatus !== 'ACTIVE') {
        throw new PromoteError(`--actor 账号状态不是 ACTIVE：${actor}`)
      }
    }

    const targetUser = await userByIdentity(tx, targetIdentity)
    if (targetUser === null) {
      throw new PromoteError(`${targetIdentity.label}不存在：${target}`)
    }
    if (targetUser.role === 'ADMIN') {
      throw new AlreadyAdmin(`已是 ADMIN，无需重复提升：${targetIdentity.label} ${target}`)
    }
    if (targetUser.accountStatus !== 'ACTIVE') {
      throw new PromoteError(
        `目标账号状态为 ${targetUser.accountStatus}，只有 ACTIVE 账号才能提升为 ADMIN`,
      )
    }

    // 行锁串行化同一目标的并发提升；锁内重查角色/状态，并核对标识未被改绑。
    await tx.execute(sql`select id from users where id = ${targetUser.id} for update`)
    const [lockedTarget] = await tx
      .select({
        id: users.id,
        role: users.role,
        accountStatus: users.accountStatus,
        phone: users.phone,
        uid: users.uid,
      })
      .from(users)
      .where(eq(users.id, targetUser.id))
      .limit(1)
    if (lockedTarget === undefined || !matchesIdentity(lockedTarget, targetIdentity)) {
      throw new PromoteError('目标标识在提升前已变更，请重试')
    }
    if (lockedTarget.role !== 'USER') {
      throw new PromoteError('目标用户已被并发提升为 ADMIN')
    }
    if (lockedTarget.accountStatus !== 'ACTIVE') {
      throw new PromoteError(`目标账号状态已变为 ${lockedTarget.accountStatus}，已拒绝提升`)
    }

    // 锁内重查 ADMIN 数量，封死并发窗口（两个并发自举都看到 count=0 的情况）。
    const lockedAdminCount = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(ne(users.role, 'USER'))
    const bootstrap = actorUser === null && (lockedAdminCount[0]?.n ?? 0) === 0
    if (actorUser === null && !bootstrap) {
      throw new PromoteError(
        '系统已存在 ADMIN，拒绝无 actor 提升（首次引导自举仅在系统尚无 ADMIN 时可用）；请传 --actor <现有 Admin 标识>',
      )
    }

    // 条件更新：只有仍是 ACTIVE 的 USER 才提升；并发下另一个事务先提升成功时这里影响 0 行。
    const updated = await tx
      .update(users)
      .set({ role: 'ADMIN' })
      .where(
        and(eq(users.id, targetUser.id), eq(users.role, 'USER'), eq(users.accountStatus, 'ACTIVE')),
      )
      .returning({ id: users.id })
    if (updated.length === 0) {
      throw new PromoteError('目标用户状态已变更，提升失败')
    }

    await tx.insert(adminAuditLogs).values({
      id: newId(),
      // 首次自举没有真实操作者，记 NULL（system bootstrap）；不伪装成被提升者本人。
      actorUserId: actorUser?.id ?? null,
      action: 'ADMIN_PROMOTED',
      targetType: 'USER',
      targetId: targetUser.id,
      // 只写脱敏快照（role），不写任何敏感字段。
      before: jsonParam({ role: lockedTarget.role }),
      after: jsonParam({ role: 'ADMIN' }),
      reason,
      requestId: `admin-init-${Date.now()}`,
    })
  })
} catch (error) {
  if (error instanceof AlreadyAdmin) {
    console.log(`[db:promote] ${error.message}`)
    process.exit(0)
  }
  if (error instanceof PromoteError) {
    console.error(`[db:promote] ${error.message}`)
    process.exit(1)
  }
  throw error
}

console.log(`[db:promote] ok — 已将 ${targetIdentity.label} ${target} 提升为 ADMIN（${reason}）`)
