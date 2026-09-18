/**
 * 受控 Admin 初始化脚本（#73 设计 §3.3 方案 1）。
 *
 * 用途：按**显式学号**把一名用户提升为 `ADMIN`，并把提升写入 `admin_audit_logs`。
 *
 * 自举规则（评审 P1 修复）：
 * - 系统**尚无任何 ADMIN** 时才允许省略 `--actor`（首次引导自举），审计 `actor_user_id`
 *   记 `NULL`（system bootstrap，不伪装成任何真实用户）；
 * - 系统已有 ADMIN 后必须显式传 `--actor <学号>`，且执行者必须是现有 ADMIN，否则拒绝；
 * - 「计数检查 → 行锁 → 条件更新 → 审计写入」全部在同一个事务里完成，并发自举
 *   也只会成功一个（行锁串行化 + `WHERE role = 'USER'` 条件更新）。
 *
 * 这不是公开注册接口：必须在生产 / 部署人员手动执行，且不可被任何 HTTP 路由调用。
 * 把一名用户提升为 ADMIN 之后，管理后台（/admin）才对他开放 —— 用户 / 商品查询、
 * 概览、审计日志都要求 role = ADMIN（设计 §3.2）。
 *
 * 用法（仓库根目录）：
 * ```bash
 * bun run db:promote -- 202101000001          # 仅限系统尚无 ADMIN 时（首次引导自举）
 * bun run db:promote -- 202101000001 --actor 202012345678 --reason "运营开通"
 * ```
 *
 * 提升与审计日志在同**一个数据库事务**里完成：任何一步失败整体回滚，不留
 * 「已提升但无记录」或「有记录但没提升」的假状态（设计 §6 末尾同理）。
 *
 * 注意：不打印任何密码 / 密钥；不把 password_hash / 完整 Cookie 写进审计日志
 * （设计 §8 只写脱敏快照，这里 before/after 仅含 role）。
 */
import { and, eq, ne, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { newId } from './ids'
import { jsonParam } from './json'
import { adminAuditLogs } from './schema/admin'
import { users } from './schema/users'

/** 事务内可预期的拒绝（并发失败、门卫拦截）：统一走 stderr + exit 1，不当未捕获异常打印。 */
class PromoteError extends Error {}

function usage(code: number): never {
  console.error(
    [
      '用法：bun run db:promote -- <学号> [--actor <学号>] [--reason <原因>]',
      '  <学号>     被提升为 ADMIN 的学号（必填）',
      '  --actor    执行提升操作的 Admin 学号；系统已存在 ADMIN 时必填，且必须是现有 ADMIN',
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

const db = drizzle(databaseUrl)

async function roleByStudentNo(studentNo: string): Promise<{ id: string; role: string } | null> {
  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.studentNo, studentNo))
    .limit(1)
  return rows[0] ?? null
}

const targetUser = await roleByStudentNo(target)
if (!targetUser) {
  console.error(`[db:promote] 学号不存在：${target}`)
  process.exit(1)
}

if (targetUser.role === 'ADMIN') {
  console.log(`[db:promote] 已是 ADMIN，无需重复提升：${target}`)
  process.exit(0)
}

// 自举门卫（评审 P1-2）：系统已存在 ADMIN 时，省略 --actor 不再是合法路径，
// 否则「首次引导」就变成永久可用的旁路。事务内还会以行锁 + 计数重查兑底并发。
const adminCount = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(users)
  .where(eq(users.role, 'ADMIN'))
const hasExistingAdmin = (adminCount[0]?.n ?? 0) > 0

let actorId: string | null = null
if (actor) {
  const actorUser = await roleByStudentNo(actor)
  if (!actorUser) {
    console.error(`[db:promote] --actor 学号不存在：${actor}`)
    process.exit(1)
  }
  if (actorUser.role !== 'ADMIN') {
    console.error(
      hasExistingAdmin
        ? `[db:promote] --actor 必须是现有 ADMIN：${actor}`
        : `[db:promote] 系统尚无 ADMIN，首次引导自举请省略 --actor；非自举提升的 --actor 必须是现有 ADMIN：${actor}`,
    )
    process.exit(1)
  }
  actorId = actorUser.id
} else if (hasExistingAdmin) {
  console.error(
    `[db:promote] 系统已存在 ADMIN，拒绝无 actor 提升（首次引导自举仅在系统尚无 ADMIN 时可用）；请传 --actor <现有 Admin 学号>`,
  )
  process.exit(1)
}

try {
  await db.transaction(async (tx) => {
    // 首次自举的并发串行化（评审二轮 blocker）：target 行锁只能串行化「同一目标」的
    // 并发，两个不同目标的并发自举互不冲突，都会在 READ COMMITTED 下看到 count=0、
    // 各自成功提交 —— 变成两个首号 ADMIN。自举路径改用**事务级 advisory lock**
    //（全系统共享的固定 key）把所有 bootstrap 事务全局串行化，锁内重查 count 后
    // 才允许继续；一旦已有 ADMIN，后来者在锁内直接被拒绝。
    if (actorId === null) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('fish:admin:bootstrap'))`)
    }

    // 行锁串行化同一目标的并发提升；配合下面的条件 UPDATE 防重复 ADMIN_PROMOTED。
    await tx.execute(sql`select id from users where id = ${targetUser.id} for update`)

    // 锁内重查 ADMIN 数量，封死并发窗口（两个并发自举都看到 count=0 的情况）。
    const lockedAdminCount = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(ne(users.role, 'USER'))
    const bootstrap = actorId === null && (lockedAdminCount[0]?.n ?? 0) === 0
    if (actorId === null && !bootstrap) {
      throw new PromoteError(
        '系统已存在 ADMIN，拒绝无 actor 提升（首次引导自举仅在系统尚无 ADMIN 时可用）；请传 --actor <现有 Admin 学号>',
      )
    }

    // 条件更新：只有仍然是 USER 才提升；并发下另一个事务先提升成功时这里影响 0 行。
    const updated = await tx
      .update(users)
      .set({ role: 'ADMIN' })
      .where(and(eq(users.id, targetUser.id), eq(users.role, 'USER')))
      .returning({ id: users.id })
    if (updated.length === 0) {
      throw new PromoteError('目标用户已被并发提升为 ADMIN')
    }

    await tx.insert(adminAuditLogs).values({
      id: newId(),
      // 首次自举没有真实操作者，记 NULL（system bootstrap）；不伪装成被提升者本人。
      actorUserId: actorId,
      action: 'ADMIN_PROMOTED',
      targetType: 'USER',
      targetId: targetUser.id,
      // 只写脱敏快照（role），不写任何敏感字段（设计 §8）。
      before: jsonParam({ role: targetUser.role }),
      after: jsonParam({ role: 'ADMIN' }),
      reason,
      requestId: `admin-init-${Date.now()}`,
    })
  })
} catch (error) {
  // 并发自举 / 并发提升的预期失败：一条简短拒绝信息，不留半截状态（事务已回滚）。
  if (error instanceof PromoteError) {
    console.error(`[db:promote] ${error.message}`)
    process.exit(1)
  }
  throw error
}

console.log(`[db:promote] ok — 已将学号 ${target} 提升为 ADMIN（${reason}）`)
