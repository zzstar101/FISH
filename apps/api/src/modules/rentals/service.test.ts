import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDb } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listings } from '@fish/db/schema/listings'
import { rentalTerms } from '@fish/db/schema/rentals'
import { users } from '@fish/db/schema/users'
import { decodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/bun-sql/migrator'
import { createListingService } from '../listings/service'
import { createSqlListingStore } from '../listings/store'
import { createContentModeration } from '../moderation/content'
import { createLocalContentModerationProvider } from '../moderation/providers/local'
import { createRentalService } from './service'
import { createSqlRentalStore } from './store'

/**
 * #706 RNT-02 的集成测试（真库 + 独立 scratch 库）。
 *
 * 覆盖验收项：
 * 1. 合资格用户可发布；非法金额 / 非法租期 / 非本人编辑 / 未审核公开均被拒绝；金额整数分。
 * 2. 创建失败时无缺条款的公开商品；仅改价格 / 押金 / 规则任一也会递增条款版本。
 * 3. 广场仅返回符合公开条件的 RENTAL；筛选与分页有效。
 */
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('集成测试需要 DATABASE_URL：先 bun run db:up && bun run db:migrate')
}

const migrationsFolder = Bun.fileURLToPath(
  new URL('../../../../../packages/db/src/migrations', import.meta.url),
)
const scratchDatabase = `fish_rental_publish_test_${process.pid}`
const scratchUrl = (() => {
  const url = new URL(databaseUrl)
  url.pathname = `/${scratchDatabase}`
  return url.toString()
})()

const admin = createDb(databaseUrl)
const db = createDb(scratchUrl)
const store = createSqlRentalStore(db)

const storage = {
  publicUrl: (key: string) => `https://cdn.example/${key}`,
  presignPut: () => ({
    url: 'https://upload.test',
    headers: {},
    expiresAt: new Date().toISOString(),
  }),
  stat: async () => ({ size: 100, contentType: 'image/jpeg' }),
}

const service = createRentalService({
  store,
  storage,
  moderation: createContentModeration({
    storage,
    // 本地 provider：与生产同一接口，行为与旧同步词表一致（不联网）。
    moderationProvider: createLocalContentModerationProvider(),
    mediaObjects: {
      findByFinalKey: async () => null,
      findConfirmedFinalKey: async () => null,
    },
    pendingDeletions: { isPending: async () => false },
    legacyUserIds: async () => [],
  }),
})

/** 已认证的教育邮箱用户（合资格）与未认证用户（不合资格）。 */
const verifiedOwner = '01970000-0000-7000-8000-000000000101'
const unverifiedOwner = '01970000-0000-7000-8000-000000000102'
const otherUser = '01970000-0000-7000-8000-000000000103'

/** 图片键必须在用户自己的前缀下（审核内核的前缀校验）。 */
const objectKeysFor = (userId: string) => [`listings/${userId}/a.jpg`]

async function seedUser(id: string, authStatus: 'VERIFIED' | 'UNVERIFIED') {
  await db.insert(users).values({ id, nickname: `用户 ${id.slice(-3)}`, authStatus })
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    title: '出租 iPad Air 5',
    description: '含保护壳与充电器，屏幕无划痕。',
    dailyPriceCents: 2500,
    depositCents: 50000,
    rules: '请勿拆机',
    minDays: 1,
    maxDays: 30,
    condition: 'GOOD' as const,
    objectKeys: [`listings/${verifiedOwner}/a.jpg`],
    ...overrides,
  }
}

beforeAll(async () => {
  await admin.$client.unsafe(`create database "${scratchDatabase}"`)
  await migrate(db, { migrationsFolder })
  await seedUser(verifiedOwner, 'VERIFIED')
  await seedUser(unverifiedOwner, 'UNVERIFIED')
  await seedUser(otherUser, 'UNVERIFIED')
})

afterAll(async () => {
  await db.$client.close()
  await admin.$client.unsafe(`drop database if exists "${scratchDatabase}" with (force)`)
  await admin.$client.close()
})

/** 每个用例自己清理，避免相互影响广场列表断言。 */
async function withCleanup(run: () => Promise<void>) {
  try {
    await run()
  } finally {
    await db.delete(rentalTerms)
    await db.delete(listings).where(eq(listings.listingType, 'RENTAL'))
  }
}

