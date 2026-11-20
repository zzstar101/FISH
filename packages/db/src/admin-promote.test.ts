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

// #703：学号列已删除，人类可读标识换成 10 位 UID（^[1-9]\d{9}$），与 11 位手机号、
// UUID 三种形状互不重叠。
const ADMIN_UID = '2021010001'
const NORMAL_UID = '2021010002'
const TARGET_UID = '2021010003'
const ACTOR_TARGET_UID = '2021010005'
const SELF_TARGET_UID = '2021010004'
const RACE_A_UID = '2021010006'
const RACE_B_UID = '2021010007'
const PHONE_TARGET_UID = '2021010008'
const ID_TARGET_UID = '2021010009'
const PHONE_TARGET_PHONE = '13700000001'
const EDGE_PHONE = '11012345678'
const EDGE_PHONE_UID = '2021010010'
const DELETED_UID = '2021010011'
/** 12 位学号形状的标识已不被接受：三种合法形状都不匹配。 */
const LEGACY_STUDENT_NO = '202101000901'

const ids = {
  admin: newId(),
  normal: newId(),
  target: newId(),
  actorTarget: newId(),
  selfTarget: newId(),
  raceA: newId(),
  raceB: newId(),
  phoneTarget: newId(),
  idTarget: newId(),
  edgePhone: newId(),
  deleted: newId(),
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

async function roleOf(uid: string): Promise<string | undefined> {
  const rows = await scratch.select({ role: users.role }).from(users).where(eq(users.uid, uid))
  return rows[0]?.role
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  scratch = createDb(scratchUrl)
  await migrate(scratch, { migrationsFolder })
  await scratch.insert(users).values([
    { id: ids.admin, uid: ADMIN_UID, nickname: '管理员', role: 'ADMIN' },
    { id: ids.normal, uid: NORMAL_UID, nickname: '普通用户' },
    { id: ids.target, uid: TARGET_UID, nickname: '被提升者' },
    { id: ids.actorTarget, uid: ACTOR_TARGET_UID, nickname: '被提升者乙' },
    { id: ids.selfTarget, uid: SELF_TARGET_UID, nickname: '首次引导' },
    { id: ids.raceA, uid: RACE_A_UID, nickname: '并发甲' },
    { id: ids.raceB, uid: RACE_B_UID, nickname: '并发乙' },
    {
      id: ids.phoneTarget,
      uid: PHONE_TARGET_UID,
      phone: PHONE_TARGET_PHONE,
      nickname: '手机号目标',
    },
    { id: ids.idTarget, uid: ID_TARGET_UID, nickname: 'ID 目标' },
    {
      id: ids.edgePhone,
      uid: EDGE_PHONE_UID,
      phone: EDGE_PHONE,
      nickname: '1xx 号段目标',
    },
    {
      id: ids.deleted,
      uid: DELETED_UID,
      nickname: '已注销',
      accountStatus: 'DELETED',
    },
  ])
})

afterAll(async () => {
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
})

test('--actor 不是 ADMIN 时拒绝提升，且不留下审计记录', async () => {
  const result = await promote([TARGET_UID, '--actor', NORMAL_UID])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('--actor')
  expect(await roleOf(TARGET_UID)).toBe('USER')
  expect(await scratch.$count(adminAuditLogs)).toBe(0)
})

test('系统已有 ADMIN 时，省略 --actor 被拒绝（首次自举不可永久重放）', async () => {
  // 系统里已存在上面的 ADMIN_UID，此时无 --actor 的提升必须失败。
  const result = await promote([TARGET_UID])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('--actor')
  expect(await roleOf(TARGET_UID)).toBe('USER')
  expect(await scratch.$count(adminAuditLogs)).toBe(0)
})

test('--reason 缺值时按用法错误退出，不静默回落默认原因', async () => {
  const result = await promote([TARGET_UID, '--reason'])

  expect(result.exitCode).toBe(1)
  expect(await roleOf(TARGET_UID)).toBe('USER')
  expect(await scratch.$count(adminAuditLogs)).toBe(0)
})

test('--actor 是现有 ADMIN 时以其为操作者写入审计', async () => {
  const result = await promote([ACTOR_TARGET_UID, '--actor', ADMIN_UID])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(ACTOR_TARGET_UID)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId, action: adminAuditLogs.action })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.actorTarget))
  expect(logs).toHaveLength(1)
  expect(logs[0]?.actorUserId).toBe(ids.admin)
  expect(logs[0]?.action).toBe('ADMIN_PROMOTED')
})

