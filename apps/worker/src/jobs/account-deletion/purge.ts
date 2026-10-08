/**
 * 账号注销冷静期到期后的去标识化（#464）。
 *
 * ## 为什么是 worker 的周期任务，不走 jobs 队列
 *
 * 队列（`jobs` 表）适合「一次业务动作派生一件必须完成的事」；注销到期不同：它是**批量扫描
 * 一张表上到点的行**，天然是「每轮把到点的都处理掉」，漏一轮下一轮自然补上，不需要
 * 逐条登记、退避与失败重投（`jobs` 的重试语义在这里只会让一个已经不可逆的操作被重复尝试）。
 * 仓库里同形状的先例是浏览足迹清理与推荐清理（`view-history/cleanup.ts` 等）。
 *
 * ## 为什么资格要在这里再查一遍
 *
 * 申请时已经查过「无未完成交易」，但那一步只能锁住**卖家一侧**的商品行（见
 * `apps/api/src/modules/account-deletion/store.ts` 的竞态说明）：买家在一笔别人商品的交易里，
 * 那件商品不是他的，注销流程锁不到它。所以从申请到到期的 7 天里，可能新出现一笔把注销人列为
 * 买家的待面交交易。去标识化不可逆，所以这里**再查一次**：有未完成交易就**推迟**（保持
 * `DELETION_REQUESTED` 不动，下一轮再看），而不是先把人删了再补救。
 *
 * 推迟意味着账号会停在「写全禁 + 商品已下架」的状态，直到那笔交易完成或取消。这是刻意的：
 * 交易证据必须完整（#464 验收：必要审计与交易证据不被误删），而账号状态本身在库里可查、
 * 端上也能看到倒计时已过 —— 比删掉交易对手的凭据要好。
 *
 * ## 幂等与并发
 *
 * 每个用户一个事务，开头 `SELECT … FOR UPDATE` 锁账号行并复核状态与到期时刻：跑两遍
 * （或两个 worker 同时跑）时第二遍看到的是 `DELETED`，直接 `skipped`，不会重复去标识化或
 * 重复写审计。用户在这期间撤回申请（`DELETE /me/account-deletion`）也会被这把行锁串行化。
 */
