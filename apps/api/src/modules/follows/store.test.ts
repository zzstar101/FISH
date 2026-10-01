import { afterAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { follows } from '@fish/db/schema/follows'
import { users } from '@fish/db/schema/users'
import { eq, inArray } from 'drizzle-orm'
import { decodeFollowingCursor, encodeFollowingCursor } from './cursor'
import { createSqlFollowStore } from './store'

// 与 packages/db 的集成测试同一约定：没有 DATABASE_URL 就明确失败，而不是静默跳过。
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const db = createDb(databaseUrl)
const store = createSqlFollowStore(db)

const created: string[] = []
let seq = 0

/** 每个用例自建、自清自己的用户（删用户靠 CASCADE 带走 follows，与 store 的删除语义一致）。 */
async function newUser(nickname = '关注测试'): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ studentNo: `follow-${Date.now()}-${seq++}`, passwordHash: 'test-hash', nickname })
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

describe('follow store (integration)', () => {
  test('follow 幂等：重复关注只有一行，且不改写首次 created_at', async () => {
    const me = await newUser()
    const target = await newUser()

    await store.follow(me, target)
    const [first] = await db
      .select({ createdAt: follows.createdAt })
      .from(follows)
      .where(eq(follows.followerId, me))
    await store.follow(me, target)
    const [second] = await db
      .select({ createdAt: follows.createdAt })
      .from(follows)
      .where(eq(follows.followerId, me))

    expect(second?.createdAt.getTime()).toBe(first?.createdAt.getTime())
    expect(await store.isFollowing(me, target)).toBe(true)
  })

  test('unfollow 幂等：不存在也是成功', async () => {
    const me = await newUser()
    const target = await newUser()

    await store.follow(me, target)
    await store.unfollow(me, target)
    await store.unfollow(me, target)

    expect(await store.isFollowing(me, target)).toBe(false)
  })

  test('自关注被 DB CHECK 挡下（follows_no_self_follow）', async () => {
    const me = await newUser()

    await expect(store.follow(me, me)).rejects.toThrow()
    expect(await store.isFollowing(me, me)).toBe(false)
  })

  test('userExists 区分存在与不存在', async () => {
    const me = await newUser()

    expect(await store.userExists(me)).toBe(true)
    expect(await store.userExists('01930000-0000-7000-8000-0000000000ff')).toBe(false)
  })

  test('totals 只数我关注的方向，mutualTotal 只数互关', async () => {
    const me = await newUser()
    const a = await newUser()
    const b = await newUser()

    // 我关注 a、b；a 也关注我（互关）；c 关注我但我没关注 c
    await store.follow(me, a)
    await store.follow(me, b)
    await store.follow(a, me)
    const c = await newUser()
    await store.follow(c, me)

    expect(await store.totals(me)).toEqual({ total: 2, mutualTotal: 1 })
  })

  test('listFollowing 稳定排序（created_at DESC, id DESC）+ 游标翻页不重不漏 + mutual 真值', async () => {
    const me = await newUser()
    const older = await newUser('较早')
    const sameTimeA = await newUser('同刻A')
    const sameTimeB = await newUser('同刻B')

    // 显式给 created_at：older 最早，另两条同一时刻（考验 id tie-break）
    const t0 = new Date('2026-09-01T00:00:00.000Z')
    const t1 = new Date('2026-09-02T00:00:00.000Z')
    await db.insert(follows).values([
      { followerId: me, followingId: older, createdAt: t0 },
      { followerId: me, followingId: sameTimeA, createdAt: t1 },
      { followerId: me, followingId: sameTimeB, createdAt: t1 },
    ])
    // older 也关注我 → 该行 mutual 必须为 true；同刻两人不互关
    await store.follow(older, me)

    const page1 = await store.listFollowing(me, 2, null)
    expect(page1).toHaveLength(3) // limit + 1（look-ahead）
    const [first, second, third] = page1
    // 同刻两人按 id DESC 排序，且都排在较早那条之前
    const expectedSameTimeOrder = [sameTimeA, sameTimeB].sort().reverse()
    expect([first?.id, second?.id]).toEqual(expectedSameTimeOrder)
    expect(third?.id).toBe(older)
    expect(third?.mutual).toBe(true)
    expect(first?.mutual).toBe(false)

    // 用第 2 条（本页最后一条）的游标取下一页：只剩 older
    const cursor = encodeFollowingCursor({
      createdAt: second?.followedAtCursor ?? '',
      id: second?.id ?? '',
    })
    // store 层游标是已解码结构；这里用同一 codec 解回（与 service 走同一条路径）
    const decoded = decodeFollowingCursor(cursor)
    const page2 = await store.listFollowing(me, 2, decoded)
    expect(page2.map((row) => row.id)).toEqual([older])
  })

  test('删除用户时两侧关系一并清理（CASCADE）', async () => {
    const me = await newUser()
    const target = await newUser()
    await store.follow(me, target)
    await store.follow(target, me)

    await db.delete(users).where(eq(users.id, target))

    const remaining = await db
      .select({ id: follows.id })
      .from(follows)
      .where(eq(follows.followerId, me))
    expect(remaining).toHaveLength(0)
    expect(await store.totals(me)).toEqual({ total: 0, mutualTotal: 0 })
  })
})