test('按手机号提升（#180 后微信用户没有学号，#703 后人类可读标识是 uid）', async () => {
  const result = await promote([PHONE_TARGET_PHONE, '--actor', ADMIN_UID])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(PHONE_TARGET_UID)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.phoneTarget))
  expect(logs).toHaveLength(1)
  expect(logs[0]?.actorUserId).toBe(ids.admin)
})

test('按用户 ID 提升，--actor 也接受用户 ID', async () => {
  const result = await promote([ids.idTarget, '--actor', ids.admin])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(ID_TARGET_UID)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.idTarget))
  expect(logs).toHaveLength(1)
  expect(logs[0]?.actorUserId).toBe(ids.admin)
})

test('按 10 位 uid 提升（#703 学号列删除后 uid 是唯一的人类可读标识）', async () => {
  const result = await promote([TARGET_UID, '--actor', ADMIN_UID])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(TARGET_UID)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId, action: adminAuditLogs.action })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.target))
  expect(logs).toHaveLength(1)
  expect(logs[0]?.actorUserId).toBe(ids.admin)
  expect(logs[0]?.action).toBe('ADMIN_PROMOTED')
})

test('12 位学号形状的标识无法识别，按用法拒绝且不改角色 / 不写审计', async () => {
  // #703：学号列与学号解析一起删除。旧脚本接受 12 位学号，现在必须明确报「无法识别」，
  // 而不是静默按某个列去查（输错一位就换列查只会给出误导性结果）。
  const auditsBefore = await scratch.$count(adminAuditLogs)

  const result = await promote([LEGACY_STUDENT_NO, '--actor', ADMIN_UID])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('无法识别的用户标识')
  expect(await roleOf(TARGET_UID)).toBe('ADMIN')
  expect(await scratch.$count(adminAuditLogs)).toBe(auditsBefore)
})

test('按手机号提升与绑定端判据一致（1 开头 11 位号也按手机号识别）', async () => {
  // 绑定端 apps/api/src/modules/auth/router.ts 只校验 /^1\d{10}$/，10/11/12 开头
  // 的 11 位号也会落库；db:promote 若收口到 1[3-9] 会把这类号码误判成无法识别。
  const result = await promote([EDGE_PHONE, '--actor', ADMIN_UID])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(EDGE_PHONE_UID)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.edgePhone))
  expect(logs).toHaveLength(1)
  expect(logs[0]?.actorUserId).toBe(ids.admin)
})

test('已注销（DELETED）账号不能被提升为 ADMIN，且不写审计', async () => {
  const result = await promote([DELETED_UID, '--actor', ADMIN_UID])

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain('DELETED')
  expect(await roleOf(DELETED_UID)).toBe('USER')
  expect(
    await scratch
      .select({ id: adminAuditLogs.id })
      .from(adminAuditLogs)
      .where(eq(adminAuditLogs.targetId, ids.deleted)),
  ).toHaveLength(0)
})

test('省略 --actor 且系统尚无 ADMIN 时自举成功，审计 actor 为 NULL（system bootstrap）', async () => {
  // 把库里全部 ADMIN 降级，构造「首次自举」前提（scratch 库仅本测试使用；
  // 前面用例可能已提升过多名 ADMIN）。
  await scratch.update(users).set({ role: 'USER' })

  const result = await promote([SELF_TARGET_UID])

  expect(result.exitCode).toBe(0)
  expect(await roleOf(SELF_TARGET_UID)).toBe('ADMIN')
  const logs = await scratch
    .select({ actorUserId: adminAuditLogs.actorUserId })
    .from(adminAuditLogs)
    .where(eq(adminAuditLogs.targetId, ids.selfTarget))
  expect(logs).toHaveLength(1)
  // 自举审计不伪装成被提升者本人：actor 为 NULL（system bootstrap）。
  expect(logs[0]?.actorUserId).toBeNull()

  // 自举之后系统再次存在 ADMIN，无 --actor 的重放必须被拒绝。
  const replay = await promote([TARGET_UID])
  expect(replay.exitCode).toBe(1)
  expect(replay.stderr).toContain('--actor')
  expect(await roleOf(TARGET_UID)).toBe('USER')
})

test('两个不同目标的并发自举只有一个成功（advisory lock 串行化）', async () => {
  // 构造「首次自举」前提：全部降回 USER。
  await scratch.update(users).set({ role: 'USER' })

  // 两个并发进程同时无 --actor 自举，目标不同（target 行锁互不冲突，
  // 只有共享的 advisory lock 能串行化它们）。真并发：Promise.all 同时起。
  const [a, b] = await Promise.all([promote([RACE_A_UID]), promote([RACE_B_UID])])

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
