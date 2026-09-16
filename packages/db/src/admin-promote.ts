/**
 * 受控 Admin 初始化脚本（#73 设计 §3.3 方案 1）。
 *
 * 用途：按**显式学号**把一名用户提升为 `ADMIN`，并把提升写入 `admin_audit_logs`
 * （`ADMIN_PROMOTED`，actor 默认取被提升者本人；用 `--actor <学号>` 可指定执行者）。
 *
 * 这不是公开注册接口：必须在生产 / 部署人员手动执行，且不可被任何 HTTP 路由调用。
 * 把一名用户提升为 ADMIN 之后，管理后台（/admin）才对他开放 —— 用户 / 商品查询、
 * 概览、审计日志都要求 role = ADMIN（设计 §3.2）。
 *
 * 用法（仓库根目录）：
 * ```bash
 * bun run db:promote -- 202101000001
 * bun run db:promote -- 202101000001 --actor 202012345678 --reason "运营开通"
 * ```
 *
 * 提升与审计日志在同**一个数据库事务**里完成：任何一步失败整体回滚，不留
 * 「已提升但无记录」或「有记录但没提升」的假状态（设计 §6 末尾同理）。
 *
 * 注意：不打印任何密码 / 密钥；不把 password_hash / 完整 Cookie 写进审计日志
 * （设计 §8 只写脱敏快照，这里 before/after 仅含 role）。
 */
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { newId } from './ids'
import { jsonParam } from './json'
import { adminAuditLogs } from './schema/admin'
import { users } from './schema/users'

function usage(code: number): never {
  console.error(
    [
      '用法：bun run db:promote -- <学号> [--actor <学号>] [--reason <原因>]',
      '  <学号>     被提升为 ADMIN 的学号（必填）',
      '  --actor    执行提升操作的 Admin 学号（缺省或等于被提升者 = 首次引导自举，不做角色校验）',
      '             指定为他人时必须已经是 ADMIN，否则拒绝（避免审计指向无管理权限者）',
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

let actorId: string | null = null
if (actor && actor !== target) {
  const actorUser = await roleByStudentNo(actor)
  if (!actorUser) {
    console.error(`[db:promote] --actor 学号不存在：${actor}`)
    process.exit(1)
  }
  // 审计里的操作者必须真的是管理员，否则可以把提升记到一个从未有过管理权限的账号头上。
  // `actor === target` 的自举路径（首次引导）不需要这条校验。
  if (actorUser.role !== 'ADMIN') {
    console.error(`[db:promote] --actor 必须是现有 ADMIN（首次引导请省略 --actor）：${actor}`)
    process.exit(1)
  }
  actorId = actorUser.id
}

if (targetUser.role === 'ADMIN') {
  console.log(`[db:promote] 已是 ADMIN，无需重复提升：${target}`)
  process.exit(0)
}

await db.transaction(async (tx) => {
  await tx.update(users).set({ role: 'ADMIN' }).where(eq(users.id, targetUser.id))
  await tx.insert(adminAuditLogs).values({
    id: newId(),
    actorUserId: actorId ?? targetUser.id,
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

console.log(`[db:promote] ok — 已将学号 ${target} 提升为 ADMIN（${reason}）`)