describe('#706 出租发布', () => {
  test('合资格用户可发布；条款与商品同事务落库，金额以整数分存储', async () => {
    await withCleanup(async () => {
      const detail = await service.createRental(verifiedOwner, validInput())

      expect(detail.title).toBe('出租 iPad Air 5')
      expect(detail.dailyPriceCents).toBe(2500)
      expect(detail.depositCents).toBe(50000)
      expect(detail.category).toBe('DIGITAL')
      expect(detail.isOwner).toBe(true)
      expect(detail.images).toHaveLength(1)

      // 条款行与商品行必须成对存在（验收：无缺条款的公开商品）。
      const terms = await db
        .select()
        .from(rentalTerms)
        .where(eq(rentalTerms.listingId, detailIdOf(detail)))
      expect(terms).toHaveLength(1)
      expect(terms[0]?.termsVersion).toBe(1)
    })
  })

  test('未通过教育邮箱认证 → 403 RENTAL_NOT_ELIGIBLE', async () => {
    await withCleanup(async () => {
      await expect(
        service.createRental(
          unverifiedOwner,
          validInput({ objectKeys: objectKeysFor(unverifiedOwner) }),
        ),
      ).rejects.toMatchObject({ status: 403, code: 'RENTAL_NOT_ELIGIBLE' })
      // 一条商品都不得落库（资格校验在建行之前）。
      expect(await db.$count(listings, eq(listings.sellerId, unverifiedOwner))).toBe(0)
    })
  })

  test('非法租期（max < min / 超出平台界）被契约拒绝', async () => {
    await withCleanup(async () => {
      // 对象级 refine：max < min
      const { RentalCreateInputSchema } = await import('@fish/contracts/rentals/schema')
      const reversed = RentalCreateInputSchema.safeParse(validInput({ minDays: 10, maxDays: 3 }))
      expect(reversed.success).toBe(false)
      // 超出平台上限 90
      const tooLong = RentalCreateInputSchema.safeParse(validInput({ maxDays: 91 }))
      expect(tooLong.success).toBe(false)
      // 0 天
      const zero = RentalCreateInputSchema.safeParse(validInput({ minDays: 0 }))
      expect(zero.success).toBe(false)
    })
  })

  test('金额为负 / 押金为负被契约拒绝', async () => {
    const { RentalCreateInputSchema } = await import('@fish/contracts/rentals/schema')
    expect(RentalCreateInputSchema.safeParse(validInput({ dailyPriceCents: -1 })).success).toBe(
      false,
    )
    expect(RentalCreateInputSchema.safeParse(validInput({ depositCents: -1 })).success).toBe(false)
  })

  test('DB 兜底：绕过 service 直接插入越界租期会被 CHECK 拒绝', async () => {
    await withCleanup(async () => {
      const detail = await service.createRental(verifiedOwner, validInput())
      const id = detailIdOf(detail)
      // 0 天违反 rental_terms_min_days_range。drizzle 的 builder 是 thenable，
      // 必须显式 await 才会真正执行（`expect(...).rejects` 拿到的是 builder 本身）。
      await expect(
        (async () => {
          await db
            .update(rentalTerms)
            .set({ minDays: 0, maxDays: 30 })
            .where(eq(rentalTerms.listingId, id))
        })(),
      ).rejects.toThrow(
        // drizzle 把 PG 错误包在 `DrizzleQueryError` 里，constraint 在 `cause` 上 ——
        // 只断言「抛了」对任何失败（含连接错误）都成立，等于没测。
        expect.objectContaining({
          cause: expect.objectContaining({ constraint: 'rental_terms_min_days_range' }),
        }) as never,
      )
    })
  })

  test('创建失败时不留下任何商品行（审核阻断路径）', async () => {
    await withCleanup(async () => {
      // 本地 provider 命中违禁词 → BLOCK。用一条已知会被拒的标题。
      const before = await db.$count(listings, eq(listings.listingType, 'RENTAL'))
      await expect(
        service.createRental(
          verifiedOwner,
          validInput({ title: '出售违禁品', description: '违禁品交易' }),
        ),
      ).rejects.toMatchObject({ status: 422, code: 'RENTAL_CONTENT_BLOCKED' })
      expect(await db.$count(listings, eq(listings.listingType, 'RENTAL'))).toBe(before)
    })
  })
})

