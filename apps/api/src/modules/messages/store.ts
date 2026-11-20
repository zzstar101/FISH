import type { MessageVisibility } from '@fish/contracts/chat/schema'
import type { Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { sql } from 'drizzle-orm'
import type { ModerationProviderName, ModerationSuggestion } from '../moderation/providers/types'
import type { ModerationDecision } from '../moderation/types'
import {
  MessageIdempotencyConflictError,
  type MessageSendKey,
  sendKeyLockQuery,
} from './idempotency'

export interface MessageRow {
  id: string
  conversation_id: string
  sender_id: string | null
  type: string
  content: string
  /** #359 3c 引用的被引用消息 id；无引用为 null。 */
  reply_to_id?: string | null
  /** #359 3c 撤回时间；未撤回为 null。 */
  recalled_at?: Date | string | null
  created_at: Date | string
  /** join 出的发送者公开信息；SYSTEM 消息为 null。仅 listByConversation 填充。 */
  sender_nickname?: string | null
  sender_avatar_url?: string | null
  /** #694 M1：DELIVERED 才进接收者读路径；旧行由 DB 默认值补齐。 */
  visibility: MessageVisibility
}

/** 引用块投射需要的被引用行（#359 3c）。 */
export interface ReplyTargetRow {
  id: string
  /** 引用目标必须与本会话一致（跨会话 id 不可引用，也不泄漏存在性）。 */
  conversation_id: string
  sender_id: string | null
  type: string
  content: string
  recalled_at: Date | string | null
}

/** 会话参与者的最小投影（权限判定用）。 */
export interface ConversationParticipant {
  id: string
  buyerId: string
  sellerId: string
}

/** #694 M1 审核结论的审计快照；与消息行同事务写入 `chat_moderation_records`。 */
export interface ChatModerationRecordInput {
  kind: 'TEXT' | 'IMAGE' | 'VOICE'
  decision: ModerationDecision
  machineDecision: ModerationDecision
  status: 'PENDING' | 'SETTLED'
  provider: ModerationProviderName
  providerRequestId: string | null
  policyVersion: string
  suggestion: ModerationSuggestion
  label: string | null
  subLabel: string | null
  score: number | null
  matchedRules: string[]
  matchedTermsMasked: string[]
}

/**
 * 可选的插入参数：TEXT / LISTING 共用；LISTING 不审核，因此不传 moderation。
 *
 * 用判别联合而不是「两个可选字段」：待审/被拒的行**必须**同一事务写入审核记录，
 * 否则它会变成一条永远不进人工队列、也永远不会被放行的隐藏消息。DELIVERED 可以
 * 带 SETTLED 记录（机器 ALLOW），也可以不带（LISTING/SYSTEM）。
 */
export type InsertUserMessageOptions =
  | {
      key?: MessageSendKey | null
      replyToId?: string | null
      visibility?: 'DELIVERED'
      moderation?: ChatModerationRecordInput | null
    }
  | {
      key?: MessageSendKey | null
      replyToId?: string | null
      visibility: 'PENDING_REVIEW' | 'REJECTED'
      moderation: ChatModerationRecordInput
    }

export interface MessageStore {
  findConversationForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationParticipant | null>
  /**
   * 取一页消息：ASC 返回；`before` 游标先在本会话内解析出 created_at（找不到返回
   * 'invalid-cursor'，由 service 报 422，防止伪造 uuid 变成 500）。
   */
  listByConversation(
    conversationId: string,
    /** `viewerId` 用于过滤未投递消息：#694 M1 规定接收者只读 DELIVERED。 */
    filter: { limit: number; before: string | null; viewerId: string },
  ): Promise<{ kind: 'ok'; rows: MessageRow[] } | { kind: 'invalid-cursor' }>
  /**
   * 插入 TEXT 消息并 bump 会话的 `last_message_at`（同一事务，两写必须原子）。
   *
   * 带 `key` 时启用 #67 发送幂等：同键同指纹 → 返回**既有**消息（不新增行）；同键不同
   * 指纹 → 抛 `MessageIdempotencyConflictError`。查重与插入在同一事务里，串行化见
   * `sendKeyLockQuery`。
   */
  insertText(
    conversationId: string,
    senderId: string,
    content: string,
    options?: InsertUserMessageOptions,
  ): Promise<MessageRow>
  /**
   * 按内部 uuid 批量取引用块投射需要的行（#359 3c）。缺失的 id 不在返回 Map 里
   * （行被并发删除），调用方按「引用已失效」渲染。
   *
   * #694 M1：只返回 **DELIVERED** 的行。引用摘录会在发送路径里被投影一次然后广播给
   * 会话双方，如果允许引用自己待审的消息，摘录就会把未过审正文带给接收者；因此
   * 「引用目标必须已投递」在存储层统一收口，引用校验、列表富化、媒体富化共用这一条。
   */
  findReplyTargets(ids: string[]): Promise<Map<string, ReplyTargetRow>>
  /**
   * 幂等键查询（**只读、不在事务内**）：命中时返回既有行与指纹是否一致。
   *
   * service 在**引用目标校验之前**调它，让「第一次已落库、响应丢了」的重试直接重放既有行
   * —— 否则那条重试会因为「被引用消息此刻已撤回」撞 422，而消息其实早就发出去了
   * （媒体域 `media-store.ts` 的 `findByRequestKey` 是同一套快速路径）。
   *
   * 这只是**快速路径**，不是去重的权威判据：真正的串行化仍由 `insertText` 事务内的
   * advisory lock + 查重承担（本查询命中不了未提交的并发行）。
   */
  findByRequestKey(
    conversationId: string,
    senderId: string,
    key: MessageSendKey,
  ): Promise<{ row: MessageRow; matchedHash: boolean } | null>
  /**
   * 撤回（#359 3c）：把 `recalled_at` 从 NULL 单调推进为 now，返回撤回后的行。
   *
   * 返回 `'not-found'`：消息不在本会话；`'forbidden'`：不是发送者（含 SYSTEM，
   * 它的 sender_id 为 NULL）；`'window-exceeded'`：超出窗口。已撤回的行**幂等返回**，
   * 不刷新时间戳（重复点撤回不该把「撤回时刻」往后挪）。
   */
  recall(
    conversationId: string,
    messageId: string,
    userId: string,
    windowMs: number,
  ): Promise<MessageRow | 'not-found' | 'forbidden' | 'window-exceeded'>
  /**
   * 插入 LISTING 消息（#359 商品卡）并 bump 会话的 `last_message_at`：与 `insertText`
   * 同一事务结构、同一幂等语义（同键同指纹 → 重放，同键不同指纹 → 冲突）。
   *
   * `content` 存商品的**公开 id**：它是引用不是用户正文，因此不参与 SYSTEM 的内容投射。
   */
  insertListing(
    conversationId: string,
    senderId: string,
    listingPublicId: string,
    key?: MessageSendKey | null,
  ): Promise<MessageRow>
  /**
   * 按内部 uuid 批量取 LISTING 消息富化用的商品最小投射（#359）；缺失的 id 不出现在返回
   * Map 里（调用方按「商品已被删除」处理）。一次查询覆盖整页，避免按条 N+1。
   */
  findListingBriefs(ids: string[]): Promise<Map<string, ListingBrief>>
  /**
   * 幂等键的**只读**查询（#359）：发送前先看这个键是否已经落过消息，好在校验商品可见性
   * **之前**给出「重放 / 409」的结论 —— 否则「同一个键换了商品」会被 404 抢先，
   * 「商品已下架后的重试」也会错误地报 404 而不是重放既有消息。
   *
   * 真正的并发安全仍由 `insertText` / `insertListing` 在事务内的 advisory lock + 查重兜住；
   * 这里只是决定错误顺序，不承担去重职责。
   */
  findMessageByRequestKey(
    conversationId: string,
    senderId: string,
    key: MessageSendKey,
  ): Promise<{ row: MessageRow; hashMatches: boolean } | null>
  /**
   * 服务端写入 SYSTEM 消息（#11 的交易提案/接受/拒绝）：无发送者，事务内 bump
   * last_message_at。不对客户端暴露——只有同属服务端的 domain 模块调用。
   */
  insertSystem(conversationId: string, content: string): Promise<MessageRow>
}

/** LISTING 消息卡片投射所需的最小行（#359）；两个状态列的取值域由契约收窄。 */
export interface ListingBrief {
  id: string
  title: string
  priceCents: number
  status: string
  /** 公开可见性的第二道闸（与 feed / 公开在售列表同口径，见 users/store.ts 的在售统计）。 */
  moderationStatus: string | null
  /** 封面 objectKey；无图商品为 null（URL 由 service 经注入的 MediaStorage 拼）。 */
  coverObjectKey: string | null
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}

function toRow(row: Record<string, unknown>): MessageRow {
  return {
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    sender_id: (row.sender_id as string | null) ?? null,
    type: row.type as string,
    content: row.content as string,
    reply_to_id: (row.reply_to_id as string | null) ?? null,
    recalled_at: (row.recalled_at as Date | string | null) ?? null,
    created_at: row.created_at as Date | string,
    sender_nickname: (row.sender_nickname as string | null) ?? null,
    sender_avatar_url: (row.sender_avatar_url as string | null) ?? null,
    visibility: visibilityOf(row),
  }
}

/**
 * 行必须显式选取 visibility（#694 M1）：默认成 DELIVERED 会让「漏选该列」的查询在未来
 * fail-open —— 一条待审消息会被当成已投递。缺失即报错，让漏改在开发/测试期炸掉。
 */
function visibilityOf(row: Record<string, unknown>): MessageVisibility {
  const value = row.visibility
  if (value === 'DELIVERED' || value === 'PENDING_REVIEW' || value === 'REJECTED') return value
  throw new Error('消息行缺少合法的 visibility 列：查询必须显式选取 m.visibility')
}

/**
 * 幂等键命中查询（只应在持有该键 advisory lock 的事务内调用）。
 *
 * `hashMatches=false` 表示「同键不同内容」，由调用方报 409；`null` 表示键未被使用。
 * 指纹在 SQL 里比较而不是取回 JS，省一次往返也少一个时序窗口。
 */
async function findByRequestKey(
  executor: Pick<Db, 'execute'>,
  conversationId: string,
  senderId: string,
  key: MessageSendKey,
): Promise<{ row: Record<string, unknown>; hashMatches: boolean } | null> {
  const result = await executor.execute(sql`
    SELECT m.id, m.conversation_id, m.sender_id, m.type::text, m.content, m.created_at,
           m.reply_to_id, m.recalled_at, m.visibility::text AS visibility,
           u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url,
           (m.client_request_hash = ${key.requestHash}) AS hash_matches
    FROM messages m
    LEFT JOIN users u ON u.id = m.sender_id
    WHERE m.conversation_id = ${conversationId}::uuid
      AND m.sender_id = ${senderId}::uuid
      AND m.client_request_id = ${key.clientRequestId}
  `)
  const row = rowsOf(result)[0]
  return row ? { row, hashMatches: row.hash_matches === true } : null
}

export function createSqlMessageStore(db: Db): MessageStore {
  return {
    async findConversationForUser(conversationId, userId) {
      const result = await db.execute(sql`
        SELECT id, buyer_id, seller_id FROM conversations
        WHERE id = ${conversationId} AND ${userId} IN (buyer_id, seller_id)
      `)
      const row = rowsOf(result)[0]
      return row
        ? {
            id: row.id as string,
            buyerId: row.buyer_id as string,
            sellerId: row.seller_id as string,
          }
        : null
    },

    async listByConversation(conversationId, { limit, before, viewerId }) {
      let cursorCreatedAt: string | undefined
      if (before) {
        // 游标消息必须属于本会话：跨会话的合法 uuid 也不能当作分页起点。
        // 与主查询一致，MEDIA 消息不能作为文本分页锚点（fix-plan F8）；未投递消息
        // 也不能当锚点——接收者看不到它，用它分页等于确认它存在。
        const cursorResult = await db.execute(sql`
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
          FROM messages WHERE id = ${before}::uuid AND conversation_id = ${conversationId}::uuid
            AND type <> 'MEDIA'
            AND (visibility = 'DELIVERED' OR sender_id = ${viewerId}::uuid)
        `)
        const cursorRow = rowsOf(cursorResult)[0]
        if (!cursorRow) return { kind: 'invalid-cursor' }
        cursorCreatedAt = cursorRow.ts as string
      }

      // 先按 DESC 取 limit+1 判断"还有没有更早的"，再反转成 ASC 返回
      // （契约：升序给前端、nextCursor 指向更早一页）。
      const condition = before
        ? sql`AND (m.created_at, m.id) < (${cursorCreatedAt}::timestamptz, ${before}::uuid)`
        : sql``
      const result = await db.execute(sql`
        SELECT m.id, m.conversation_id, m.sender_id, m.type::text, m.content, m.created_at,
               m.reply_to_id, m.recalled_at, m.visibility::text AS visibility,
               u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${conversationId}::uuid
          AND m.type <> 'MEDIA'
          AND (m.visibility = 'DELIVERED' OR m.sender_id = ${viewerId}::uuid)
          ${condition}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${limit + 1}
      `)
      return { kind: 'ok', rows: rowsOf(result).map(toRow).reverse() }
    },

    /**
     * 插入 TEXT 消息并 bump 会话的 `last_message_at`（同一事务，两写必须原子）。
     *
     * `GREATEST(...)` 不是多余的防御：`created_at` 取 `defaultNow()` = **事务开始时间**，
     * 因此「早开始、晚拿到会话行锁」的事务会用更旧的时间戳覆盖新值，让会话在列表里
     * 位置倒退、游标分页出错。READ COMMITTED 下被阻塞的 UPDATE 会基于最新已提交版本
     * 重算表达式，所以 GREATEST 足以保证 `last_message_at` 只前进、不回退。
     *
     * 幂等键路径：先拿该键的 advisory lock 再查重，两个并发同键请求因此串行 —— 第二个
     * 读到第一个已提交的行并直接返回，不会撞唯一索引变成 500。
     */
    async insertText(conversationId, senderId, content, options) {
      return insertUserMessage(db, conversationId, senderId, 'TEXT', content, options)
    },

    async insertListing(conversationId, senderId, listingPublicId, key) {
      return insertUserMessage(db, conversationId, senderId, 'LISTING', listingPublicId, {
        key,
      })
    },

    async findListingBriefs(ids) {
      const briefs = new Map<string, ListingBrief>()
      if (ids.length === 0) return briefs
      const result = await db.execute(sql`
        SELECT l.id, l.title, l.price_cents, l.status::text, l.moderation_status::text,
               li.object_key AS cover_object_key
        FROM listings l
        LEFT JOIN listing_images li ON li.listing_id = l.id AND li.sort_order = 0
        WHERE l.id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
      `)
      for (const row of rowsOf(result)) {
        briefs.set(row.id as string, {
          id: row.id as string,
          title: row.title as string,
          priceCents: Number(row.price_cents),
          status: row.status as string,
          moderationStatus: (row.moderation_status as string | null) ?? null,
          coverObjectKey: (row.cover_object_key as string | null) ?? null,
        })
      }
      return briefs
    },

    async findMessageByRequestKey(conversationId, senderId, key) {
      const found = await findByRequestKey(db, conversationId, senderId, key)
      return found ? { row: toRow(found.row), hashMatches: found.hashMatches } : null
    },

    async findByRequestKey(conversationId, senderId, key) {
      const result = await db.execute(sql`
        SELECT m.id, m.conversation_id, m.sender_id, m.type::text, m.content, m.created_at,
               m.reply_to_id, m.recalled_at, m.visibility::text AS visibility,
               u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url,
               (m.client_request_hash = ${key.requestHash}) AS hash_matches
        FROM messages m
        LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.conversation_id = ${conversationId}::uuid
          AND m.sender_id = ${senderId}::uuid
          AND m.client_request_id = ${key.clientRequestId}
      `)
      const row = rowsOf(result)[0]
      return row ? { row: toRow(row), matchedHash: row.hash_matches === true } : null
    },

    async findReplyTargets(ids) {
      const map = new Map<string, ReplyTargetRow>()
      if (ids.length === 0) return map
      const result = await db.execute(sql`
        SELECT id, conversation_id, sender_id, type::text, content, recalled_at
        FROM messages
        WHERE id IN (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
          AND visibility = 'DELIVERED'
      `)
      for (const row of rowsOf(result)) {
        map.set(row.id as string, {
          id: row.id as string,
          conversation_id: row.conversation_id as string,
          sender_id: (row.sender_id as string | null) ?? null,
          type: row.type as string,
          content: row.content as string,
          recalled_at: (row.recalled_at as Date | string | null) ?? null,
        })
      }
      return map
    },

    async recall(conversationId, messageId, userId, windowMs) {
      /*
       * 单语句完成「校验 + 推进」，避免「读出来再写回去」的竞态：
       * - 目标行必须在本会话（`conversation_id`）——跨会话的合法 id 一律 not-found，
       *   不泄漏其它会话的消息是否存在；
       * - 只有发送者本人可撤回（`sender_id = userId`；SYSTEM 的 sender_id 为 NULL，
       *   条件天然不成立，落进 forbidden）；
       * - 窗口按**数据库时钟**判（`clock_timestamp() - created_at`），不信客户端时间；
       * - `recalled_at = COALESCE(recalled_at, now())`：已撤回的行幂等命中原值，
       *   重复点撤回不会把「撤回时刻」往后挪。
       * 找不到行时 `RETURNING` 为空，再用一条只读查询区分 not-found / forbidden /
       * window-exceeded，把错误码说清楚。
       */
      const updated = await db.execute(sql`
        UPDATE messages SET recalled_at = COALESCE(recalled_at, now())
        WHERE id = ${messageId}::uuid
          AND conversation_id = ${conversationId}::uuid
          AND sender_id = ${userId}::uuid
          AND (
            recalled_at IS NOT NULL
            OR clock_timestamp() - created_at <= make_interval(secs => ${windowMs / 1000})
          )
        RETURNING id, conversation_id, sender_id, type::text, content, created_at,
                  reply_to_id, recalled_at, visibility::text AS visibility
      `)
      const row = rowsOf(updated)[0]
      if (row) return toRow(row)

      const probe = await db.execute(sql`
        SELECT sender_id, recalled_at,
               (clock_timestamp() - created_at) > make_interval(secs => ${windowMs / 1000})
                 AS outside_window
        FROM messages
        WHERE id = ${messageId}::uuid AND conversation_id = ${conversationId}::uuid
      `)
      const target = rowsOf(probe)[0]
      if (!target) return 'not-found'
      if (target.sender_id !== userId) return 'forbidden'
      if (target.outside_window === true) return 'window-exceeded'
      return 'not-found'
    },

    async insertSystem(conversationId, content) {
      // 与 insertText 同构，仅 sender 为 NULL（DB CHECK 只约束 TEXT 必须有发送者）。
      return db.transaction((tx) => insertSystemWithin(tx, conversationId, content))
    },
  }
}

/**
 * 用户发出的消息（TEXT / LISTING，#359）共用的插入路径。
 *
 * 两者的事务结构、幂等语义（advisory lock → 查重 → 插入）、`last_message_at` bump 完全一致，
 * 只有 `type` 与 content 的语义不同（用户正文 vs 商品引用）。抽出来是为了让 #359 不必复制
 * 一份带幂等的 SQL —— 复制品一旦漂移，两条通道的「重试 / 幂等键复用」行为就会分叉。
 */
async function insertUserMessage(
  db: Db,
  conversationId: string,
  senderId: string,
  type: 'TEXT' | 'LISTING',
  content: string,
  options: InsertUserMessageOptions = {},
): Promise<MessageRow> {
  const { key = null, replyToId = null, visibility = 'DELIVERED', moderation = null } = options
  // 运行时不变量：类型层只挡住本仓库的调用方，挡不住 JSON/脚本直插；这条守卫让
  // 「PENDING_REVIEW 却没有审核记录」在写路径上直接失败，而不是留一条孤儿隐藏行。
  if (visibility !== 'DELIVERED' && !moderation) {
    throw new Error(`消息可见性 ${visibility} 必须同时写入审核记录`)
  }
  if (moderation && (moderation.status === 'PENDING') !== (visibility === 'PENDING_REVIEW')) {
    throw new Error(`消息可见性 ${visibility} 与审核记录状态 ${moderation.status} 不一致`)
  }
  return db.transaction(async (tx) => {
    if (key) {
      await tx.execute(sendKeyLockQuery(conversationId, senderId, key.clientRequestId))
      const existing = await findByRequestKey(tx, conversationId, senderId, key)
      if (existing) {
        if (existing.hashMatches) return toRow(existing.row)
        throw new MessageIdempotencyConflictError(key.clientRequestId)
      }
    }
    const result = await tx.execute(sql`
      WITH msg AS (
        INSERT INTO messages
          (id, conversation_id, sender_id, type, content, client_request_id,
           client_request_hash, reply_to_id, visibility)
        VALUES (
          ${newId()}, ${conversationId}::uuid, ${senderId}::uuid, ${type}, ${content},
          ${key?.clientRequestId ?? null}, ${key?.requestHash ?? null},
          ${replyToId ?? null}::uuid, ${visibility}::message_visibility
        )
        RETURNING *
      )
      SELECT msg.id, msg.conversation_id, msg.sender_id, msg.type::text, msg.content,
             msg.created_at, msg.reply_to_id, msg.recalled_at,
             msg.visibility::text AS visibility,
             u.nickname AS sender_nickname, u.avatar_url AS sender_avatar_url
      FROM msg
      LEFT JOIN users u ON u.id = msg.sender_id
    `)
    const row = rowsOf(result)[0]
    if (!row) throw new Error('消息插入失败：会话可能已被并发删除')
    const inserted = toRow(row)

    /*
     * 只有已投递的消息才推进会话的 `last_message_at`（#694 M1）：
     * 待审消息若 bump，接收者的会话列表会因为它跳到最前，通过「最后消息摘要」间接泄露
     * 一条本不该存在的内容（以及未读红点）。
     */
    if (visibility === 'DELIVERED') {
      await tx.execute(sql`
        UPDATE conversations c SET
          last_message_at = GREATEST(c.last_message_at, ${inserted.created_at}::timestamptz),
          updated_at = now()
        WHERE c.id = ${conversationId}::uuid
      `)
    }

    /*
     * 审核结论与消息**同事务**落库：事务回滚时两者一起消失，人工复核队列与消息状态
     * 不会出现「有结论没有消息」或反过来的半写。
     */
    if (moderation) {
      await tx.execute(sql`
        INSERT INTO chat_moderation_records
          (id, message_id, conversation_id, sender_id, kind, decision, machine_decision,
           status, provider, provider_request_id, policy_version, suggestion, label,
           sub_label, score, matched_rules, matched_terms_masked)
        VALUES (
          ${newId()}, ${inserted.id}::uuid, ${conversationId}::uuid, ${senderId}::uuid,
          ${moderation.kind}::chat_moderation_kind,
          ${moderation.decision}::moderation_decision,
          ${moderation.machineDecision}::moderation_decision,
          ${moderation.status}::chat_moderation_status,
          ${moderation.provider}, ${moderation.providerRequestId}, ${moderation.policyVersion},
          ${moderation.suggestion}, ${moderation.label}, ${moderation.subLabel},
          ${moderation.score}, ${jsonParam(moderation.matchedRules)},
          ${jsonParam(moderation.matchedTermsMasked)}
        )
      `)
    }

    return inserted
  })
}

/**
 * 在**调用方给定的事务内**插入 SYSTEM 消息并 bump 会话的 `last_message_at`。
 *
 * 抽出来是为了让 #11 的 `accept` 能把「创建交易」与「写 `tx.accepted` 消息」放进同一个
 * 数据库事务（#40-3）：分两次提交时，消息写失败会留下「交易已创建、确认消息永久缺失」的
 * 部分成功，而重试只会拿到 409，客户端还会把「其实已经成功」当成失败。
 *
 * 事务句柄类型从 `Db` 推导（与 `packages/db/src/seed.ts` 的 `SeedTx` 同法），不硬编码
 * 驱动的内部类型。
 *
 * `created_at` 显式用 `clock_timestamp()`，而不是列默认的 `now()`（= `transaction_timestamp()`，
 * 在 BEGIN 时刻就固定）：本函数跑在**调用方的事务**里，而该事务在插入之前可能长时间等锁
 * （accept 要先拿 listing 行锁）。用 `now()` 会让这条消息拿到「事务开始时刻」这个更旧的时间戳，
 * 于是先提交的 TEXT 消息在按 `(created_at, id)` 升序重排后反而排到它后面 —— 实时推送顺序与
 * 刷新后的历史顺序自相矛盾，且未读口径（`m.created_at > last_read_at`）会永久漏掉它。
 * 独立事务里的 `insertText` 不需要这样改：它是事务的第一条语句，`now()` 即插入时刻。
 */
export type MessageTx = Parameters<Parameters<Db['transaction']>[0]>[0]

export async function insertSystemWithin(
  tx: MessageTx,
  conversationId: string,
  content: string,
): Promise<MessageRow> {
  const result = await tx.execute(sql`
    WITH msg AS (
      INSERT INTO messages (id, conversation_id, sender_id, type, content, created_at)
      VALUES (${newId()}, ${conversationId}::uuid, NULL, 'SYSTEM', ${content}, clock_timestamp())
      RETURNING id, conversation_id, sender_id, type::text, content, created_at,
                visibility::text AS visibility
    ), bump AS (
      UPDATE conversations c SET
        last_message_at = GREATEST(c.last_message_at, (SELECT created_at FROM msg)),
        updated_at = now()
      FROM msg WHERE c.id = msg.conversation_id
    )
    SELECT msg.* FROM msg
  `)
  const row = rowsOf(result)[0]
  if (!row) throw new Error('SYSTEM 消息插入失败：会话可能已被并发删除')
  return toRow(row)
}
