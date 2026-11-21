import { sql } from 'drizzle-orm'
import { createDb, type Db } from './client'
import { jsonParam } from './json'
import { adminAuditLogs } from './schema/admin'
import { aiPolishRequests } from './schema/ai-polish-requests'
import { userBlocks } from './schema/blocks'
import { comments } from './schema/comments'
import { conversations } from './schema/conversations'
import { disputeAttachments, disputeEvidenceMessages, disputes } from './schema/disputes'
import { embeddings } from './schema/embeddings'
import { favorites } from './schema/favorites'
import { feedback } from './schema/feedback'
import { follows } from './schema/follows'
import { userRestrictions } from './schema/governance'
import { jobs } from './schema/jobs'
import { listingImageDeletions } from './schema/listing-image-deletions'
import { listingMediaObjects } from './schema/listing-media'
import { listingNumbers } from './schema/listing-numbers'
import { listingImages, listings } from './schema/listings'
import { loginTickets } from './schema/login-tickets'
import { matches } from './schema/matches'
import { messageMedia } from './schema/message-media'
import { messages } from './schema/messages'
import { listingModerationRecords, moderationModelReviews } from './schema/moderation'
import { notifications } from './schema/notifications'
import { recommendationEvents } from './schema/recommendation-events'
import { recommendationRequestItems } from './schema/recommendation-request-items'
import { recommendationRequests } from './schema/recommendation-requests'
import { reports } from './schema/reports'
import { sessions } from './schema/sessions'
import { subscribeMessageDeliveries, subscribeMessageGrants } from './schema/subscribe-messages'
import { transactionReviewImages, transactionReviews } from './schema/transaction-reviews'
import { transactionMeetupTokens, transactions } from './schema/transactions'
import { userInterestProfiles } from './schema/user-interest-profiles'
import { users, wechatIdentities } from './schema/users'
import { campusEmailVerifications } from './schema/verifications'
import { listingViewHistory } from './schema/view-history'
import { listingVisualEmbeddings } from './schema/visual-embeddings'
import { visualQueryImages } from './schema/visual-query-images'
import { visualSearchAttempts } from './schema/visual-search-attempts'
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
  conversationLamp: '01930000-0000-7000-8000-000000000044',
  conversationBasketball: '01930000-0000-7000-8000-000000000045',
  messageLampAccepted: '01930000-0000-7000-8000-000000000046',
  messageBasketballAccepted: '01930000-0000-7000-8000-000000000047',
  transactionLamp: '01930000-0000-7000-8000-000000000051',
  transactionBasketball: '01930000-0000-7000-8000-000000000052',
  jobMatchListing: '01930000-0000-7000-8000-000000000071',
} as const

/** Fixed non-sequential references: rerunning the local seed restores the same logical listings. */
const listingReferences = [
  { listingId: ids.listingK380, listingNo: 638_294_017_526n },
  { listingId: ids.listingMonitor, listingNo: 872_106_953_482n },
  { listingId: ids.listingTextbook, listingNo: 416_829_075_631n },
  { listingId: ids.listingLamp, listingNo: 951_367_208_414n },
  { listingId: ids.listingBasketball, listingNo: 274_809_136_725n },
  { listingId: ids.listingSneakers, listingNo: 709_541_826_303n },
] as const

/**
 * 三个 seed 演示账号的微信 stub code（#703：学号/密码登录随凭据列一起删除）。
 *
 * 本地 `WECHAT_TRANSPORT=stub` 时，用这些 code 调 `POST /auth/wechat/session` 即可登进
 * 对应演示账号；openid 由下方 `stubOpenid()` 按与 stub Provider 相同的确定性规则派生。
 * 导出是给 `seed.test.ts` 断言「演示账号确有微信身份」用的。
 */
export const DEMO_WECHAT_CODES = {
  sellerA: 'demo-seller-a',
  buyerB: 'demo-buyer-b',
  buyerC: 'demo-buyer-c',
} as const

