# #323 R3：多路召回（Multi-channel Recall）

对应 Issue #323 的 M2 / M3，以及拆 PR 计划里的 R3。基线：`feat/323-r2-user-interest`（R2 的画像层），
本 PR 是 **stacked PR**——R2 合入后 retarget 到 `main`。

## 1. 范围

**交付**：六路召回 provider + 候选合并去重 + 最终可见性复核，产出带 `recallSources[]` 与各路 feature
的候选集（`RecallCandidate[]`）。

**不交付**（与 Issue 的 R4–R6 边界一致）：

- **不接 Feed**：`GET /recommendations/feed` 仍然是 `rec-v1-none` + `sort=newest` 透传。
  召回层在 R3 **没有生产调用方**，因此 `apps/api/src/app.ts` 本轮**不改**——不为了"能被调用"
  而提前接线一个尚无消费方的候选集（R4 的 ranker 是第一个下游）。
- 不排序、不重排、不做 diversity/fairness（R4）。
- 不开新端点、不改客户端（R5）。
- 不出指标与 guardrail（R6）。
- R1 推迟的「服务端曝光归因真值（这次返回了哪些商品、各在第几位）」仍不落地：它的前提是
  Feed 侧真的按候选集返回商品，只有 R4/R5 接线后才成立。

## 2. 写进实现的决定

| # | 决定 | 理由 |
| --- | --- | --- |
| 1 | 六路：`fresh` / `popular` / `semantic` / `wish` / `category` / `explore` | `category` 是 semantic 不可用时的确定性兜底，且纯 SQL、匿名可用；Issue M2 原把它列为 "Category / Recent Interest Recall" |
| 2 | 契约与 DB 枚举同步新增 `category` | R1 把 `RecommendationSourceSchema` 冻结成 7 值（漏了 category）；不加就只能在归因里塞进 `explore`，R6 的通道分账会失真 |
| 3 | 单路配额 fresh 100 / popular 100 / semantic 100 / wish 50 / category 80 / explore 50，合并去重后硬上限 500 | 六路合计 480 ≤ 500：配额是**去重前**预算，池上限是**去重后**硬顶（有测试锁这条数值关系） |
| 4 | `combined_interest = 0.7 · session + 0.3 · long_term`，只有一路时不补零、两路都没有只降 semantic | Issue M1 明说 α/β 后续实验调；"只有一路"时补零会让归一化把该路权重再缩放一次（等价但多一次误差） |
| 5 | api 需要 embedding 模型名时用新的 `loadRecommendationEmbeddingModel()`，**不读** `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` | 读侧只需要按 `model` 过滤向量；复用 `loadEmbeddingEnv` 会把上游密钥变成 api 的启动依赖，与 `AI_POLISH_*` / `TENCENT_CLOUD_*` 的分拆原则相反 |
| 6 | Popular 直接聚合 `recommendation_events`，不建物化表 / 不新增 job | 14 天窗口 + `(occurred_at)` 索引足够；物化表要新的刷新链路，而 R6 的指标还没定 |
| 7 | Popular 有自己的权重表与半衰期（行为 3 天、商品年龄 7 天），**不**复用 R2 的 `INTEREST_ACTION_WEIGHTS` | 语义不同：一个是"全站最近在火什么"，一个是"这个人偏好看什么"；共用一张表意味着调其中一个必然动另一个 |
| 8 | Wish 通道读 #322 的 `matches` 表（`score DESC`、同 listing 多愿望只留最高分），不实时算 pgvector | Issue 明说复用 #322 的匹配结果；实时算会让一次召回打出 N 次向量查询 |
| 9 | Category 通道复用 R2 的 session 行为窗（最近 50 条、30 分钟半衰期、零权事件不占窗） + `listings.category` | 与语义召回共用"最近看什么"的口径；纯 SQL，匿名也能用，无行为则本路空 |
| 10 | Exploration 内部分三块：新商品 20 / 新卖家 20 / 冷门类目 10，去重后空位让给新商品；**不新增枚举值** | Issue M2 的探索要求；子来源用内部 `subSource` 标记，对外 `source` 仍是 `explore`，避免为了观测改一次已冻结的枚举 |
| 11 | 逐路 try/catch → 空候选 + 结构化 `{channel, reason}`，reason ∈ `no_profile` / `model_unavailable` / `provider_error`；整层不抛错，且**不用 `Promise.all`** | `Promise.all` 会一路抛错连别路结果一起丢；而"semantic 挂了还有别的路兜底"正是 M2 的硬要求。三者分开记账才能让监控区分"冷启动"与"配置错误" |
| 12 | 合并层只认 `findVisibleListingRefs` 的复核结果；复核失败时**返回空候选**，`mergeDegradedReason='provider_error'` | M3："不依赖召回时快照作为最终可见性真值"。拿不到"此刻可见"的真值时，宁可首页空也不能把可能已下架的商品交出去 |
| 13 | 不加单路超时 | 归 R6（latency guardrail）；先有指标再定阈值，否则是凭空拍一个会把慢查询打成空的数 |

