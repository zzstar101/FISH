# #323 R2：User Interest Profile（用户兴趣画像）

- 状态：已实现（契约纯函数 + DB 表与读写 + api session 实时计算 + worker 长期重算 job）
- 上游：R1 行为埋点（PR #330，`b99ca4b`）已合并；本文基于 `origin/main` = `b641fd7`
- 下游：R3 多路召回 / R4 Rule Rank + Re-rank / R5 推荐 Feed API / R6 评估与观测。**本文只交付 R2**。

## 1. 范围

R2 回答一个问题：**「这个用户（或这个匿名会话）现在对什么感兴趣」——用一个 1536 维向量表达，并且这个向量必须可复现、可解释、可失效。**

交付物：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 契约 | `packages/contracts/src/recommendation/interest.ts` | 权重/半衰期/窗口常量 + `aggregateInterestVector` 纯函数 |
| 契约 | `packages/contracts/src/recommendation/jobs.ts` | `REFRESH_USER_INTEREST` job 类型与 payload schema |
| DB | `packages/db/src/schema/user-interest-profiles.ts` | `user_interest_profiles` 表 |
| DB | `packages/db/src/user-interest-store.ts` | 行为窗口 + 向量可用性读取；画像 upsert / 读取 / 删除 |
| api | `apps/api/src/modules/recommendation/interest.ts` | `readSessionInterest`：session 画像实时计算 |
| api | `apps/api/src/modules/recommendation/interest-queue.ts` | 行为写入后投递 `REFRESH_USER_INTEREST` |
| worker | `apps/worker/src/jobs/interest/handlers.ts` | 长期画像全量重算 |

**R2 不开新 HTTP 端点**，也不改 `GET /recommendations/feed` 的返回：Feed 仍是 `newest` 透传 + `rec-v1-none`（R1 的既有行为）。理由：R2 产出的是「画像」这一中间量，它的第一个真实消费方是 R3 的召回与 R4 的打分；现在把画像接进 Feed 只能做出一版「用画像重排 newest」的临时策略，既要额外定义游标与降级口径，又会在 R3 落地时整体作废。

明确不做（各自归属）：召回通道、ranker、re-rank、冷启动内容兜底（R3/R4）、事件保留作业与限流（R6）、跨身份合并、ANN 索引（R3 视数据量再定）。

## 2. 三条写进实现的决定

### 2.1 分层：长期画像物化，session 画像请求时算

- **长期画像**：窗口 180 天、半衰期 14 天，由 worker 消费 `REFRESH_USER_INTEREST` **从 0 全量重算**并落 `user_interest_profiles`。
- **session 画像**：只看最近 50 条行为、半衰期 30 分钟，请求时在 api 进程内实时算，**不落库**。

理由：180 天窗口不可能每次请求重算（行为条数随用户活跃度无上界），而「最近几十条行为」的成本可控且必须是即时的——用户今天连续看公路车/头盔/锁鞋，session 画像要立刻反映骑行，落库+异步重算会引入分钟级延迟。代价是两套调用参数与两套测试，所以两者共用**同一个**聚合函数与同一份常量，只差 `halfLifeMs` 与是否传 `limit`。

### 2.2 身份不合并

- 长期画像只给**登录用户**（`user_id`）。匿名会话会因清存储 / 换设备 / 180 天 TTL 而断裂，把跨会话的匿名行为并成「长期兴趣」等于把噪声当画像。
- session 画像两种身份都算：登录用户读 `user_id` 事件，匿名读 `anonymous_session_id` 事件。
- 匿名读取额外带 `user_id IS NULL`：否则「同一个匿名 sessionId 上先匿名后登录」的行为会被并进匿名画像，等于绕过上一条。
- 登录不会把匿名 session 画像迁移过去（不跨身份合并）。

### 2.3 权重、衰减、窗口单点定义且带版本号

全部集中在 `packages/contracts/src/recommendation/interest.ts`，带 `INTEREST_STRATEGY_VERSION = 'interest-v1'`；api（session）与 worker（长期）import 同一份，画像行记 `strategy_version`，版本变化即视为需要重算。**这些数值不在本 Issue 冻结**，是 v1 的初始相对强度，后续由实验调整（改数值 = 改版本号）。

## 3. 数据模型

### 3.1 `user_interest_profiles`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid pk（uuidv7） | 服务端生成 |
| `user_id` | uuid NOT NULL → `users` ON DELETE CASCADE | 只对登录用户建行 |
| `model` | text NOT NULL | 生成 listing 向量的 embedding model |
| `dimensions` | integer NOT NULL | 与 `EMBEDDING_DIMENSIONS` 一致（CHECK 约束） |
| `strategy_version` | text NOT NULL | `interest-v1` |
| `embedding` | vector(1536) NOT NULL | L2 归一化后的兴趣向量 |
| `action_count` | integer NOT NULL | 参与聚合的可用行为条数 |
| `window_started_at` | timestamptz NOT NULL | 聚合窗口起点（`now - 180d`） |
| `computed_at` | timestamptz NOT NULL | 聚合时刻，同时是 CAS 版本号 |
| `created_at` / `updated_at` | timestamptz NOT NULL | 惯例字段 |

