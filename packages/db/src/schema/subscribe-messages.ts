import { sql } from 'drizzle-orm'
import {
  check,
  primaryKey as compositePrimaryKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { primaryKey, timestamps, timestamptz } from './common'
import { users } from './users'

/**
 * 微信订阅消息的两张表（#462）。
 *
 * 为什么不复用 `notifications`：站内通知是**用户可见的业务记录**（读了要消失、删号要清空、
 * 界面按 `type` 渲染文案），而这里的行是**投递尝试**（有状态机、有重试、有 errcode，
 * 端上永远看不到）。把两者塞进一张表会让"未读数"和"发过几条微信"互相污染。
 *
 * 为什么不建 `subscribe_message_templates`：模板 ID 是运维配置（env），不是业务数据——
 * 落库会变成「改了 .env 却还在发旧模板」的第二份真相。
 */

/** 与 `@fish/contracts/subscribe-messages/schema` 的 `subscribeMessageKindSchema` 同步扩。 */
export type SubscribeMessageKind = 'CHAT' | 'TX' | 'REVIEW'

/**
 * 投递来源。首批只有两种产生点：
 * - `NOTIFICATION`：`notifications` 表里新产生的 `TX` / `DISPUTE` / `MODERATION` / `ACCOUNT`
 *   通知（`source_id` = 通知 id）；
 * - `CHAT`：对方消息 60 秒内未读（`source_id` = 触发投递的那条消息 id）。
 */
export type SubscribeMessageSourceType = 'NOTIFICATION' | 'CHAT'

/**
 * 投递状态机：#511 起是
 * `PENDING`（待发 / 待重试）→ `SENDING`（已占行、正在调微信）→ `SENT` | `FAILED`（放弃）|
 * `SKIPPED`（不该发）。
 *
 * `SENDING` 是**发送之前先提交**的一次性占位：#462 的原始设计把「占行 → 调微信 → 落状态」
 * 关在同一个事务里，于是进程在飞行途中被强杀时，微信可能已经收到请求、而本地事务回滚成
 * `PENDING` —— 重启后同一条会被再发一次。有了 `SENDING`，重启之后看到的只可能是「我在发
 * 这条的时候死了」，那一行按「结果不确定」处理：**不重发**，标 `FAILED`
 * （`last_error=interrupted`，见 `apps/api/src/modules/subscribe-messages/store.ts`）。
 */
export type SubscribeMessageDeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED'

/**
 * 授权记账（Owner 冻结口径）：一次性订阅，用户每在 `requestSubscribeMessage` 里「允许」
 * 一次，对应 kind 的可发次数 +1（封顶 50）；每发出一条 -1；用户拒绝不加；为 0 时不发。
 *
 * 主键是 `(user_id, kind)` 而不是自增 id：这张表是**计数器**，一个 (人, 模板) 只有一行，
 * 用 upsert 维护才能在并发上报下只加一次。按 `user_id` 记账，切号不继承；
 * 外键 CASCADE 让注销时随 `users` 行一起消失（`apps/worker/.../account-deletion/purge.ts`
 * 另有显式删除与计数，见那里的注释）。
 */
export const subscribeMessageGrants = pgTable(
  'subscribe_message_grants',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SubscribeMessageKind>().notNull(),
    /** 剩余可发次数。0 是合法状态（= 用户没授权过、或额度已用完），不是 NULL。 */
    remaining: integer('remaining').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    compositePrimaryKey({ columns: [table.userId, table.kind] }),
    // 50 就地写成字面量：CHECK 里不能出现 drizzle 的占位符（那是 SQL 参数，DDL 里没有意义）。
    // 这个数字与 `@fish/contracts/subscribe-messages/schema` 的 `SUBSCRIBE_MESSAGE_GRANT_LIMIT`
    // 必须一致——`packages/db` 不能 import `@fish/contracts`（依赖方向反了），改一处要改两处。
    check(
      'subscribe_message_grants_remaining_range',
      sql`${table.remaining} >= 0 AND ${table.remaining} <= 50`,
    ),
  ],
)