## 3. 契约与常量

新增 `packages/contracts/src/recommendation/recall.ts`（**单点定义**，api 与 db 共用；`packages/db` 不 import
contracts，查询所需的数值一律由 api 显式传入）：

- `RECALL_STRATEGY_VERSION = 'recall-v1'`
- `RECALL_CHANNELS` / `RecallChannel`、`RECALL_CHANNEL_LIMITS`、`RECALL_MAX_CANDIDATES = 500`、
  `RECALL_CHANNEL_PRIORITY = ['semantic','wish','category','popular','fresh','explore']`
- `RECALL_CHANNEL_SOURCES`（对外归因用的 7 值子集）、`RECALL_MAX_SOURCES_PER_CANDIDATE`
- `RECALL_INTEREST_MIX = { session: 0.7, longTerm: 0.3 }` + `combineInterestVectors()`（纯函数：各自 L2 归一化
  → 混合 → 再归一化；只有一路直接用那一路；两路都无得 `null`；维度不一致抛错）
- `POPULARITY_WINDOW_DAYS = 14`、`POPULARITY_ACTION_WEIGHTS`（DETAIL_VIEW 1 / LONG_VIEW 2 / IMAGE_VIEW 0.5 /
  FAVORITE 3 / CHAT_START 4 / COMMENT 2 / TRANSACTION_START 5 / PURCHASE 6，其余 0）、
  `POPULARITY_ACTION_TYPES`、`POPULARITY_ACTION_HALF_LIFE_MS = 3d`、`POPULARITY_LISTING_AGE_HALF_LIFE_MS = 7d`、
  `RECALL_FRESHNESS_HALF_LIFE_MS`（= 商品年龄半衰期，两处必须是同一个量）
- `RECALL_SESSION_CATEGORY_TOP_N = 3`、`RECALL_EXPLORE_MIX = { newListing: 20, newSeller: 20, coldCategory: 10 }`、
  `RECALL_EXPLORE_NEW_LISTING_WINDOW_MS = 3d`、`RECALL_EXPLORE_NEW_SELLER_WINDOW_MS = 30d`

`packages/contracts/src/recommendation/schema.ts` 的 `RecommendationSourceSchema` 在 `'wish'` 后插入
`'category'`；`packages/db/src/schema/recommendation-events.ts` 的 `recommendationSourceEnum` 同步。

## 4. 数据层查询（`packages/db/src/recall-store.ts`）

可见性谓词统一为 `status = 'ACTIVE' AND moderation_status = 'APPROVED' AND governance_delisted_at IS NULL
AND (viewerUserId IS NULL OR seller_id <> viewerUserId)`。`governanceDelistedAt` 是纵深防御：治理下架路径
本来就把 `status` 置成 `OFFLINE`，但复核谓词不该依赖"另一处路径恰好也改了状态"。