约束：

- `user_interest_profiles_action_count_positive`：`action_count >= 1`。**行存在 ⟹ 至少有一条可用行为**；没有画像就是没有行（见 4.3）。
- `user_interest_profiles_dimensions_matches_column`：维度与向量列一致（`sql.raw(String(EMBEDDING_DIMENSIONS))`，迁移是静态 SQL，不能用参数占位符）。
- `user_interest_profiles_user_id_model_uq`：唯一 `(user_id, model)`。换模型时新旧画像并存，读取按 `model` 精确取。

**为什么不复用 `embeddings` 表**：`embeddings` 的语义是「某个文本实体（listing/wish）的向量」，带 `content_hash` 与 `source_updated_at` 的新鲜度 CAS，CHECK `embeddings_exactly_one_entity` 只允许 `listing_id` xor `wish_id`；兴趣向量是**行为聚合的派生缓存**，失效口径是「用户又产生了新行为」而不是「实体内容变了」。混进同一张表要么放宽 CHECK 破坏 #322 的语义，要么让两种失效规则互相干扰。

### 3.2 `jobs`

- `JobType`（`packages/db/src/schema/jobs.ts`，裸 text + TS 收窄）增加 `'REFRESH_USER_INTEREST'`，payload `{ userId }`。
- 新增部分唯一索引 `jobs_refresh_user_interest_user_id_pending_uidx`：`(payload->>'userId') WHERE type = 'REFRESH_USER_INTEREST' AND status = 'PENDING'`。
  - 同一用户连续行为只留一条待跑 job；
  - 只锁 `PENDING`：job 进入 `RUNNING` 后到达的新行为**必须**能再入队一次，否则这次重算会漏掉窗口内最新的事件（#322 已记录过这个坑）。

投递用原始 SQL（`INSERT ... ${JSON.stringify({userId})}::text::jsonb ON CONFLICT DO NOTHING`），与 `match-queue.ts` / embedding 入队同形。`::text::jsonb` 两段转型不能省：本仓 drizzle + bun-sql 会把 JS 对象再序列化一次，落成 jsonb **字符串标量**，`payload->>'userId'` 会读不到。

## 4. 聚合口径

### 4.1 输入

对身份取窗口内行为：`occurred_at >= now - 180d`，**排除零权事件**（`IMPRESSION`，它只用于曝光归因与 repeated-exposure 惩罚，不是兴趣信号），按 `occurred_at DESC, id ASC` 稳定排序；session 额外取前 50 条。

不按商品状态过滤：行为是历史事实，商品后来下架不改变「用户当时对它有兴趣」。

### 4.2 权重与衰减

```
INTEREST_ACTION_WEIGHTS
  PURCHASE 8  TRANSACTION_START 6  CHAT_START 5  FAVORITE 4  COMMENT 3
  LONG_VIEW 2  DETAIL_VIEW 1  IMAGE_VIEW 0.5  IMPRESSION 0
  QUICK_SKIP -0.5  UNFAVORITE -2  HIDE -3

decay(ageMs) = 0.5 ** (max(ageMs, 0) / halfLifeMs)
  长期 halfLife = 14 天；session halfLife = 30 分钟
  decay < 1e-6 的行为计入 decayed 并跳过

vector = Σ (w · decay · listingEmbedding) / Σ |w · decay|   → L2 归一化
```

- 分母用 **Σ|w·decay|** 而不是 Σ(w·decay)：正负反馈同时存在时，带符号的分母可能被抵消到接近 0，把噪声放大成单位向量。
- 负权进分子（负反馈会把向量推向反方向），但不单独产生向量。
- `usedActions = 0` 或分子模长为 0 → 返回 `null`。**绝不返回零向量**：零向量在 cosine 下与所有商品正交，语义上等于「有画像但不感兴趣任何人」，会把冷启动降级路径堵死。
- 维度取第一条可用向量；不一致直接抛错（同一 model 内维度不一致是数据事故，不是可降级情形）。

### 4.3 向量可用性

一条行为只有在它的 listing 有一条**当前 model、维度正确、且新鲜**的向量时才参与聚合。不可用原因**分别计数**（`missing` / `model_mismatch` / `stale` / `dimension_mismatch`），便于线上排障与换模型 backfill 决策。