/**
 * 与 `apps/api/src/modules/auth/wechat-service.ts` 的 stub Provider 同一算法：
 * `sha256('wechat-stub:' + code)` → `o` + 27 位 base 字符。seed 不能依赖 apps/api，
 * 因此这里重复一份；两边若改算法，`seed.test.ts` 与 api 的微信登录测试会同时失败。
 */
function stubOpenid(code: string): string {
  const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
  const digest = new Bun.CryptoHasher('sha256').update(`wechat-stub:${code}`).digest('hex')
  let suffix = ''
  for (let i = 0; i < 27; i += 1) {
    const byte = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16)
    suffix += ALPHABET[byte % ALPHABET.length]
  }
  return `o${suffix}`
}

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
  // `sessions` / `campus_email_verifications`（#68）/ `listing_moderation_records`（#80）
  // / `admin_audit_logs`（#73，引用 users 且 ON DELETE RESTRICT）/ `message_media`（#79）
  // / `comments`（#111，引用 users 与 listings）/ `transaction_meetup_tokens`（#70，引用
  // users 与 transactions）/ `ai_polish_requests`（#141，引用 users）/ `wechat_identities`
  // （#86，引用 users 且 ON DELETE CASCADE）/ `listing_media_objects`（#286，引用 users）
  // / `favorites`（#190）/ `follows`（#188）/ `user_blocks`（#466，引用 users）/
  // `transaction_reviews`（#195，引用 users 与
  // transactions）/ `transaction_review_images`（#195，引用 transaction_reviews）/
  // `embeddings`（#322 M1，引用 listings 与 wishes，ON DELETE CASCADE）/ `recommendation_events`
  // 与 `recommendation_requests`（#323，分别引用 users/listings 与 users）/ `recommendation_request_items`
  // （#323 R4，引用 recommendation_requests 与 listings）/ `user_interest_profiles`
  // （#323 R2，引用 users，ON DELETE CASCADE）/ `login_tickets`
  // （#197，引用 users）/ `listing_visual_embeddings`（#324 M3，引用 listings，ON DELETE CASCADE）
  // / `listing_view_history`（#415 M1，引用 users 与 listings，ON DELETE CASCADE）
  // / `disputes`（#465，引用 transactions 与 users）/ `dispute_attachments`（#465，引用
  // disputes 与 users）/ `dispute_evidence_messages`（#465，引用 disputes 与 messages）
  // 必须在内；`visual_query_images` 与 `visual_search_attempts`（#324 M2）没有外键，
  // 但同属业务数据，一并清空才算"干净的一轮"。
  // `listing_image_deletions`（#476）同样没有外键（键指向对象存储里的对象），一并清空，
  // 免得上一轮留下的待删键在下一轮 worker 回收时被"顺带"删掉。
  // `feedback`（#463，引用 users）同理必须在内；反馈由用户真实提交产生，seed 不预置。
  // 漏掉会让 seed 直接失败（实测未列入时报 0A000，不需要该表里真有数据）。
  // `moderation_model_reviews`（#751，引用 listings 与 listing_moderation_records）：不列它，
  // TRUNCATE 会因外键直接报 cannot truncate a table referenced in a foreign key constraint。
  // `subscribe_message_grants` / `subscribe_message_deliveries`（#462，均引用 users）同理；
  // 两者由真实授权与调度循环产生，seed 不预置。
  await tx.execute(
    sql`TRUNCATE TABLE ${users}, ${wechatIdentities}, ${loginTickets}, ${sessions}, ${campusEmailVerifications}, ${listings}, ${listingImages}, ${listingMediaObjects}, ${listingImageDeletions}, ${listingModerationRecords}, ${moderationModelReviews}, ${comments}, ${wishes}, ${embeddings}, ${listingVisualEmbeddings}, ${favorites}, ${follows}, ${userBlocks}, ${listingViewHistory}, ${matches}, ${conversations}, ${messages}, ${messageMedia}, ${adminAuditLogs}, ${transactionMeetupTokens}, ${transactionReviews}, ${transactionReviewImages}, ${transactions}, ${disputes}, ${disputeAttachments}, ${disputeEvidenceMessages}, ${notifications}, ${jobs}, ${aiPolishRequests}, ${reports}, ${feedback}, ${userRestrictions}, ${recommendationEvents}, ${recommendationRequests}, ${recommendationRequestItems}, ${userInterestProfiles}, ${visualQueryImages}, ${visualSearchAttempts}, ${subscribeMessageGrants}, ${subscribeMessageDeliveries}`,
  )

  const now = new Date()
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)

  // #703：演示账号不再写学号/密码（列已删除）；uid 由数据库默认值生成，这里不传。
  await tx.insert(users).values([
    { id: ids.sellerA, nickname: '阿岚', createdAt: lastWeek },
    { id: ids.buyerB, nickname: '小北', createdAt: lastWeek },
    { id: ids.buyerC, nickname: '橙子', createdAt: lastWeek },
  ])

  // #703：绑上固定 openid，本地 stub 登录才能用固定 code 登进演示账号。
  await tx.insert(wechatIdentities).values([
    { userId: ids.sellerA, openid: stubOpenid(DEMO_WECHAT_CODES.sellerA) },
    { userId: ids.buyerB, openid: stubOpenid(DEMO_WECHAT_CODES.buyerB) },
    { userId: ids.buyerC, openid: stubOpenid(DEMO_WECHAT_CODES.buyerC) },
  ])

  // The reservation table must not be truncated: historical references remain occupied.
  // Only the same seed UUID may reclaim its own reserved number on repeated local resets.
  // #301 TRUNCATE 差额审计：有意不清空的另外两张是 `id_rekeys`（ID 迁移台账，无外键）
  // 与 `listing_lookup_attempts`（60s 限流台账，subjectKey 是 HMAC 文本，不引用业务表），
  // 清空它们既不必要也不会解除任何外键阻塞。
  await tx
    .insert(listingNumbers)
    .values([...listingReferences])
    .onConflictDoNothing()
  const reserved = await tx
    .select({ listingId: listingNumbers.listingId, listingNo: listingNumbers.listingNo })
    .from(listingNumbers)
  for (const reference of listingReferences) {
    if (
      !reserved.some(
        (row) => row.listingId === reference.listingId && row.listingNo === reference.listingNo,
      )
    ) {
      throw new Error(`seed 商品编号已被其他商品占用：${reference.listingNo}`)
    }
  }

  await tx.insert(listings).values([
    {
      id: ids.listingK380,
      listingNo: listingReferences[0].listingNo,
      sellerId: ids.sellerA,
      title: '罗技 K380 机械键盘',
      description: '自用一年，键帽无打油，附原装收纳袋。可刀。',
      priceCents: 16000,
      category: 'DIGITAL',
      condition: 'GOOD',
      listingType: 'SALE',
      negotiable: true,
      createdAt: yesterday,
    },
    {
      id: ids.listingMonitor,
      listingNo: listingReferences[1].listingNo,
      sellerId: ids.sellerA,
      title: 'Redmi 23.8 寸显示器',
      description: '毕业出，无亮点无坏点，支持 HDMI。',
      priceCents: 35000,
      category: 'DIGITAL',
      condition: 'LIKE_NEW',
      listingType: 'SALE',
      urgent: true,
      createdAt: yesterday,
    },
    {
      id: ids.listingTextbook,
      listingNo: listingReferences[2].listingNo,
      sellerId: ids.sellerA,
      title: '高等数学上册（同济第七版）',
      description: '有少量笔记，不影响阅读。',
      priceCents: 2000,
      category: 'BOOKS',
      condition: 'GOOD',
      listingType: 'SALE',
      createdAt: yesterday,
    },
    {
      id: ids.listingLamp,
      listingNo: listingReferences[3].listingNo,
      sellerId: ids.buyerB,
      title: '宿舍护眼台灯',
      description: '三档色温，USB 供电。',
      priceCents: 3000,
      category: 'DAILY',
      condition: 'GOOD',
      listingType: 'SALE',
      status: 'RESERVED',
      createdAt: yesterday,
    },
    {
      id: ids.listingBasketball,
      listingNo: listingReferences[4].listingNo,
      sellerId: ids.buyerB,
      title: '斯伯丁室外篮球',
      description: '打了半个学期，气密性正常。',
      priceCents: 5000,
      category: 'SPORTS',
      condition: 'GOOD',
      listingType: 'SALE',
      status: 'SOLD',
      createdAt: lastWeek,
    },
    {
      id: ids.listingSneakers,
      listingNo: listingReferences[5].listingNo,
      sellerId: ids.buyerC,
      title: '匡威 1970s 帆布鞋 42 码',
      description: '尺码不合，穿过两次。0 元送给有缘人。',
      priceCents: 0,
      category: 'APPAREL',
      condition: 'FAIR',
      listingType: 'SALE',
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

  // 两笔交易各自的会话（#157 / #147）：transactions 的读写路径（listForUser /
  // findById）按 (listing_id, buyer_id, seller_id) join conversations 取会话 id，
  // seed 必须给每笔交易补上三元组一致的会话行，否则订单页在 seed 库上永远空态
  // （profile 不 join 会话所以计数正常——同一份数据自相矛盾）。
  // 真实链路里 accept 本身就是 join 会话得到 conversation_id，seed 直接绕过了该不变量。
  await tx.insert(conversations).values([
    {
      id: ids.conversationK380,
      listingId: ids.listingK380,
      buyerId: ids.buyerB,
      sellerId: ids.sellerA,
      buyerLastReadAt: yesterday,
      lastMessageAt: yesterday,
      createdAt: yesterday,
    },
    {
      // 台灯：卖家 buyerB × 买家 sellerA —— transactionLamp 的三元组。
      id: ids.conversationLamp,
      listingId: ids.listingLamp,
      buyerId: ids.sellerA,
      sellerId: ids.buyerB,
      buyerLastReadAt: yesterday,
      lastMessageAt: yesterday,
      createdAt: yesterday,
    },
    {
      // 篮球：卖家 buyerB × 买家 buyerC —— transactionBasketball 的三元组。
      id: ids.conversationBasketball,
      listingId: ids.listingBasketball,
      buyerId: ids.buyerC,
      sellerId: ids.buyerB,
      buyerLastReadAt: lastWeek,
      lastMessageAt: lastWeek,
      createdAt: lastWeek,
    },
  ])

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
    {
      // 台灯会话：交易被接受时必有的 tx.accepted SYSTEM 消息（真实链路由 accept 写入，
      // content 形状与 transactionSystemEventSchema 一致，前端聊天页才能解析出跳转）。
      id: ids.messageLampAccepted,
      conversationId: ids.conversationLamp,
      senderId: null,
      type: 'SYSTEM',
      content: JSON.stringify({
        type: 'tx.accepted',
        transactionId: ids.transactionLamp,
        amountCents: 2800,
      }),
      createdAt: yesterday,
    },
    {
      // 篮球会话：已 COMPLETED 交易的 tx.accepted 历史消息。
      id: ids.messageBasketballAccepted,
      conversationId: ids.conversationBasketball,
      senderId: null,
      type: 'SYSTEM',
      content: JSON.stringify({
        type: 'tx.accepted',
        transactionId: ids.transactionBasketball,
        amountCents: 5000,
      }),
      createdAt: lastWeek,
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
  // seed **刻意不投 EMBED_* job**（补向量是 M4 backfill 的事，不是 seed 漏投），所以第一遍
  // MATCH_LISTING 跑的时候这对实体还没有向量：引擎按 #322 M2 的降级契约走 v1 口径
  // （semantic_score = NULL、ranking_version = 1）并**补投目标实体的** EMBED_LISTING；
  // EMBED 结算成功后（#322 M4 复审修复：入队序 ≠ 执行序）会再补投一条 MATCH_LISTING，
  // 于是第二遍是带着目标向量重算的。但这一对的终态**仍是 v1/100**：v2 要求两侧都有新鲜向量，
  // 而这里只补投了商品侧，愿望侧始终没有向量（没有 MATCH_WISH job）——`core:smoke` 钉的就是这个终态。
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