describe('#706 条款版本', () => {
  test('仅改日租价也会递增版本', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput())
      const id = detailIdOf(created)

      const updated = await service.updateRental(verifiedOwner, id, { dailyPriceCents: 3000 })
      expect(updated.dailyPriceCents).toBe(3000)
      const [terms] = await db.select().from(rentalTerms).where(eq(rentalTerms.listingId, id))
      expect(terms?.termsVersion).toBe(2)
    })
  })

  test('仅改押金递增版本', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput())
      const id = detailIdOf(created)
      await service.updateRental(verifiedOwner, id, { depositCents: 1000 })
      const [terms] = await db.select().from(rentalTerms).where(eq(rentalTerms.listingId, id))
      expect(terms?.termsVersion).toBe(2)
    })
  })

  test('仅改规则递增版本', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput())
      const id = detailIdOf(created)
      await service.updateRental(verifiedOwner, id, { rules: '新的规则' })
      const [terms] = await db.select().from(rentalTerms).where(eq(rentalTerms.listingId, id))
      expect(terms?.termsVersion).toBe(2)
    })
  })

  test('只改标题**不**递增条款版本（条款内容没变）', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput())
      const id = detailIdOf(created)
      await service.updateRental(verifiedOwner, id, { title: '出租 iPad Air 5（改名）' })
      const [terms] = await db.select().from(rentalTerms).where(eq(rentalTerms.listingId, id))
      // 标题不进条款快照，改它不该让已发的重确认失效。
      expect(terms?.termsVersion).toBe(1)
    })
  })

  test('非本人编辑 → 403 NOT_RENTAL_OWNER', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput())
      await expect(
        service.updateRental(otherUser, detailIdOf(created), { title: '偷偷改名' }),
      ).rejects.toMatchObject({ status: 403, code: 'NOT_RENTAL_OWNER' })
    })
  })

  test('部分更新下的租期关系按合并后状态判定', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(
        verifiedOwner,
        validInput({ minDays: 5, maxDays: 10 }),
      )
      // 只把 maxDays 降到 3 < 库里的 minDays(5) → 必须拒。
      await expect(
        service.updateRental(verifiedOwner, detailIdOf(created), { maxDays: 3 }),
      ).rejects.toMatchObject({ status: 422 })
    })
  })

  test('锁内合并态校验：绕过 service 直接调 store 也不会把库改成 min > max', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(
        verifiedOwner,
        validInput({ minDays: 5, maxDays: 30 }),
      )
      const id = detailIdOf(created)

      /*
       * 直接走 store（跳过 service 事务外那次校验）：这是唯一能证明**锁内**判定存在的路径。
       * 只靠 service 的检查时，两个各自合法的并发 PATCH 合并后会撞 DB 的 CHECK，
       * 抛裸 `DrizzleQueryError` → 500。锁内判定把它变成 `terms-invalid`（service 映 422）。
       */
      const result = await store.updateRentalAtomic({
        listingId: id,
        ownerId: verifiedOwner,
        auditSnapshot: { title: created.title, description: created.description },
        listingFields: {},
        termsFields: { maxDays: 3 },
      })
      expect(result.kind).toBe('terms-invalid')

      // 库内仍是合法的 5/30（没被写坏）。
      const [terms] = await db.select().from(rentalTerms).where(eq(rentalTerms.listingId, id))
      expect(Number(terms?.minDays)).toBe(5)
      expect(Number(terms?.maxDays)).toBe(30)
    })
  })
})

