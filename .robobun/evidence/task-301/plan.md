# task-301 实现计划（#301 seed 业务不变量断言加固）

## 需求理解
在 `packages/db/src/seed.test.ts` 增加 5 条 SQL 直查库的业务不变量断言（违规行期望 `[]`）：
交易↔商品状态一致、会话参与者对称互异且存在、消息发送者合法、tx.accepted SYSTEM 消息指向真实交易、
jobs payload 引用的 listing 存在。每条断言须给变异变红证据；orphanTx/密码/jobs 现有断言不删不弱化。

## 现查修正（基线 4f49325，Issue 基于 529ca42）
- fixture 与 Issue 引用一致（6 listings / 3 conversations / 4 messages / 2 tx / 1 job），seed.ts 现 411 行。
- **jobs payload 口径修正**：Issue 说「命中 listings.listingNo」，但契约
  `packages/contracts/src/matching/jobs.ts:31` `MatchListingJobPayloadSchema = { listingId: z.uuid() }`，
  worker `apps/worker/src/jobs/matching/handlers.ts:46` 按 id 消费，fixture 写的也是 UUID
  （`seed.ts:382`）。正确口径 = 命中 `listings.id`，PR 附证据说明。
- 交易状态枚举 `PENDING_MEETUP/COMPLETED/CANCELLED`（schema/transactions.ts:17）；
  「非 COMPLETED 的活跃交易」= `PENDING_MEETUP`（CANCELLED 后商品可另行售出，不算违规）。
- `messages.content` 是 text（schema/messages.ts:21），非 JSON 文本不能直接 `::jsonb`：
  用 `CASE WHEN pg_input_is_valid(content,'jsonb') THEN content::jsonb END`（PG18，CASE 保证求值顺序）。

## 改动文件
1. `packages/db/src/seed.test.ts`（主要）：orphanTx 块后新增 5 条不变量查询断言；
   jobs payload 块补 listing 存在性（命中 listings.id）。
2. `packages/db/src/seed.ts`（仅注释）：按验收「差额非空则注释列明」，在 reservation 注释处补
   `id_rekeys`（无外键的 ID 迁移台账）与 `listing_lookup_attempts`（60s 限流台账，subjectKey 为 HMAC 文本）
   两个有意不 truncate 的表。断言若暴露真实不一致才做数据修正（预期不需要）。

## 验证策略
- L0：每 commit 前 biome check staged 文件 + 定向 `bun test --isolate packages/db/src/seed.test.ts`。
- 变异证据（acceptance 记录，测后还原）：basketball SOLD→RESERVED；conversationLamp buyerId→buyerB；
  messageText senderId→buyerC；messageBasketballAccepted.transactionId→随机 UUID；job payload listingId→随机 UUID。
- L1 quick（ROBOBUN_TEST_SCOPE=packages/db）→ L2 full（≤3 次预算）。
- TRUNCATE 比对：information_schema.tables ∖ TRUNCATE 清单 = {listing_numbers, id_rekeys, listing_lookup_attempts}，
  前者已有注释，后两者补注释。