- 读取时取这些商品**所有模型**的向量行，否则分不清「从来没有生成过」与「有向量但属于旧模型」。
- **先收齐所有行、再判定原因**：换模型 backfill 期间同一商品会同时存在「旧模型」与「当前模型但已过期」两行，就地写 Map 会让原因随数据库行序在 `model_mismatch` 与 `stale` 之间漂移。`(listing_id, model)` 唯一索引保证当前模型那一行最多一条，所以判定顺序固定为 维度 → 新鲜度 → 没有当前模型行时才是 `model_mismatch`。
- 新鲜度 = `source_updated_at` 与 listing `updated_at` 毫秒相等，与 #322 `freshListingsEmbedding()` 的 `date_trunc('milliseconds', …)` 判据等价；这里必须逐行在 JS 里判（才能把 stale 与 missing 分开），所以没有复制那段 SQL。
- 窗口内**一条可用向量都没有** → 不写画像行，并删掉该 `(user_id, model)` 的旧行（`cleared`）：旧画像是基于已经不存在/已过期的向量算出来的，留着它比没有画像更危险。

### 4.4 写入幂等与 CAS

- worker 每次都是全量重算（不增量），所以重放/重试天然幂等。
- upsert 的 `setWhere` 是 `excluded.computed_at >= computed_at`：两个 worker 并发处理同一用户时，只有更晚的 `computed_at` 能覆盖，更早的写入返回 0 行 → 结果标 `superseded`（不是错误）。`computed_at` 用**读取数据那一刻**的时间，不能用 worker 进程启动时间。
- **删除走同一把 CAS**：`delete ... where computed_at <= :computedAt`。否则「A 在 T1 算出无可用向量 → 删」会抹掉「B 在 T2 > T1 刚写好的更新画像」，用户的长期画像要等下一条行为才恢复。删掉 0 行时再读一次行区分 `empty`（本来就没有）与 `superseded`（被更晚的写入挡住）。

## 5. 调用链与降级

```
POST /recommendations/events（或服务端确证事件）
  → 事件落库
  → 对事件身份中的 user_id 投递 REFRESH_USER_INTEREST（匿名不投，只 console.error 不 500）
  → worker 轮询到 job → 全量重算 → upsert / delete

R3 召回时：readSessionInterest(...) → session 向量；findUserInterestProfile(...) → 长期向量
  → combined = α·session + β·longTerm（α/β 归 R3 实验，不在 R2 固定）
```

- 投递失败只记日志：行为埋点是主链路，画像重算是派生缓存，不能因为 jobs 写入失败让用户的事件上报变成 500。
- 画像缺失（无行 / `null` 向量）是**正常状态**，不是错误：R2 只负责明确返回 `null`，内容侧的冷启动组合（Fresh / Popular / 校园热门 / 愿望）归 R3。
- 服务端确证事件（CHAT_START / COMMENT / TRANSACTION_START / PURCHASE）在写入后同样触发重算，强正反馈不需要等用户再产生一条客户端事件。

## 6. 验证

```bash
bun test packages/contracts/src/recommendation/interest.test.ts \
  apps/api/src/modules/recommendation/interest.test.ts \
  apps/api/src/modules/recommendation/interest-queue.test.ts \
  apps/api/src/app.recommendation.test.ts \
  apps/worker/src/jobs/interest/handlers.test.ts
bun run typecheck
bun run lint
bun test --isolate
bun run core:smoke
```

- 契约单测：权重阶梯与零权名单一致、半衰期与时钟超前、单/多条归一化、负权反向、正负相抵归零、衰减下溢、维度不一致、顺序无关可复现、session 与长期对同一批行为给出不同方向。
- api 集成测试（scratch 库）：session 快速响应最近行为、无行为返回 null、曝光不占 session 条数窗、匿名与登录身份不互串、不可用向量分账、181 天外不进窗口。
- api 投递测试：同用户重复投递只留一条 `PENDING`、不同用户各一条、`DONE`/`RUNNING` 旧 job 不阻碍新投递、jsonb 是对象而非字符串标量。
- api 接线测试：登录用户行为 → 恰好一条待跑 job；匿名行为 → 不投递；服务端确证 CHAT_START → 投递。
- worker 集成测试（scratch 库）：写入行各字段、同 `now` 重跑幂等、更早 `now` 被 CAS 挡成 `superseded`、无可用向量 → `cleared` 且读回 null、无行为 → `empty`、异模型向量 → 无画像、坏 payload → `InvalidJobPayloadError`（FATAL 不重试）。

### 实跑记录（本地，worktree 专属库 `fish_323_r2`）