describe('#706 广场与可见性', () => {
  test('广场只返回公开的 RENTAL，且不含出售商品', async () => {
    await withCleanup(async () => {
      const rental = await service.createRental(verifiedOwner, validInput({ title: '广场出租 A' }))
      // 造一条同卖家的出售商品：它不该出现在租赁广场。
      // 注意 `listings_listing_no_owner_fk`：编号必须先在 `listing_numbers` 里占位，
      // 否则插入会被复合外键拒掉（与 #286 之后的真实写路径同一顺序）。
      const saleId = newId()
      const saleNo = 987654321098n
      await db.execute(sql`
        INSERT INTO listing_numbers (listing_no, listing_id) VALUES (${String(saleNo)}::bigint, ${saleId}::uuid)
      `)
      await db.insert(listings).values({
        id: saleId,
        listingNo: saleNo,
        sellerId: verifiedOwner,
        title: '出售商品不该出现',
        description: 'x',
        priceCents: 100,
        category: 'DIGITAL',
        condition: 'GOOD',
        status: 'ACTIVE',
        moderationStatus: 'APPROVED',
        listingType: 'SALE',
      })

      const feed = await service.listFeed({ limit: 20, sort: 'newest' })
      const titles = feed.items.map((item) => item.title)
      expect(titles).toContain('广场出租 A')
      expect(titles).not.toContain('出售商品不该出现')
      expect(feed.items[0]?.id).toBe(rental.id)
    })
  })

  test('关键词筛选生效', async () => {
    await withCleanup(async () => {
      await service.createRental(verifiedOwner, validInput({ title: '出租 相机' }))
      await service.createRental(
        verifiedOwner,
        validInput({ title: '出租 耳机', description: '另一件东西' }),
      )
      const feed = await service.listFeed({ limit: 20, sort: 'newest', q: '相机' })
      expect(feed.items.map((item) => item.title)).toEqual(['出租 相机'])
    })
  })

  test('days 筛选只返回能租满 N 天的商品', async () => {
    await withCleanup(async () => {
      await service.createRental(
        verifiedOwner,
        validInput({ title: '短租', minDays: 1, maxDays: 3 }),
      )
      await service.createRental(
        verifiedOwner,
        validInput({ title: '长租', minDays: 10, maxDays: 60 }),
      )

      const feed = await service.listFeed({ limit: 20, sort: 'newest', days: 30 })
      expect(feed.items.map((item) => item.title)).toEqual(['长租'])
    })
  })

  test('游标分页不重不漏，且同一毫秒内的行也不会漏（微秒精度）', async () => {
    await withCleanup(async () => {
      // 先各自创建（拿到合法行），再把它们的 created_at 压到**同一毫秒**的不同微秒上：
      // 用 `Date.toISOString()` 生成的游标（毫秒）会让排在游标之后的两行永久消失。
      const ids: string[] = []
      for (const title of ['同毫秒 A', '同毫秒 B', '同毫秒 C']) {
        const detail = await service.createRental(verifiedOwner, validInput({ title }))
        ids.push(detailIdOf(detail))
      }
      const sameMs = new Date('2026-11-20T10:00:00.123Z')
      // 三行的微秒各不相同（900 / 300 / 100），且都在同一毫秒里。
      for (const [index, micros] of [
        [0, 900],
        [1, 300],
        [2, 100],
      ] as const) {
        const targetId = ids[index]
        if (!targetId) throw new Error('缺少测试商品 id')
        await db.execute(sql`
          UPDATE listings
          SET created_at = ${sameMs.toISOString()}::timestamptz
                           + (${String(micros)} || ' microseconds')::interval
          WHERE id = ${targetId}::uuid
        `)
      }

      const collected: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 5; page += 1) {
        const result = await service.listFeed({
          limit: 1,
          sort: 'newest',
          ...(cursor ? { cursor } : {}),
        })
        collected.push(...result.items.map((item) => item.id))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      // 三行都必须出现，且只出现一次。
      expect(collected).toHaveLength(3)
      expect(new Set(collected).size).toBe(3)
    })
  })

  test('价格排序的游标翻页也成立（priceAsc）', async () => {
    await withCleanup(async () => {
      for (const price of [3000, 1000, 2000]) {
        await service.createRental(verifiedOwner, validInput({ dailyPriceCents: price }))
      }
      const collected: number[] = []
      let cursor: string | undefined
      for (let page = 0; page < 5; page += 1) {
        const result = await service.listFeed({
          limit: 1,
          sort: 'priceAsc',
          ...(cursor ? { cursor } : {}),
        })
        collected.push(...result.items.map((item) => item.dailyPriceCents))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      expect(collected).toEqual([1000, 2000, 3000])
    })
  })

  test('非法游标 → 422，而不是 500（月份/日/时分秒越界都要挡住）', async () => {
    await withCleanup(async () => {
      // 先建一条，确保 id 前缀合法（否则会在 id 校验那一步就被拒，测不到时间戳分支）。
      const created = await service.createRental(verifiedOwner, validInput())
      const envelope = (sortKey: string) =>
        Buffer.from(JSON.stringify({ sortKey, id: created.id }), 'utf8').toString('base64url')

      // 形状对、值域错：手写正则放得过，PG 的 `::timestamptz` 会拒 → 必须在这里变 422。
      for (const sortKey of [
        '2026-13-45T99:99:99.999999Z',
        '2026-02-31T00:00:00.000000Z',
        'not-a-date',
      ]) {
        await expect(
          service.listFeed({ limit: 20, sort: 'newest', cursor: envelope(sortKey) }),
        ).rejects.toMatchObject({ status: 422, code: 'VALIDATION_FAILED' })
      }
    })
  })

  test('未过审的出租对他人 404，对本人可见', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput())
      const id = detailIdOf(created)
      // 人为压成待审 + 下架（模拟审核引擎的 REVIEW 结论）。
      await db
        .update(listings)
        .set({ moderationStatus: 'REVIEW', status: 'OFFLINE' })
        .where(eq(listings.id, id))

      await expect(service.getDetail(otherUser, id)).rejects.toMatchObject({
        status: 404,
        code: 'RENTAL_NOT_FOUND',
      })
      // 本人仍能读（自己的商品要能看到审核中状态）。
      const own = await service.getDetail(verifiedOwner, id)
      expect(own.isOwner).toBe(true)
    })
  })

  test('下架后从广场消失，本人仍能在「我的出租」看到', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput({ title: '待下架' }))
      const id = detailIdOf(created)
      await service.setStatus(verifiedOwner, id, 'OFFLINE')

      const feed = await service.listFeed({ limit: 20, sort: 'newest' })
      expect(feed.items.map((item) => item.title)).not.toContain('待下架')

      const mine = await service.listMine(verifiedOwner)
      expect(mine.items.map((item) => item.title)).toContain('待下架')
    })
  })
})

