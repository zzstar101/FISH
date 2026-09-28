## 来源

- EPIC #76（工程质量、测试、CI 与技术债）「DB / Seed / Smoke」段：持续校验 seed 满足真实**身份 / 交易 / 会话**业务不变量，fixture 不得由客户端 mock 掩盖；保留 #181 / #183 的交易断言与诊断，不丢覆盖。
- 基线：`origin/main = 529ca42`。

## 顺序约束（硬性）

- 本卡与**波 0 卡 P0-1 同文件** `packages/db/src/seed.ts`（P0-1 覆盖 `packages/db/src/schema/**`、`migrations/**`、`seed.ts`，见 `.decomp/parallel-plan.md §5.1`）。
- **P0-1 先合，本卡 rebase 到 P0-1 之后再做。** P0-1 会新增业务表，`packages/db/src/seed.ts:102-104` 的那条 `TRUNCATE TABLE ...`（表清单在 `:103`）必须同步纳入新表；rebase 后先逐表核对 TRUNCATE 清单，再写断言。

## 已核实事实（本人用 `git show origin/main:<path>` 逐条核对）

- `packages/db/src/seed.ts:94` `export async function seed(tx: SeedTx): Promise<void>`；`:102-104` 单条 `await tx.execute(sql\`TRUNCATE TABLE ...\`)`，`:103` 列出 21 张表（users, wechatIdentities, sessions, campusEmailVerifications, listings, listingImages, listingModerationRecords, comments, wishes, matches, conversations, messages, messageMedia, adminAuditLogs, transactionMeetupTokens, transactions, notifications, jobs, aiPolishRequests, reports, userRestrictions）；`:137` 注释说明 reservation 表不 truncate。
- 本地库守卫 `assertLocalDatabase` 在 `packages/db/src/seed.ts:385-393`（`:386` `SEED_FORCE==='1'` 直接返回；`:388` hostname 限 localhost/127.0.0.1/::1；`:389-391` 抛错）。**注意**：`docs/deployment.md` 引用的 `packages/db/src/seed.ts:284-291` 已漂移（该文档修正属 76-2）。
- 演示身份：`seed.ts:77-81` sellerA `202101000001`、buyerB `202101000002`、buyerC `202101000003`。
- 现有 fixture（写断言时的真实基线）：
  - listings 6：`listingK380` / `listingMonitor` / `listingTextbook` / `listingLamp`（RESERVED，seller=buyerB）/ `listingBasketball`（SOLD，seller=buyerB）/ `listingSneakers`（免费，0，seller=buyerC）；listingImages 4；wishes 2。
  - conversations 3（`:264-294`）：K380（buyer=buyerB, seller=sellerA）、lamp（buyer=sellerA, seller=buyerB）、basketball（buyer=buyerC, seller=buyerB）。
  - messages 4（`:296-340`）：`messageText`（buyerB，TEXT，会话 K380）、`messageSystem`（senderId=null，SYSTEM）、`messageLampAccepted` / `messageBasketballAccepted`（senderId=null，SYSTEM，content 为 `{type:'tx.accepted',transactionId,amountCents}`）。
  - transactions 2（`:342-364`）：`transactionLamp`（listing=lamp, buyer=sellerA, seller=buyerB, 2800, **PENDING_MEETUP**）、`transactionBasketball`（listing=basketball, buyer=buyerC, seller=buyerB, 5000, **COMPLETED**，含 `buyerConfirmedAt`/`sellerConfirmedAt`/`completedAt`）。
  - jobs 1 条 PENDING `MATCH_LISTING`，payload `jsonParam({listingId: ids.listingK380})`；listingNumbers 6 条固定 12 位编号。
- `packages/db/src/seed.test.ts` 共 193 行，测试 1 在 `:41-146`：`:31` `scratchDatabase = fish_seed_test_${process.pid}`；`:65-80` 逐表计数断言 `{users:3, listings:6, listingImages:4, wishes:2, matches:0, conversations:3, messages:4, transactions:2, notifications:0, jobs:1}`；`:82-94` 重跑 seed 后 listingNo 不变；**`:100-108` 已有 orphanTx 不变量**（`left join conversations on c.listing_id=t.listing_id and c.buyer_id=t.buyer_id and c.seller_id=t.seller_id where c.id is null` ⇒ `[]`）；`:112-119` 校验 seed 产出的哈希可被 `DEMO_PASSWORD` 通过；`:128-135` jobs payload `jsonb_typeof='object'`；`:138-141` jobs 恰为 `[{status:'PENDING', attempts:0}]`；`:142-144` finally 关池 + `drop database ... with (force)`。测试 2（`:155-193`）测 `jsonParam`。
- `packages/db/package.json` 有 `typecheck` / `generate` / `migrate` / `studio` / `seed` / `promote` 脚本。