/**
 * 投递行：一条「该给谁发哪个模板」的事实，带着状态机与失败原因。
 *
 * 去重键 `(source_type, source_id, recipient_id)` 是本域的核心不变量：**同一个来源对同一个人
 * 只登记一条**。它同时是三条路径的防线——调度循环重启后重扫、两个 tick 交错、以及上游
 * 重放同一批通知——所以登记一律 `ON CONFLICT DO NOTHING`，不靠先查后写。
 *
 * 内容在**登记时**就渲染好并落 `data` / `page`：
 * - 投递与业务事件之间因此没有「发送时数据已经变了」的窗口（商品改名、消息被撤回都不影响
 *   已经在队列里的那条），也不会为了发一条微信去反查四张表；
 * - 代价是模板字段改了以后队列里的旧行仍是旧字段——这是对的，微信侧也不允许中途换模板。
 */
export const subscribeMessageDeliveries = pgTable(
  'subscribe_message_deliveries',
  {
    ...primaryKey(),
    sourceType: text('source_type').$type<SubscribeMessageSourceType>().notNull(),
    /** 来源行 id：`NOTIFICATION` 是 `notifications.id`，`CHAT` 是 `messages.id`。 */
    sourceId: uuid('source_id').notNull(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<SubscribeMessageKind>().notNull(),
    /** 发给微信的 `data` 对象（键 = 模板字段名，值已按官方长度限制截断）。 */
    data: jsonb('data').$type<Record<string, string>>().notNull(),
    /** 点击通知打开的小程序页面（带参数，形如 `pkg-x/pages/y/index?id=...`）。 */
    page: text('page').notNull(),
    /**
     * CHAT 的限频维度：「会话 × 收件人」30 分钟内最多推 1 条。
     * 其它来源为 NULL（它们各自按来源去重就够）。
     */
    conversationId: uuid('conversation_id'),
    status: text('status').$type<SubscribeMessageDeliveryStatus>().notNull().default('PENDING'),
    /** 已消耗的发送尝试次数（含第一次）。上限见 `apps/api/.../scheduler.ts`。 */
    attempts: integer('attempts').notNull().default(0),
    /** 微信 `errcode`（只有平台返回了结构化错误码时才有值）。 */
    lastErrcode: integer('last_errcode'),
    /**
     * 失败 / 跳过的**脱敏**原因（`no_quota` / `no_openid` / `timeout` / `errcode=47003` …）。
     * 刻意不放 `errmsg` 原文：上游可控文本不进库，也不进日志（与 #294 的出码模块同口径）。
     */
    lastError: text('last_error'),
    /** 下一次可以尝试的时刻（退避）。非 `PENDING` 的行无意义。 */
    nextAttemptAt: timestamptz('next_attempt_at').notNull().defaultNow(),
    sentAt: timestamptz('sent_at'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('subscribe_message_deliveries_source_uq').on(
      table.sourceType,
      table.sourceId,
      table.recipientId,
    ),
    // 调度循环每 15s 取一批「到点且待发」的行：部分索引让它不会越扫越大。
    index('subscribe_message_deliveries_pending_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.status} = 'PENDING'`),
    // 「发送中」的行：每轮收尾（以及下一轮开头）扫一次有没有被强杀留下的 `SENDING`。
    // 正常情况下这张部分索引里永远是空的（一条投递只在这几秒里处于该状态）。
    index('subscribe_message_deliveries_sending_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} = 'SENDING'`),
    // CHAT 的 30 分钟限频查询：`conversation_id = ? AND recipient_id = ? AND created_at > now()-30min`。
    index('subscribe_message_deliveries_chat_throttle_idx')
      .on(table.conversationId, table.recipientId, table.createdAt)
      .where(sql`${table.sourceType} = 'CHAT'`),
    check(
      'subscribe_message_deliveries_status_values',
      sql`${table.status} IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED')`,
    ),
  ],
)