describe('#706 编辑不得改变卖家主动下架的决定', () => {
  test('下架后编辑标题：商品仍为 OFFLINE，且不出现在广场', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput({ title: '会被下架的' }))
      const id = detailIdOf(created)
      await service.setStatus(verifiedOwner, id, 'OFFLINE')

      await service.updateRental(verifiedOwner, id, { title: '下架后又改名' })

      const [row] = await db
        .select({ status: listings.status, title: listings.title })
        .from(listings)
        .where(eq(listings.id, id))
      // 关键：编辑不能把 status 拉回 ACTIVE（审查 P0 实测的漏洞）。
      expect(row?.status).toBe('OFFLINE')
      expect(row?.title).toBe('下架后又改名')

      const feed = await service.listFeed({ limit: 50, sort: 'newest' })
      expect(feed.items.map((item) => item.title)).not.toContain('下架后又改名')
    })
  })

  test('规则为空白串时归一为 null（不是空字符串）', async () => {
    await withCleanup(async () => {
      const created = await service.createRental(verifiedOwner, validInput({ rules: '   ' }))
      expect(created.rules).toBeNull()
    })
  })
})

describe('#706 出售端不受影响', () => {
  test('出售 feed 不含 RENTAL（#705 的隔离在本分支仍成立）', async () => {
    await withCleanup(async () => {
      const rental = await service.createRental(
        verifiedOwner,
        validInput({ title: '不该进出售 Feed 的出租' }),
      )
      // 走**真实的出售读路径**（不是「查一下自己刚插的行」）：删掉 #705 的 SALE 过滤，
      // 这条会红。
      const saleService = createListingService({ store: createSqlListingStore(db), storage })
      const feed = await saleService.listFeed(null, { limit: 50, sort: 'newest' })
      expect(feed.items.map((item) => item.title)).not.toContain('不该进出售 Feed 的出租')
      // 反向对照：出租确实存在于库中（否则上面的断言可能只是因为没建成功）。
      const [row] = await db
        .select({ type: listings.listingType })
        .from(listings)
        .where(eq(listings.id, detailIdOf(rental)))
      expect(row?.type).toBe('RENTAL')
    })
  })
})

/** 出租详情里的公开 id → 内部 uuid（测试内部用，不经过 HTTP）。 */
function detailIdOf(detail: { id: string }): string {
  return decodePublicId(PUBLIC_ID_PREFIX.listing, detail.id)
}
