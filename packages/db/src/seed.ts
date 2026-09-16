import { sql } from 'drizzle-orm'
import { createDb, type Db } from './client'
import { jsonParam } from './json'
import { conversations } from './schema/conversations'
import { jobs } from './schema/jobs'
import { listingImages, listings } from './schema/listings'
import { matches } from './schema/matches'
import { messages } from './schema/messages'
import { notifications } from './schema/notifications'
import { sessions } from './schema/sessions'
import { transactions } from './schema/transactions'
import { users } from './schema/users'
import { campusEmailVerifications } from './schema/verifications'
import { wishes } from './schema/wishes'

/** 事务内的写入句柄；seed 既能在 CLI 里跑，也能被测试包在事务里回滚。 */
export type SeedTx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * 固定的 UUID：seed 反复执行结果一致，demo 链接稳定。
 * 不用 newId()，否则每次 seed 都换一批主键。
 */
const ids = {
  sellerA: '01930000-0000-7000-8000-00000000000a',
  buyerB: '01930000-0000-7000-8000-00000000000b',
  buyerC: '01930000-0000-7000-8000-00000000000c',
  listingK380: '01930000-0000-7000-8000-000000000011',
  listingMonitor: '01930000-0000-7000-8000-000000000012',
  listingTextbook: '01930000-0000-7000-8000-000000000013',
  listingLamp: '01930000-0000-7000-8000-000000000014',
  listingBasketball: '01930000-0000-7000-8000-000000000015',
  listingSneakers: '01930000-0000-7000-8000-000000000016',
  wishKeyboard: '01930000-0000-7000-8000-000000000021',
  wishTextbook: '01930000-0000-7000-8000-000000000022',
  conversationK380: '01930000-0000-7000-8000-000000000041',
  messageText: '01930000-0000-7000-8000-000000000042',
  messageSystem: '01930000-0000-7000-8000-000000000043',
  transactionLamp: '01930000-0000-7000-8000-000000000051',
  transactionBasketball: '01930000-0000-7000-8000-000000000052',
  jobMatchListing: '01930000-0000-7000-8000-000000000071',
} as const

/**
 * 三个 seed 账号共用的演示密码，用 `Bun.password`（argon2id）真实哈希写入（#3 替换了 #2 的占位值）。
 * 仅本地演示，禁止用于生产；真实用户密码只能经 `POST /auth/register` 写入。
 * 导出是给 `seed.test.ts` 断言「演示密码确实能登录」用的。
 */
export const DEMO_PASSWORD = 'fish123456'

/**
 * 学号（12 位）与演示密码一起在 issue #3 里冻结，便于前端直接登录调试。
 * #68 后 VERIFIED 只能由真实校园邮箱验证产生（不能在 seed 里伪造），三个演示账号
 * 统一 UNVERIFIED；认证后的徽章演示改由真实验证流程（dev outbox）给出。
 */
const demoStudentNos = {
  sellerA: '202101000001',
  buyerB: '202101000002',
  buyerC: '202101000003',
} as const

/**
 * 生成 #2 验收要求的"首页、愿望、聊天、交易基础数据"。
 * 数量刻意保持最小完整，扩容到 #13 的 demo 规模由 #13 负责。
 *
 * 注意：`matches` / `notifications` 刻意**不写**——demo 那一对匹配由 worker 用真实打分产出
 * （#43），seed 只投一条 `PENDING` 的 `MATCH_LISTING`，否则 seed 会成为引擎之外的第二份真相。
 * 因此 seed 单独跑完时这两张表是空的（见 `seed.test.ts` 的 counts）。
 *
 * 注意：`listing_images.object_key` 指向 MinIO 里并不存在的对象，
 * 因此前端渲染这些图会 404。真实图片由 #6 的上传流程产生。
 */