| 命令 | 结果 |
| --- | --- |
| 上面 5 个 R2 测试文件 | **72 pass / 0 fail / 329 expect** |
| `bun run typecheck` | 9 个包全部 Exit 0 |
| `bun run lint`（`bun run biome check .`） | Checked 831 files，无 error |
| `bun test --isolate` | **2386 pass / 5 fail**，232 files（70s）——5 条全部是 #322 既有的"向量版本毫秒并列"家族，已在 stash 基线复现（见下），与 R2 无关 |
| `EMBEDDING_TRANSPORT=stub bun run core:smoke` | **ok — 1 轮全部通过，232 项断言**（含 R1 归因链 13 项） |

上表是**通过对抗性审查并修完 F1/S1–S6 之后**的复跑口径（审查前的对应数字是 71 pass / 0 fail / 320 expect，其余各项相同）。全量套件在审查前的一次运行里是 2390 pass / 0 fail，同一批 `packages/db` / worker embedding 用例在后续运行里转成 5 条失败——这是一族**本机时序敏感**的既有用例，不是开关式的回归。

本地复现要点（环境事实，不入仓）：

- 本 worktree 用独立库 `fish_323_r2`（`create database` → `bun run db:migrate` → `bun run db:seed`）：共享开发库 `fish` 只应用了 27 条迁移，缺 #322/#323 的表列，直连会大量误报 `relation ... does not exist`。
- `core:smoke` 要按 CI 的配置跑（`.github/workflows/ci.yml:42` `EMBEDDING_TRANSPORT: stub`）。本地 `.env` 是 `live`，而线上 embedding 上游返回 1024 维、本仓 schema 是 `vector(1536)`，`Wish 与双向匹配` 步骤会失败——那是 #322 的 live 配置问题，与 R2 无关（R2 不碰 provider / 模型 / 维度）。
- 那 5 条失败（`packages/db/src/embeddings.test.ts` 的 `refreshEmbeddingSourceVersion`、worker 的 `EMBED_LISTING`/`EMBED_WISH` "编辑后重算"、以及 `#322 M3` 的两条候选新鲜度用例）同一个根因：**插入时 `updated_at` 由数据库 `now()` 写入（微秒），编辑时由应用侧 `new Date()` 写入（毫秒）**，两次写入落在同一毫秒时，应用侧毫秒值反而"更早"，于是 `saveEmbedding` 的 CAS `excluded.source_updated_at >= embeddings.source_updated_at`（`packages/db/src/embedding-store.ts:147`）与 `refreshEmbeddingSourceVersion` 的 `lt(...)`（同文件 `:430` 附近）都判失败。已用 `git stash push -u` 在**无 R2 改动**的 origin/main 基线上复现同样 3 条失败（`bun test packages/db/src/embeddings.test.ts apps/worker/src/jobs/embedding/handlers.test.ts` → 32 pass / 3 fail），随后 `git stash pop` 完整恢复，确认先存。
- R2 自己的用例最初也踩了同一个毫秒并列的坑（"先写向量再更新商品"来造过期），已改为显式把 `source_updated_at` 写成确定更早的时刻（`makeEmbeddingStale`），不再依赖时序。

已知边界（本轮不做）：

- 没有一条测试从"行为写入"一路跑到"画像落库"——两端分别由 api 投递测试与 worker handler 测试钉住，中间的契约是 `packages/contracts/src/recommendation/jobs.ts` 里同一份 payload schema；画像的消费（召回 / 排序 / 重排）与冷启动内容组合归 R3/R4。
- **换 `EMBEDDING_MODEL` 后的批量重建不在本轮**：换模型后旧向量全部计入 `model_mismatch`，用户下一次重算会走「无可用向量 → 删行」，于是长期画像在该用户产生下一条行为前是缺失的（读取返回 `null`，R3 走冷启动，不会返回错误结果）。embedding backfill 完成后**没有**补投 `REFRESH_USER_INTEREST` 的触发点——R2 按需求只保证"行为写入时投递"，批量补算归 R3/R6（与 #322 的 backfill 编排同一处收口）。
- `strategy_version` 只写不读：R2 没有长期画像的消费方，写入路径保证"版本变则重算"，是否按版本过滤留给 R3（见 `packages/contracts/src/recommendation/interest.ts` 的 `INTEREST_STRATEGY_VERSION` 注释）。
- 对抗性审查（全新子代理，只给改动范围 + 需求）提出 1 条必修（删除路径缺 CAS）+ 6 条建议，处理结果：F1 已修（删除也走 `computed_at` CAS，并新增"更晚写过的画像不会被旧一次重算删掉"用例）；S1 已修（原因判定先收齐行再定案，消除行序漂移）；S2/S6 已在文档与注释中明确归属；S3 已修（删掉无调用方的 `maxActions` 参数，条数窗只在 SQL 侧一处收口）；S4 已修（匿名不投递改为断言总行数不变 + 全表 `jsonb_typeof(payload)='object' and payload->>'userId' is not null`）；S5 已修（新增注入"一定抛错"投递口的用例，断言 `ingest` 仍成功、事件落库、只记一条日志）。