| 函数 | 取数口径 |
| --- | --- |
| `findFreshRecallCandidates` | 可见商品按 `created_at DESC` 取 K |
| `findPopularRecallCandidates` | `recommendation_events` join `listings`，`occurred_at >= windowStart`，SQL 内 `sum(weight × 0.5^(行为年龄/3d)) × 0.5^(商品年龄/7d)`，`GROUP BY listing` |
| `findSemanticRecallCandidates` | 复用 #322 的 `topKSimilarListings`（exact scan + `model` 过滤 + 新鲜度谓词），可见性谓词当 `filter` 传入；`semanticScore = 1 − distance` |
| `findWishRecallCandidates` | 本人 `status='ACTIVE'` 愿望 join `matches`，同 listing 取最高 `score` |
| `findCategoryRecallCandidates` | 传入类目**顺序**即优先级，每类目各取 K 条 |
| `findExploreRecallCandidates` | 三块分别取数 → 按 `new_listing → new_seller → cold_category` 去重分配 → 空位由后续新商品补 |
| `findVisibleListingRefs` | 最终复核：**此刻**可见的候选，并带回 `sellerId` / `category` / `createdAt`（合并层要算类目亲和与 freshness，且不该信任召回快照） |
| `countListingImpressions` | 按身份（登录身份要求 `user_id` 命中；匿名身份要求 `user_id IS NULL` 且 `anonymous_session_id` 命中）统计 `IMPRESSION` |
| `findSessionCategoryWeights` | 会话行为窗（与 R2 同口径：最近 N 条、半衰期衰减、零权事件不占窗）join `listings` 按类目聚合 |

`findSessionCategoryWeights` 与 R2 的 `loadUserInterestActions` **同窗口口径但各自实现**：后者刻意不返回
`listingId`（画像聚合只需要向量），类目聚合必须要它。两处改动必须同步——文档在此显式记录这条耦合。

## 5. 编排与降级（`apps/api/src/modules/recommendation/recall/service.ts`）

一次 `recall({ userId, anonymousSessionId })`：

1. 解析身份（登录优先）→ 身份缺失记 `no_profile`；模型缺失只影响**需要向量的路**，记 `model_unavailable`。
2. 有身份时先算 `findSessionCategoryWeights`（**纯 SQL、不依赖 embedding 模型**——category 是 semantic
   不可用时的兜底通道，把它一起锁在模型后面会让"模型不可用"退化成"个性化全丢"）；随后"有身份且模型可用"
   时再算 `readSessionInterest`（session 向量），登录用户再读长期画像并**校验
   `strategyVersion === INTEREST_STRATEGY_VERSION`**（R2 交接：该列只写不读，读取方负责版本过滤；
   旧版本行是上一版权重算出的方向）。
3. `combineInterestVectors` 合成；抛错（两路维度不一致）按 `provider_error` 降级 semantic。
4. 六路按固定顺序 `fresh → popular → semantic → wish → category → explore` 各自 try/catch。
5. 只看得到"此刻可见"的真值：`findVisibleListingRefs` 复核；失败 → 空候选 + `mergeDegradedReason`。
6. `countListingImpressions` 只影响 `alreadySeenCount`，失败不清空候选。
7. 返回 `{ strategyVersion, candidates, channels, interest, mergeDegradedReason }`；`interest` 只暴露
   `{ session, longTerm, combined }` 三个布尔，不外泄向量。

## 6. 合并 / 去重（`merge.ts`）

- 只保留出现在 `visible` 里的候选（复核是唯一真值）。
- `recallSources[]` 有序（按 `RECALL_CHANNEL_PRIORITY`），每个 feature 先到先得，`RECALL_MAX_SOURCES_PER_CANDIDATE` 截断。
- 填齐 M3 字段：`semanticScore` / `wishScore` / `popularity` / `userCategoryAffinity`（类目亲和对所有通道生效，
  不只 category 通道）/ `freshness` / `alreadySeenCount` / `sellerExposure`。