export async function seed(tx: SeedTx): Promise<void> {
  // 一次性列出全部业务表：单条 TRUNCATE 可以跨外键，但必须把所有被引用的表都列全。
  // `sessions` / `campus_email_verifications`（#68）必须在内：它们引用 users，
  // 漏掉会让 seed 第二次执行直接失败。
  await tx.execute(
    sql`TRUNCATE TABLE ${users}, ${sessions}, ${campusEmailVerifications}, ${listings}, ${listingImages}, ${wishes}, ${matches}, ${conversations}, ${messages}, ${transactions}, ${notifications}, ${jobs}`,
  )

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // 同一个明文密码只需哈希一次（argon2id 每次哈希都带随机盐，复用同一串不影响正确性）。
  const passwordHash = await Bun.password.hash(DEMO_PASSWORD)

  await tx.insert(users).values([
    {
      id: ids.sellerA,
      studentNo: demoStudentNos.sellerA,
      passwordHash,
      nickname: '阿岚',
      campus: '肇庆',
      createdAt: lastWeek,
    },
    {
      id: ids.buyerB,
      studentNo: demoStudentNos.buyerB,
      passwordHash,
      nickname: '小北',
      campus: '肇庆',
      createdAt: lastWeek,
    },
    {
      id: ids.buyerC,
      studentNo: demoStudentNos.buyerC,
      passwordHash,
      nickname: '橙子',
      campus: '广州',
      createdAt: lastWeek,
    },
  ])

  await tx.insert(listings).values([
    {
      id: ids.listingK380,
      sellerId: ids.sellerA,
      title: '罗技 K380 机械键盘',
      description: '自用一年，键帽无打油，附原装收纳袋。可刀。',
      priceCents: 16000,
      category: 'DIGITAL',
      condition: 'GOOD',
      negotiable: true,
      createdAt: yesterday,
    },
    {
      id: ids.listingMonitor,
      sellerId: ids.sellerA,
      title: 'Redmi 23.8 寸显示器',
      description: '毕业出，无亮点无坏点，支持 HDMI。',
      priceCents: 35000,
      category: 'DIGITAL',
      condition: 'LIKE_NEW',
      urgent: true,
      createdAt: yesterday,
    },
    {
      id: ids.listingTextbook,
      sellerId: ids.sellerA,
      title: '高等数学上册（同济第七版）',
      description: '有少量笔记，不影响阅读。',
      priceCents: 2000,
      category: 'BOOKS',
      condition: 'GOOD',
      createdAt: yesterday,
    },
    {
      id: ids.listingLamp,
      sellerId: ids.buyerB,
      title: '宿舍护眼台灯',
      description: '三档色温，USB 供电。',
      priceCents: 3000,
      category: 'DAILY',
      condition: 'GOOD',
      status: 'RESERVED',
      createdAt: yesterday,
    },
    {
      id: ids.listingBasketball,
      sellerId: ids.buyerB,
      title: '斯伯丁室外篮球',
      description: '打了半个学期，气密性正常。',
      priceCents: 5000,
      category: 'SPORTS',
      condition: 'GOOD',
      status: 'SOLD',
      createdAt: lastWeek,
    },
    {
      id: ids.listingSneakers,
      sellerId: ids.buyerC,
      title: '匡威 1970s 帆布鞋 42 码',
      description: '尺码不合，穿过两次。0 元送给有缘人。',
      priceCents: 0,
      category: 'APPAREL',
      condition: 'FAIR',
      free: true,
      createdAt: yesterday,
    },
  ])

  await tx.insert(listingImages).values([
    { listingId: ids.listingK380, objectKey: 'listings/seed-k380/0.jpg', sortOrder: 0 },
    { listingId: ids.listingK380, objectKey: 'listings/seed-k380/1.jpg', sortOrder: 1 },
    { listingId: ids.listingMonitor, objectKey: 'listings/seed-monitor/0.jpg', sortOrder: 0 },
    { listingId: ids.listingTextbook, objectKey: 'listings/seed-textbook/0.jpg', sortOrder: 0 },
  ])

  await tx.insert(wishes).values([
    {
      id: ids.wishKeyboard,
      userId: ids.buyerB,
      keyword: '机械键盘',
      category: 'DIGITAL',
      budgetMaxCents: 20000,
      description: '想要一把能带出门的机械键盘。',
      createdAt: yesterday,
    },
    {
      id: ids.wishTextbook,
      userId: ids.buyerC,
      keyword: '高等数学 教材',
      category: 'BOOKS',
      budgetMinCents: 1000,
      budgetMaxCents: 3000,
      acceptSimilar: false,
      createdAt: yesterday,
    },
  ])

  await tx.insert(conversations).values({
    id: ids.conversationK380,
    listingId: ids.listingK380,
    buyerId: ids.buyerB,
    sellerId: ids.sellerA,
    buyerLastReadAt: yesterday,
    lastMessageAt: yesterday,
    createdAt: yesterday,
  })

  await tx.insert(messages).values([
    {
      id: ids.messageText,
      conversationId: ids.conversationK380,
      senderId: ids.buyerB,
      type: 'TEXT',
      content: '你好，键盘还在吗？150 能出吗？',
      createdAt: yesterday,
    },
    {
      id: ids.messageSystem,
      conversationId: ids.conversationK380,
      senderId: null,
      type: 'SYSTEM',
      content: '买家发起了交易确认。',
      createdAt: yesterday,
    },
  ])

  await tx.insert(transactions).values([
    {
      id: ids.transactionLamp,
      listingId: ids.listingLamp,
      buyerId: ids.sellerA,
      sellerId: ids.buyerB,
      amountCents: 2800,
      status: 'PENDING_MEETUP',
      createdAt: yesterday,
    },
    {
      id: ids.transactionBasketball,
      listingId: ids.listingBasketball,
      buyerId: ids.buyerC,
      sellerId: ids.buyerB,
      amountCents: 5000,
      status: 'COMPLETED',
      buyerConfirmedAt: lastWeek,
      sellerConfirmedAt: lastWeek,
      completedAt: lastWeek,
      createdAt: lastWeek,
    },
  ])

  // 主 Demo 的"愿望成真"样例**不预写结果**：只投一条 PENDING 的 MATCH_LISTING，
  // 由 worker 用真实打分产出那对 match（K380 + "机械键盘 ≤¥200" → 100 分）与首条通知。
  //
  // #43 之前这里硬编码了 score=92 / keyword=85 / price=90，而引擎对同样两行的真实结果是 100；
  // seed 因此成了引擎之外的"第二份真相"，权重或分词一改就静默漂移，且那条 job 已 DONE，
  // 永远不会被纠正。代价是：只跑 seed、不起 worker 时愿望页暂时没有匹配——
  // 而 README 的启动顺序本来就包含 dev:worker。
  await tx.insert(jobs).values({
    id: ids.jobMatchListing,
    type: 'MATCH_LISTING',
    payload: jsonParam({ listingId: ids.listingK380 }),
    status: 'PENDING',
    attempts: 0,
    runAt: now,
    createdAt: now,
  })
}

/** `db:seed` 会清空整库，因此只在本地数据库上执行。 */
function assertLocalDatabase(databaseUrl: string): void {
  if (process.env.SEED_FORCE === '1') return
  const { hostname } = new URL(databaseUrl)
  if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
    throw new Error(
      `db:seed 会 TRUNCATE 全部业务表，拒绝在非本地数据库（${hostname}）上执行。确认无误时设 SEED_FORCE=1。`,
    )
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL（在仓库根目录 cp .env.example .env）')
  }
  assertLocalDatabase(databaseUrl)

  const db = createDb(databaseUrl)
  await db.transaction((tx) => seed(tx))
  console.log('[seed] 基础数据已写入')
}