## 验收标准

- [ ] 在 `packages/db/src/seed.test.ts` 增加**业务不变量**断言（用 SQL 直接查库，`expect(rows).toEqual([])` 形式，不用客户端 mock）：
  - [ ] **交易↔商品状态一致**：任何 `transactions.status = 'COMPLETED'` 的交易，其 `listings.status` 必须为 `'SOLD'`；任何非 COMPLETED 的活跃交易，其 listing 不得为 `'SOLD'`。用一条 join 查询取违规行，期望 `[]`（当前 fixture：basketball COMPLETED ↔ SOLD 会通过；lamp PENDING_MEETUP ↔ RESERVED 会通过）。
  - [ ] **会话参与者对称且互异**：每条 `conversations` 的 `buyer_id <> seller_id`，且两者都存在于 `users`。
  - [ ] **消息发送者合法**：每条 `messages.sender_id` 要么为 `null`（SYSTEM），要么等于其所属会话的 `buyer_id` 或 `seller_id`；违规行查询结果期望 `[]`。
  - [ ] **SYSTEM 交易消息指向真实交易**：`messages` 中 `content->>'type' = 'tx.accepted'` 的行，其 `content->>'transactionId'` 必须命中 `transactions.id`；且 `sender_id is null`。违规行期望 `[]`。
  - [ ] **jobs payload 引用的 listing 存在**：`jobs.payload->>'listingId'` 必须命中 `listings.listingNo`（现有 `:128-135` 只断言了 `jsonb_typeof`，本卡补存在性）。
- [ ] **每条新断言都必须能变红（防“永真断言”）**：在 PR 里给出**变异证据** —— 临时把 fixture 改成违反该不变量的值（例：把 `seed.ts` 中 `listingBasketball` 的 status 由 `SOLD` 改回 `RESERVED`，或把某条 SYSTEM 消息的 `transactionId` 改成不存在），跑 `bun test --isolate packages/db/src/seed.test.ts` 必须失败，并贴出失败输出；随后还原。不得提交被变异的 fixture。
- [ ] 覆盖不丢失：保留 `seed.test.ts:100-108` 的 orphanTx 断言、`:112-119` 的密码校验、`:138-141` 的 jobs 状态断言，不删除、不弱化为「只查条数」。
- [ ] 若某条新断言在 `origin/main` 的 fixture 上**直接为红**，说明真实不变量已被违反：在 PR 里给出该红灯输出，并只做让不变量成立的最小 `seed.ts` 修正（不得为了变绿而放宽断言）。
- [ ] rebase 到 P0-1 后复核 `packages/db/src/seed.ts:102-104` 的 `TRUNCATE` 表清单包含 P0-1 新增的全部业务表；验收：把 `:103` 的表名与 `information_schema.tables` 的业务表集合比对，差额为空（或把有意不 truncate 的表在注释里列明）。
- [ ] 验收命令（需先 `bun run db:up` + 迁移）：`bun test --isolate packages/db/src/seed.test.ts` 通过；再跑 `bun run typecheck`、`bun run lint`、`bun test --isolate`。

## 写作用域

`packages/db/src/seed.test.ts`（主要）、`packages/db/src/seed.ts`（仅在断言暴露真实不一致时做最小修正）。

## 串行资源

- `packages/db/src/seed.ts`：**与波 0 卡 P0-1 完全同文件**，必须 P0-1 先合入后本卡再 rebase（见上「顺序约束」）。
- `packages/db/src/schema/**` 与 `packages/db/src/migrations/**`：属 P0-1，本卡**不碰**。
- `.env.example` / `docs/deployment.md`：本卡不改（与 76-2 无重叠诉求）。

## blocked_by

`blocked by #287`（波 0 卡 = #287，同文件 `packages/db/src/seed.ts`，依据 `.decomp/parallel-plan.md §5.1`）。

## 明确不做

- 只实现本卡验收标准：为既有 seed fixture 加固业务不变量断言；不新增业务表、不改 schema、不动 `migrations/**`（属 P0-1）。
- 不引入被排除组件（Redis / Kafka / OpenSearch / K8s / 微服务）。
- 不做无关重构：不重排 `seed.ts` 的 fixture、不改演示账号/密码、不重写 `seed.test.ts` 现有断言。
- 不写凑覆盖率的多余测试（不测 `jsonParam` 之外的框架行为、不为同一不变量写多个等价用例）。
- 不为了让断言变绿而删除或放宽 `#181` / `#183` 的交易断言与诊断。

- **与在飞 #286 的合入顺序**：#286 的工作区同样改了 `packages/db/src/seed.ts`（未提交）。本卡开工不受阻，但 PR 必须在 #287 与 #286 都合入后 rebase 再合，否则两边会各自声称「无依赖」。