- 截断顺序：跨通道命中数降序 → 最高优先级通道靠前者优先 → `listingId` 升序兜底（同输入可复现）。
- `sellerExposure` 在**截断前**统计：截断后才数会让同一批候选的卖家密度随 `maxCandidates` 变化，
  R4 的卖家公平性就没法比较。

## 7. 迁移

`packages/db/src/migrations/20260929171039_gorgeous_molly_hayes.sql`（由 `bun run --filter '@fish/db' generate`
生成，未手改，两条 additive 变更）：

```sql
ALTER TYPE "public"."recommendation_source" ADD VALUE 'category' BEFORE 'follow';
CREATE INDEX "recommendation_events_occurred_at_idx" ON "recommendation_events" USING btree ("occurred_at");
```

索引的理由：原有四条索引都以 `user_id` / `listing_id` / `anonymous_session_id` 开头，而 Popular 是
**全局时间窗**聚合，用不上它们。

## 8. 验证

实跑环境：worktree `/Users/zzstar/Developer/Programs/FISH-323-r3`，验证库 `fish_323_r3`
（`create database` + `bun run db:migrate` + `bun run db:seed`），`.env` 与其他 worktree 同一份（未入库）。

| 项 | 命令 | 结果 |
| --- | --- | --- |
| R3 四个测试文件 | `DATABASE_URL=postgres://fish:fish@localhost:5432/fish_323_r3 bun test <四个文件>` | **48 pass / 0 fail / 179 expect**（contracts 15 + api merge 10 + db recall-store 15 + api service 8）。对抗审查后新增 3 个用例：semantic 距离并列按 id 兜底（已用 `git show HEAD:packages/db/src/embedding-store.ts` 回退验证**修复前必失败**：返回 id 最大的三条）、长期画像读取失败报 `provider_error`（把表改名制造真故障）、`freshnessOf` 非法时间戳返回 0 |
| `bun run typecheck` | `bun run typecheck` | 9 包 Exit 0 |
| `bun run lint` | `bun run lint` | Checked 840 files，No fixes applied（首跑 12 error 全为 organizeImports，`bun run biome check --write .` 后归零） |
| 全量测试 | `DATABASE_URL=...fish_323_r3 bun test --isolate` | **2439 pass / 0 fail / 8925 expect / 236 files**（84.79s），R3 新增 48 用例全绿、无新增失败（R2 阶段记录的 5 条先存失败在本轮干净重跑中未复现；此前一次 264s 的 9 条失败是与审查子代理并发导致的资源竞争，非回归） |
| core smoke | `EMBEDDING_TRANSPORT=stub bun run core:smoke` | ok — 1 轮全部通过，共 **232 项断言**（22721ms） |

> 注意：新 worktree 默认没有 `.env`（`gitignore`），缺它会因 `WEB_ORIGIN`/`S3_*` 校验失败产生 20 条与本次改动无关的失败；实跑前需从已有 worktree 复制一份。

覆盖重点：常量自洽（配额/优先级/探索分块/半衰期关系）、合并去重的确定性与截断顺序、六路 SQL 的可见性
与窗口口径、编排层六路顺序与三类降级原因、长期画像版本校验、整库不可用时**不抛错**。

## 9. 已知边界（不属本 PR）

- **召回服务与 `loadRecommendationEmbeddingModel()` 在 R3 没有生产调用方**：`apps/api/src/app.ts` 未接线，
  生产装配（启动期 fail-fast）随 R4/R5 接 Feed 时落地。本轮由集成测试直接装配覆盖。