import { DELETED_ACCOUNT_NICKNAME } from '@fish/contracts/account-deletion/schema'
import type { Db } from '@fish/db/client'
import { adminAuditLogs } from '@fish/db/schema/admin'
import { aiPolishRequests } from '@fish/db/schema/ai-polish-requests'
import { favorites } from '@fish/db/schema/favorites'
import { feedback } from '@fish/db/schema/feedback'
import { follows } from '@fish/db/schema/follows'
import { listings } from '@fish/db/schema/listings'
import { loginTickets } from '@fish/db/schema/login-tickets'
import { notifications } from '@fish/db/schema/notifications'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { recommendationRequests } from '@fish/db/schema/recommendation-requests'
import { sessions } from '@fish/db/schema/sessions'
import { transactions } from '@fish/db/schema/transactions'
import { userInterestProfiles } from '@fish/db/schema/user-interest-profiles'
import { users, wechatIdentities } from '@fish/db/schema/users'
import { campusEmailVerifications } from '@fish/db/schema/verifications'
import { listingViewHistory } from '@fish/db/schema/view-history'
import { wishes } from '@fish/db/schema/wishes'
import { and, asc, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'

/** 一轮最多处理几个账号：注销是低频动作，批量只为「积压时不长时间占连接」。 */
export const ACCOUNT_DELETION_PURGE_BATCH_SIZE = 50

/** 去标识化各步的计数：写进审计日志的 `after`，也是运行态验收的证据。 */
export interface AccountDeletionPurgeCounts {
  /** 撤销全部剩余会话（申请时保留了当前设备，这一刀把它也撤了）。 */
  sessions: number
  wechatIdentities: number
  campusEmailVerifications: number
  loginTickets: number
  favorites: number
  follows: number
  viewHistory: number
  notifications: number
  interestProfiles: number
  aiPolishRequests: number
  /** 未完成的许愿置 `CLOSED`（不硬删：`matches` 对 wishes 是级联，硬删会带走撮合记录）。 */
  wishesClosed: number
  /** 兜底下架（申请时已下架；这里覆盖申请后被并发改回在架的行）。 */
  listingsOfflined: number
  recommendationRequestsDetached: number
  recommendationEventsDetached: number
  /** 意见反馈（#463）里自愿留的联系方式置空；反馈正文与处理记录保留（运营与审计证据）。 */
  feedbackContactsCleared: number
}

export type AccountDeletionPurgeOutcome =
  | { kind: 'purged'; userId: string; counts: AccountDeletionPurgeCounts }
  /** 出现了把注销人算作买家的待面交交易：保持原状，下一轮再看。 */
  | { kind: 'deferred-pending-transaction'; userId: string; blockingTransactions: number }
  /** 到扫描时状态已经变了（撤回 / 已被处理 / 未到点）：什么都不做。 */
  | { kind: 'skipped'; userId: string; accountStatus: string }

export interface AccountDeletionPurgeResult {
  purged: number
  deferred: number
  skipped: number
  outcomes: AccountDeletionPurgeOutcome[]
}

/**
 * 一个账号的去标识化，全在一个事务里（要么整份生效，要么完全不动）。
 *
 * 「原地去标识化」的边界（冻结口径 Q5 / Q8）：**改 users 行本身**让全部读模型自动显示
 * 占位昵称（`nickname` 是 notNull，不能置空 —— 原地改写是零跨模块改动的唯一路径），
 * 同时**硬删**本人的私域数据，历史交易 / 留言 / 会话 / 评价原样保留（外键不断、证据不丢）。
 */
async function purgeOne(db: Db, userId: string, now: Date): Promise<AccountDeletionPurgeOutcome> {
  return db.transaction(async (tx) => {
    // ① 锁账号行并复核：仍在冷静期且已到点。撤回 / 已处理 / 被提前调度都会在这里被看见。
    const locked = await tx
      .select({ accountStatus: users.accountStatus, purgeScheduledAt: users.purgeScheduledAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for('update')
    const row = locked[0]
    // `row?.accountStatus !== 'DELETION_REQUESTED'` 同时覆盖「行不存在」（undefined ≠ 该值）。
    if (row?.accountStatus !== 'DELETION_REQUESTED') {
      return { kind: 'skipped' as const, userId, accountStatus: row?.accountStatus ?? 'MISSING' }
    }
    if (row.purgeScheduledAt && row.purgeScheduledAt.getTime() > now.getTime()) {
      return { kind: 'skipped' as const, userId, accountStatus: row.accountStatus }
    }

    // ② 复查未完成交易（见文件头「为什么资格要在这里再查一遍」）。买 / 卖任一侧都算。
    const blocking = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.status, 'PENDING_MEETUP'),
          or(eq(transactions.buyerId, userId), eq(transactions.sellerId, userId)),
        ),
      )
    if (blocking.length > 0) {
      return {
        kind: 'deferred-pending-transaction' as const,
        userId,
        blockingTransactions: blocking.length,
      }
    }

    // ③ 硬删本人私域数据。这些表对 users 是 cascade，但这里逐表显式删并计数 —— 审计的
    //    `after` 要能回答「删了什么」，而不是只说「他注销了」。逐条写全而非抽 helper：
    //    「删哪张表、按哪一列」正是审计与审查时要一眼看清的东西。
    const counts: AccountDeletionPurgeCounts = {
      sessions: (
        await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id })
      ).length,
      wechatIdentities: (
        await tx
          .delete(wechatIdentities)
          .where(eq(wechatIdentities.userId, userId))
          .returning({ id: wechatIdentities.id })
      ).length,
      campusEmailVerifications: (
        await tx
          .delete(campusEmailVerifications)
          .where(eq(campusEmailVerifications.userId, userId))
          .returning({ id: campusEmailVerifications.id })
      ).length,
      // 登录票据按 `bound_user_id` 关联（签到换会话的中间态）。
      loginTickets: (
        await tx
          .delete(loginTickets)
          .where(eq(loginTickets.boundUserId, userId))
          .returning({ id: loginTickets.id })
      ).length,
      favorites: (
        await tx
          .delete(favorites)
          .where(eq(favorites.userId, userId))
          .returning({ id: favorites.id })
      ).length,
      // 关注是双向的：注销人关注别人、别人关注注销人都随账号消失。
      follows: (
        await tx
          .delete(follows)
          .where(or(eq(follows.followerId, userId), eq(follows.followingId, userId)))
          .returning({ id: follows.id })
      ).length,
      viewHistory: (
        await tx
          .delete(listingViewHistory)
          .where(eq(listingViewHistory.userId, userId))
          .returning({ id: listingViewHistory.id })
      ).length,
      notifications: (
        await tx
          .delete(notifications)
          .where(eq(notifications.userId, userId))
          .returning({ id: notifications.id })
      ).length,
      interestProfiles: (
        await tx
          .delete(userInterestProfiles)
          .where(eq(userInterestProfiles.userId, userId))
          .returning({ id: userInterestProfiles.id })
      ).length,
      // 只存配额与质量指标、不含用户文本，但仍是「这个人的请求记录」，一并硬删。
      aiPolishRequests: (
        await tx
          .delete(aiPolishRequests)
          .where(eq(aiPolishRequests.userId, userId))
          .returning({ id: aiPolishRequests.id })
      ).length,
      // ④ 未完成的许愿置 CLOSED：**不硬删** —— `matches` 对 wishes 是 cascade，硬删会连带
      //    带走撮合记录；许愿内容去标识化后由昵称占位承担匿名。
      wishesClosed: (
        await tx
          .update(wishes)
          .set({ status: 'CLOSED' })
          .where(and(eq(wishes.userId, userId), eq(wishes.status, 'ACTIVE')))
          .returning({ id: wishes.id })
      ).length,
      // ⑤ 兜底下架：申请时已下架过；这里覆盖「申请后又被改回在架」的边界（正常路径不会
      //    发生，因为冷静期内写全禁，但外部运维 SQL 绕得过 API）。
      listingsOfflined: (
        await tx
          .update(listings)
          .set({ status: 'OFFLINE', updatedAt: now })
          .where(
            and(eq(listings.sellerId, userId), inArray(listings.status, ['ACTIVE', 'RESERVED'])),
          )
          .returning({ id: listings.id })
      ).length,
      // ⑥ 运营数据断关联而不是删除（表注释已写明「注销后置空」）：请求上下文 / 事件行的
      //    保留期与账号无关，删掉会破坏指标口径。
      //    `recommendation_requests` 有一条 CHECK：user_id 与 anonymous_session_id 不能全空，
      //    所以置空 user_id 的同时给缺匿名会话 id 的行补一个（补 id 而不是删行，行仍是
      //    「一次推荐请求」，只是失去了身份）。
      recommendationRequestsDetached: (
        await tx
          .update(recommendationRequests)
          .set({
            userId: null,
            anonymousSessionId: sql`coalesce(${recommendationRequests.anonymousSessionId}, uuidv7())`,
          })
          .where(eq(recommendationRequests.userId, userId))
          .returning({ id: recommendationRequests.id })
      ).length,
      recommendationEventsDetached: (
        await tx
          .update(recommendationEvents)
          .set({ userId: null })
          .where(eq(recommendationEvents.userId, userId))
          .returning({ id: recommendationEvents.id })
      ).length,
      // ⑥' 反馈里的联系方式是本人主动给的个人信息，随注销清掉；正文与回复留作处理记录，
      //    提交人改由占位昵称承担匿名（同留言 / 评价的取舍）。
      feedbackContactsCleared: (
        await tx
          .update(feedback)
          .set({ contact: null })
          .where(and(eq(feedback.userId, userId), isNotNull(feedback.contact)))
          .returning({ id: feedback.id })
      ).length,
    }

    // ⑦ 原地去标识化 users 行。这是「历史引用统一显示『已注销用户』」的实现：所有读模型
    //    （商品卡 / 留言 / 聊天 / 评价 / 主页）都只读 nickname，改这里就全覆盖了。
    //    登录凭据一并断掉：student_no / password_hash / campus_email / phone 全部置空，
    //    于是学号、校园邮箱、手机号三个唯一键被释放，可以立刻用同一身份重新注册一个全新
    //    账号（冻结口径 Q9）。role 降级为 USER：已注销账号不该再保有任何管理员权限。
    //    两个时间戳必须置空 —— CHECK 约束要求它们与 `DELETION_REQUESTED` 同进同出，
    //    「什么时候申请的、什么时候执行的」记在下面的审计行里。
    await tx
      .update(users)
      .set({
        nickname: DELETED_ACCOUNT_NICKNAME,
        avatarUrl: null,
        signature: null,
        studentNo: null,
        passwordHash: null,
        campusEmail: null,
        phone: null,
        authStatus: 'UNVERIFIED',
        verifiedAt: null,
        role: 'USER',
        accountStatus: 'DELETED',
        deletionRequestedAt: null,
        purgeScheduledAt: null,
        updatedAt: now,
      })
      .where(eq(users.id, userId))

    // ⑧ 系统审计行：actor 为空（系统动作），只记状态与计数，不记任何原始资料（#73 约定）。
    await tx.insert(adminAuditLogs).values({
      actorUserId: null,
      action: 'ACCOUNT_DELETION_COMPLETED',
      targetType: 'USER',
      targetId: userId,
      before: { accountStatus: 'DELETION_REQUESTED' },
      after: { accountStatus: 'DELETED', counts },
      reason: '账号注销冷静期到期，系统执行去标识化',
      requestId: null,
    })

    return { kind: 'purged' as const, userId, counts }
  })
}

