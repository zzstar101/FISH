import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { userBlocks } from '@fish/db/schema/blocks'
import { users } from '@fish/db/schema/users'
import { eq, inArray, sql } from 'drizzle-orm'
import { createSqlBlockStore } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlBlockStore(db)

const created: string[] = []
let seq = 0

/** 每个用例自建、自清自己的用户（删用户靠 CASCADE 带走 user_blocks，与 store 的删除语义一致）。 */
async function newUser(nickname = '拉黑测试'): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ studentNo: `block-${Date.now()}-${seq++}`, passwordHash: 'test-hash', nickname })
    .returning({ id: users.id })
  const id = rows[0]?.id
  if (!id) throw new Error('insert users 未返回行')
  created.push(id)
  return id
}

afterAll(async () => {
  if (created.length > 0) await db.delete(users).where(inArray(users.id, created))
  await db.$client.close()
})

describe('block store (integration)', () => {
  test('block 幂等：重复拉黑只有一行，且不改写首次 created_at', async () => {
    const me = await newUser()
    const target = await newUser()

    await store.block(me, target)
    const [first] = await db
      .select({ createdAt: userBlocks.createdAt })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, me))
    await store.block(me, target)
    const rows = await db
      .select({ createdAt: userBlocks.createdAt })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, me))

    expect(rows).toHaveLength(1)
    expect(rows[0]?.createdAt).toEqual(first?.createdAt)
  })

  test('自拉黑在 DB 层不可表达（CHECK）', async () => {
    const me = await newUser()
    await expect(store.block(me, me)).rejects.toThrow()
  })

  test('existsBlockBetween 双向判定；isBlocked 只看建立方向', async () => {
    const a = await newUser()
    const b = await newUser()

    expect(await store.existsBlockBetween(a, b)).toBe(false)
    await store.block(a, b)
    // 双向：无论谁是查询的第一参数，任一方向的边都命中。
    expect(await store.existsBlockBetween(a, b)).toBe(true)
    expect(await store.existsBlockBetween(b, a)).toBe(true)
    // 单向读取只认建立方向：「谁拉黑了我」不可探测。
    expect(await store.isBlocked(a, b)).toBe(true)
    expect(await store.isBlocked(b, a)).toBe(false)
  })

  test('unblock 幂等：不存在也是成功；解除后双向守卫消失', async () => {
    const a = await newUser()
    const b = await newUser()

    await store.unblock(a, b)
    await store.block(a, b)
    await store.unblock(a, b)
    expect(await store.existsBlockBetween(a, b)).toBe(false)
    expect(await store.isBlocked(a, b)).toBe(false)
  })

  test('listBlocks 按建立方向列出并带公开列', async () => {
    const me = await newUser()
    const target = await newUser()

    await store.block(me, target)
    const rows = await store.listBlocks(me, 20, null)
    const hit = rows.find((row) => row.id === target)
    expect(hit).toBeDefined()
    expect(hit?.nickname).toBe('拉黑测试')
    expect(hit?.blockedAtCursor).toContain('T')
  })

  test('游标翻页：多取一行判定 next、按 (created_at, id) 不重不漏（含同 created_at 场景）', async () => {
    const me = await newUser()
    const t1 = await newUser('甲')
    const t2 = await newUser('乙')
    const t3 = await newUser('丙')
    await store.block(me, t1)
    await store.block(me, t2)
    await store.block(me, t3)
    // 把三条的 created_at 强改成同一时刻：tie-break 完全落在 id 列上（游标第三列排序的极端情形）。
    await db.execute(
      sql`update user_blocks set created_at = '2026-10-05T02:00:00.000000Z'::timestamptz where blocker_id = ${me}::uuid`,
    )

    const first = await store.listBlocks(me, 2, null)
    expect(first).toHaveLength(3) // 多取一行
    const page1 = first.slice(0, 2)
    const cursor = { createdAt: page1[1]?.blockedAtCursor ?? '', id: page1[1]?.id ?? '' }
    const second = await store.listBlocks(me, 2, cursor)
    const page2 = second.slice(0, 2)

    const seen = [...page1, ...page2].map((row) => row.id)
    expect(new Set(seen).size).toBe(3) // 不重
    expect(seen.sort()).toEqual([t1, t2, t3].sort()) // 不漏
  })

  test('删用户 CASCADE 带走拉黑行', async () => {
    const a = await newUser()
    const b = await newUser()
    await store.block(a, b)
    await db.delete(users).where(eq(users.id, b))
    const rows = await db
      .select({ id: userBlocks.id })
      .from(userBlocks)
      .where(eq(userBlocks.blockerId, a))
    expect(rows).toHaveLength(0)
  })
})