- **服务端曝光归因真值**仍未落地（R1 起就推迟）：需要 Feed 按候选集返回商品，R4/R5 才可能。
- Wish 通道的新鲜度取决于 #322 匹配 job 的调度；本 PR 不引入新的匹配触发。
- Popular 每次请求实时聚合 14 天事件：窗口与索引已定，**没有**缓存/物化；量级变化后的取舍归 R6 的 latency guardrail。
- 无单路超时（R6）；无 Bot/开发预览流量隔离（R1 起遗留，归 R6）。
- 换 `EMBEDDING_MODEL` 后旧向量会被 `model` 过滤掉，semantic 通道在重建完成前为空——与 R2 记录的边界同一根因。
- **category 在「有行为但全为负权」时报 `no_profile`**（审查 S2）：读数其实介于"有会话数据但没有正向类目"与"无画像"之间，
  要如实区分得给 `RecallDegradeReason` 加一个枚举值；本 PR 不加（对外形态冻结在 R3），归 R6 的通道分账。
- **`countListingImpressions` 失败时 `alreadySeenCount` 静默变 0**（审查 S3）：等于"从没曝光过"，
  `repeatedExposurePenalty` 会静默失效，但不会让请求失败。R4 消费时应把它放宽为 `number | null` 以区分"未知"与"0"。
- **`topKSimilarWishes`（`packages/db/src/embedding-store.ts`）与 `topKSimilarListings` 同病**（并列距离无确定性次键）：
  本 PR 只修 listings 侧（R3 直接消费的那条）；wishes 侧是 #322 遗留，按范围纪律不顺手改，归 #322 后续或 R6。
- 审查未验证项：真实 embedding provider 的召回质量、HTTP/Feed 端到端链路、真实数据量下的延迟与并发、
  `drizzle-kit generate` 幂等性、PG 12 以下 `ALTER TYPE ... ADD VALUE`、R4/R5/R6 的消费假设。

## 10. 对抗性审查记录

审查者：全新子代理（只给「改动范围 + R3 验收标准 + 仓库硬约束」，不给实现思路与可疑点），全程只读
（审查前后 `git status --short` 一致，探针库 `fish_recall_probe` 用完 drop）。

**必修 2 条，已修：**

| # | 位置 | 问题 | 修法 |
| --- | --- | --- | --- |
| B1 | `packages/db/src/embedding-store.ts:308`（被 `packages/db/src/recall-store.ts` 的 `findSemanticRecallCandidates` 复用） | `ORDER BY <=>` 无确定性次键，并列距离时 `LIMIT K` 取哪 K 条取决于堆物理顺序（探针：20 条相同向量 + `limit=5` → 堆内前 5 行而非 id 前 5 行），违反"同输入可复现" | 加 `asc(listings.id)` 次键；补「按 id 降序插入、断言取 id 最小三条」用例，并回退验证过修复前必失败 |
| B2 | `apps/api/src/modules/recommendation/recall/service.ts:202-208` | 长期画像读取失败的 catch 不置 `interestReason`，故障被误报成 `no_profile`（探针：`drop table` 与"真无画像"对外结果完全一致） | catch 内置 `interestReason = 'provider_error'`；补「把表改名制造真故障」用例 |

**非阻塞建议 4 条：** S1 合并调用不在 try/catch（已修：`mergeRecallCandidates` 包 try/catch +
`freshnessOf` 加 NaN 守卫）、S2 / S3 记入 §9 归 R6/R4、S4 `RECALL_CHANNEL_SOURCES`（等于自身）与
`SessionCategoryWeight.actions` 是假信号（已修：前者删除、改用 `satisfies readonly RecommendationSource[]`
+ 断言每个通道都在 `RecommendationSourceSchema.options` 内；后者删除字段与两处断言）。

**自查另修 1 条：** category 通道初版被误锁在 `model !== null` 后面，与「category 是 semantic 不可用时的
确定性兜底、纯 SQL、匿名可用」矛盾（拆开 `identity` 与 `identity && model` 两个分支）；
`findListingCategories` 无调用方（删除）。

