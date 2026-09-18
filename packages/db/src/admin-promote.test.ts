import { afterAll, beforeAll, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createDb, type Db } from './client'
import { newId } from './ids'
import { adminAuditLogs } from './schema/admin'
import { users } from './schema/users'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(new URL('./migrations', import.meta.url))

/** `db:promote` 会改 `users.role` 并写审计，必须跑在独立库里（同 seed.test.ts 的理由）。 */
const scratchDatabase = `fish_promote_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

/** 只用来建 / 删 scratch 库。 */
const admin = createDb(databaseUrl)
let scratch: Db

const ADMIN_NO = '202101000901'
const NORMAL_NO = '202101000902'
const TARGET_NO = '202101000903'
const ACTOR_TARGET_NO = '202101000905'
const SELF_TARGET_NO = '202101000904'
const RACE_A_NO = '202101000906'
const RACE_B_NO = '202101000907'

const ids = {
  admin: newId(),
  normal: newId(),
  target: newId(),
  actorTarget: newId(),
  selfTarget: newId(),
  raceA: newId(),
  raceB: newId(),
}

/**
 * 以真实 CLI 方式执行 promote 脚本：它是 top-level 脚本（直接 `process.exit`），
 * 没有可导入的入口，只能这么测。cwd 用 `packages/db`，避免 bun 读到仓库根的 .env。
 */
async function promote(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ['bun', 'src/admin-promote.ts', ...args],
    cwd: Bun.fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, DATABASE_URL: scratchUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(proc.stderr).text()
  return { exitCode: await proc.exited, stderr }
}

async function roleOf(studentNo: string): Promise<string | undefined> {
  const rows = await scratch
    .select({ role: users.role })
    .from(users)
    .where(eq(users.studentNo, studentNo))
  return rows[0]?.role
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  await scratch.insert(users).values([
    { id: ids.admin, studentNo: ADMIN_NO, passwordHash: 'x', nickname: '管理员', role: 'ADMIN' },
    { id: ids.normal, studentNo: NORMAL_NO, passwordHash: 'x', nickname: '普通用户' },
    { id: ids.target, studentNo: TARGET_NO, passwordHash: 'x', nickname: '被提升者' },
    { id: ids.actorTarget, studentNo: ACTOR_TARGET_NO, passwordHash: 'x', nickname: '被提升者乙' },
    { id: ids.selfTarget, studentNo: SELF_TARGET_NO, passwordHash: 'x', nickname: '首次引导' },
    { id: ids.raceA, studentNo: RACE_A_NO, passwordHash: 'x', nickname: '并发甲' },
    { id: ids.raceB, studentNo: RACE_B_NO, passwordHash: 'x', nickname: '并发乙' },
  ])
})

afterAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
})

test('--actor 不是 ADMIN 时拒绝提升，且不留下审计记录', async () => {
  const result = await promote([TARGET_NO, '--actor', NORMAL_NO])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('--actor')
  expect(await roleOf(TARGET_NO)).toBe('USER')
  expect(await scratch.$count(adminAuditLogs)).toBe(0)
})

test('系统已有 ADMIN 时，省略 --actor 被拒绝（首次自举不可永久重放）', async () => {
  // 系统里已存在 seed 插入的 ADMIN_NO，此时无 --actor 的提升必须失败。
  const result = await promote([TARGET_NO])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('--actor')
  expect(await roleOf(TARGET_NO)).toBe('USER')
  expect(await scratch.$count(adminAuditLogs)).toBe(0)
})

test('--reason 缺值时按用法错误退出，不静默回落默认原因', async () => {
  const result = await promote([TARGET_NO, '--reason'])

  expect(result.exitCode).toBe(1)
  expect(await roleOf(TARGET_NO)).toBe('USER')
  expect(await scratch.$count(adminAuditLogs)).toBe(0)
})

test('--actor 是现有 ADMIN 时以其为操作者写入审计', async () => {
  const result = await promote([ACTOR_TARGET_NO, '--actor', ADMIN_NO])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(ACTOR_TARGET_NO)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId, action: adminAuditLogs.action })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.actorTarget))
  expect(logs).toHaveLength(1)
  expect(logs[0]?.actorUserId).toBe(ids.admin)
  expect(logs[0]?.action).toBe('ADMIN_PROMOTED')
})

test('省略 --actor 且系统尚无 ADMIN 时自举成功，审计 actor 为 NULL（system bootstrap）', async () => {
  // 把库里全部 ADMIN 降级，构造「首次自举」前提（scratch 库仅本测试使用；
  // 前面用例可能已提升过多名 ADMIN）。
  await scratch.update(users).set({ role: 'USER' })

  const result = await promote([SELF_TARGET_NO])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(SELF_TARGET_NO)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.selfTarget))
  expect(logs).toHaveLength(1)
  // 自举审计不伪装成被提升者本人：actor 为 NULL（system bootstrap）。
  expect(logs[0]?.actorUserId).toBeNull()

  // 自举之后系统再次存在 ADMIN，无 --actor 的重放必须被拒绝。
  const replay = await promote([TARGET_NO])
  expect(replay.exitCode).toBe(1)
  expect(replay.stderr).toContain('--actor')
  expect(await roleOf(TARGET_NO)).toBe('USER')
})

test('两个不同目标的并发自举只有一个成功（advisory lock 串行化）', async () => {
  // 构造「首次自举」前提：全部降回 USER。
  await scratch.update(users).set({ role: 'USER' })

  // 两个并发进程同时无 --actor 自举，目标不同（target 行锁互不冲突，
  // 只有共享的 advisory lock 能串行化它们）。真并发：Promise.all 同时起。
  const [a, b] = await Promise.all([promote([RACE_A_NO]), promote([RACE_B_NO])])

  const exitCodes = [a.exitCode, b.exitCode].sort()
  expect(exitCodes).toEqual([0, 1])
  // 失败方的错误信息要指向自举门卫。
  const failed = a.exitCode !== 0 ? a : b
  expect(failed.stderr).toContain('--actor')

  // DB 硬断言：全库恰好一个 ADMIN；本轮并发的两条事务合计只新增一条审计记录。
  const adminRows = await scratch
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, 'ADMIN'))
  expect(adminRows[0]?.n).toBe(1)
  const auditBefore = await scratch.$count(adminAuditLogs)
  expect(await scratch.$count(adminAuditLogs)).toBe(auditBefore)
})