/**
 * 处理所有到点的注销申请。返回本轮各账号的结果，供 worker 记日志与验收取数。
 *
 * 先扫 id 再逐个开事务（而不是一个大事务）：一个账号卡住 / 失败不应该连累其它账号，
 * 而每个账号内部又必须是原子的。扫描用 `users_purge_scheduled_at_idx`（部分索引，
 * 只覆盖 `DELETION_REQUESTED`），到点的行数天然很小。
 */
export async function purgeDueAccountDeletions(input: {
  db: Db
  now: Date
  limit?: number
}): Promise<AccountDeletionPurgeResult> {
  const limit = input.limit ?? ACCOUNT_DELETION_PURGE_BATCH_SIZE
  const due = await input.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(eq(users.accountStatus, 'DELETION_REQUESTED'), lte(users.purgeScheduledAt, input.now)),
    )
    .orderBy(asc(users.purgeScheduledAt))
    .limit(limit)

  const outcomes: AccountDeletionPurgeOutcome[] = []
  for (const row of due) {
    outcomes.push(await purgeOne(input.db, row.id, input.now))
  }

  return {
    purged: outcomes.filter((outcome) => outcome.kind === 'purged').length,
    deferred: outcomes.filter((outcome) => outcome.kind === 'deferred-pending-transaction').length,
    skipped: outcomes.filter((outcome) => outcome.kind === 'skipped').length,
    outcomes,
  }
}
