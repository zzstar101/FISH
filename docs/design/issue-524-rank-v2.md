# Issue #524 — 推荐管线 v2（recall-v2 + rank-v2）

> 状态：**已实现，待 zzstar101 审核**。决策来自 Issue #524 下的逐条拷问（Owner 已逐项确认，见 §2）。
> 上游：#323 R1–R6（`docs/design/issue-323-r*.md`）。本文只写 v2 改了什么、为什么；v1 的整体结构仍以那几份文档为准。
> 基线：`origin/main = 49e2c2ce`。

---

## 1. 问题（#524 审计的 7 条）

| # | 现象 | 根因（v1） |
| --- | --- | --- |
| 1 | 语义召回、会话兴趣、长期画像在线上**全部落空**，且没有任何告警 | `apps/api/src/app.ts` 把拍照搜图的**视觉**模型名（`VISUAL_EMBEDDING_MODEL`）当成召回模型传给 `createRecommendationRecall`；`embeddings.model` 里是文本模型名，永远查不到行。`loadRecommendationEmbeddingModel()` 零调用方 |
| 2 | 热度可被单身份刷量 | `findPopularRecallCandidates` 对事件逐行求和，不按身份去重；匿名事件不带 `requestId` 也计入 |
| 3 | explore 配额从不兑现 | 重排只认 `recallSources[0] === 'explore'`，而 explore 是最低优先级通道、又与 fresh 高度重叠 |
| 4 | `rankScore` 跨候选不可比 | 只有"自己那一路"填 feature，其它候选的同一 feature 为 `null` → 按 0 计分 |
| 5 | 负反馈查询无上界 | `findNegativeFeedbackEvents` 拉回身份 180 天内全部事件再在 JS 里聚合 |
| 6 | 降级静默 | 候选为空 / 出错一律 `serveDegradedFeed`，不记原因、不打日志 |
| 7 | `rank_breakdown` 未对外暴露 | — （**本 PR 不做**，见 §2 Q2） |

## 2. 决策（Owner 确认）

| 编号 | 决定 |
| --- | --- |
| Q1 | 整条管线重写（召回只建候选池，排序对全池算特征，探索是重排的显式槽位） |
| Q2 | 边界：只重写服务端内部；Feed / events HTTP 契约只做加法；3 张推荐表只加不改（DB CHANGE REQUEST）；小程序 / web-pc 埋点不动；admin 指标与 `rank:eval` 继续可用。第 7 条（对外暴露原因 / 明细）**不做** |
| Q3 | 召回 ≤500 候选；之后对**每个候选**补算全部特征（semantic 在候选 id 内做 pgvector cosine，popularity / wish 按 id 批量取） |
| Q4 | 请求级不可用的特征（无画像 → semantic、无愿望 → wish、无行为 → category）**去掉权重并把剩余正权重归一回原总和**；候选级缺失（如商品没有向量）用**本次请求该特征的均值**补 |
| Q5 | 保留每 5 位 1 个（20%）显式探索位，位置由 `requestId` 哈希确定；只有探索池为空时才松弛并计数。探索池 = 近 7 天去重曝光身份数 < 20 的可见商品，池上限 50 |
| Q6 | 热度按 (商品, 身份, 事件类型) 去重；收藏改读 `favorites` 表；匿名事件只有归因到真实服务端快照才计入。只改聚合 SQL，不给事件表加去重索引 |
| Q7 | 负反馈在 SQL 里按类目 / 卖家聚合（卖家与硬排除只限本次候选）；快照仍 200 行；暂不建 ANN 索引（阈值见 §8） |
| Q8 | `recommendation_requests` 加可空 `degrade_reason`；结构化 JSON 日志 + 按原因的进程内计数 |
| Q9 | API 用 `loadRecommendationEmbeddingModel()`（`EMBEDDING_MODEL` 单一来源）；live 缺 `EMBEDDING_MODEL` 启动失败；启动后自检"库里有向量但没有一条属于当前模型" → `console.error` + 指标，不崩 |
| Q10 | 权重不变（semantic .35、category .2、wish / freshness / popularity 各 .15、repeatedExposure −.2、negativeFeedback −.3）；版本升到 `recall-v2` / `rank-v2`；**一个 PR**，直接替换 v1，不做双跑开关 |
| Q11 | `primary_source` = 把候选带进来的最高优先级通道；占了探索位的记 `explore` |
| Q12 | 用集成测试证明（含修复前失败的刷量回归）+ 附只读线上 SQL；部署后由 Owner 把结果贴回 Issue，agent 不部署 |

## 3. 管线

```
recall（6 路建池，≤500）
  → merge（去重、可见性复核、来源按优先级、exploreEligible）
  → enrichCandidateFeatures（对整池补算 semantic / wish / popularity）
  → loadNegativeFeedback（SQL 聚合，限本次候选）
  → scoreCandidates（请求级去权归一 + 候选级均值补）
  → rerankCandidates（卖家 / 类目打散 + 显式探索位）
  → 快照（primary_source：探索位记 explore）
```

复合版本串：`rec-v1-rule+interest-v1+recall-v2+rank-v2`（41 字符，`varchar(64)` 够用）。

### 3.1 召回与特征补算（`apps/api/src/modules/recommendation/recall/`）

- **embedding 模型**：`createApp` 新增末位参数 `recommendationEmbedding`（默认 `STUB_EMBEDDING_MODEL`，与 worker stub 同名），`index.ts` 传 `loadRecommendationEmbeddingModel()`。`STUB_VISUAL_EMBEDDING_MODEL` 不再出现在推荐装配里。
- **explore 通道**换成 `findUnderexposedRecallCandidates`：从可见商品出发，按 `(listing_id, occurred_at)` 索引逐个数近 7 天 `IMPRESSION` 的去重身份（只数到阈值为止，单次成本 ≈ 可见商品数 × min(曝光, 20)，不随全站曝光总量增长），`< RECALL_EXPLORE_MAX_EXPOSED_IDENTITIES (20)` 才入池，按曝光少 → 发布新 → id 排序，取 `RECALL_CHANNEL_LIMITS.explore (50)`。v1 的 new_listing / new_seller / cold_category 三块与相关常量删除。
- **merge**：`exploreEligible = recallSources.includes('explore')`（不再看第一来源）；本请求有类目画像时未命中类目记 `0`（可比），完全没有画像才是 `null`（请求级缺失）。六路上限之和 480 < 500，探索候选不会被截断掉。
- **enrichCandidateFeatures**（合并之后、排序之前，最多 3 条批量查询**并行**）：
  - semantic：`similarListingsByIds`（只认当前模型的新鲜向量）在候选 id 内算 cosine；没有向量的候选保持 `null`（候选级缺失）。
  - wish：本次有 wish 通道结果才批量取；未命中的候选记 `0`。没有愿望 → 整列 `null`。
  - popularity：同一 SQL 加 `listingIds` 限定；没有信号的候选记 `0`。
  - 任一批量失败：`console.warn`，并把该列**整列置 `null`**（请求级不可用 → 排序层去权归一），不让整次推荐失败。不保留通道原值：否则其余候选会被按"通道 Top-K 的均值"补齐，失败时反而整体抬高。

### 3.2 热度（`packages/db/src/recall-store.ts` `findPopularRecallCandidates`）

```
signals = union all(
  事件：按 (listing_id, event_type, 身份键) 分组，身份键 = 'u:'||user_id 或 'a:'||anonymous_session_id，
        权重 × 衰减(max(occurred_at))；只计 user_id 非空，或 (request_id, listing_id) 命中真实快照行的匿名事件
  收藏：favorites 表每行（每用户每商品唯一）POPULARITY_FAVORITE_WEIGHT(3) × 衰减(created_at)
)
popularity = sum(signals) × 商品年龄衰减
```

同一身份对同一商品的同一类行为最多计 1 次（=每身份上限），刷 30 次详情与看 1 次等价。`POPULARITY_ACTION_WEIGHTS.FAVORITE` 置 0（收藏改从表里算，不再双计）。

### 3.3 排序（`rank/score.ts`）

- `planFeatures(rows)`：某个特征在**全部候选**上都是 `null` → 该特征权重置 0，正权重按 `RANK_POSITIVE_WEIGHT_SUM / 剩余正权重和` 放大；负权重不动。部分候选缺失 → 用其余候选归一化值的均值补。
- `rank_breakdown.missing` 同时列出两类缺失（请求级的 weight 为 0）。因此"活跃登录用户的 missing 不含 semantic"只对**有向量的候选**成立；没有向量的商品仍会列 `semantic`（被均值补）。

### 3.4 负反馈（`aggregateNegativeFeedback`）

三条并行 SQL：类目权重（全部类目，行数 ≤ 类目枚举数）、卖家权重（只限本次候选的卖家）、硬排除（只限本次候选 id 的 `HIDE`）。衰减 `weight × 0.5^(age / INTEREST_HALF_LIFE_MS.longTerm)` 在 SQL 里算。返回行数由候选池上界决定，不再随用户历史增长。

### 3.5 重排（`rank/rerank.ts`）

- 每个长度 5 的窗口里，由 `fnv1a32(`${seed}:slot:${window}:${offset}`)` 排序选出 1 个**探索位**（seed = requestId，同请求可复现、不同请求位置不同）。
- 探索位只放 `exploreEligible` 的候选（按 `fnv1a32(seed:listingId)` 取最小者，不看分数）；池空才降为普通位并记 `relaxations.explore += 1`。
- 卖家 / 类目约束不变，松弛顺序仍按 `RERANK_RELAXATION_ORDER`。
- 返回 `exploreListingIds`，快照据此把 `primary_source` 记为 `explore`。

### 3.6 降级（`service.ts`）

| `degrade_reason` | 触发 |
| --- | --- |
| `recall_error` | 召回抛错；或候选为空且有通道 / 合并记了 `provider_error` |
| `no_candidates` | 召回正常但没有候选（冷启动，日志级别 `info`） |
| `rank_error` | 负反馈 / 打分 / 冷却 / 重排抛错 |
| `snapshot_write_failed` | 请求行 + 快照原子写失败 |

每次降级：写 `recommendation_requests.degrade_reason`、`metrics.recordDegradedFeed(reason)`、输出一行 JSON `{"event":"recommendation.feed_degraded","reason",…,"requestId","identity":"anonymous|user"}`。admin 指标 `guardrails` 新增 `degradedFeedReasons{noCandidates,recallError,rankError,snapshotWriteFailed}` 与 `embeddingModelMismatch`（契约只加字段）。

### 3.7 embedding 模型自检（`embedding-check.ts`）

`index.ts` 在 `Bun.serve` 之后跑一次：`embeddings` 里有商品向量、但没有一条 `model = EMBEDDING_MODEL` → `console.error` 事件 `recommendation.embedding_model_mismatch` + `embeddingModelMismatch = true`。空库算正常；查询失败只 warn。不让进程退出（推荐是旁路能力）。

## 4. DB 变更说明

- **表**：`recommendation_requests`
- **新增字段**：`degrade_reason varchar(32) NULL`；CHECK `recommendation_requests_degrade_reason_valid`：`degrade_reason IS NULL OR (strategy_version = 'rec-v1-none' AND degrade_reason IN ('no_candidates','recall_error','rank_error','snapshot_write_failed'))`
- **迁移**：`packages/db/src/migrations/20261102091620_spotty_vision.sql`（生成器产出）
- **使用场景**：降级请求的原因可查询、可统计（区分冷启动与故障）
- **对已有数据的影响**：无。新列可空，历史行全部为 `NULL` 且满足 CHECK；不改任何既有列 / 索引

## 5. 部署前提

API 进程现在读取 `EMBEDDING_TRANSPORT`（无默认值）与 live 时的 `EMBEDDING_MODEL`。按 `docs/deployment.md` §5，API 与 worker 都用 `--env-file=/srv/fish/.env`，worker 已依赖这两项，所以同一文件里已经有；若生产把它们放在 worker 专属文件里，需要同步给 API，否则 API 启动失败（报 `EMBEDDING_TRANSPORT` / `EMBEDDING_MODEL` 缺失）。

## 6. 验收对照

| Issue 验收项 | 证据 |
| --- | --- |
| API 用 `loadRecommendationEmbeddingModel` + 启动断言 + 单测 | `apps/api/src/index.ts`、`packages/shared/src/env.test.ts`「loadRecommendationEmbeddingModel（#524…）」、`embedding-check.test.ts` |
| 活跃登录用户 missing 不含 semantic、primary_source 有 semantic；画像被消费 | `app.recommendation.test.ts`「活跃登录用户：长期画像 × 商品向量真的进了排序」（把模型名换回视觉 stub 时实测失败：`missing` 含 `semantic`） |
| explore 可观测（约 20%） | `app.recommendation.test.ts`「探索位可观测」（前两个窗口各恰好 1 个 `explore`）；`rerank.test.ts`「explore 位（#524…）」 |
| 热度去重 + 每身份上限 + 修复前失败的回归 | `recall-store.test.ts`「#524 回归：单身份刷量…」「#524 回归：匿名事件只有归因到真实服务端快照才计入」 |
| 负反馈有界 + 测试 | `recall-store.test.ts`「aggregateNegativeFeedback」、`rank/feedback.test.ts` |
| 降级结构化日志 + 区分冷启动与错误 | `app.recommendation.test.ts`「没有任何候选 ⇒ no_candidates」、召回抛错 → `recall_error`、快照失败 → `snapshot_write_failed` |
| typecheck / lint / `bun test --isolate` | 见 PR 描述 |

## 7. v1 vs v2 对比（fixture）

`rank:compare`（`apps/worker/scripts/rank-compare.ts`）是 #322 匹配的对比脚本，`rank:eval` 只读线上快照，二者都不能离线对比推荐排序。因此对比以**固定 fixture 的回归用例**落地，每条都在 v1 上失败、v2 上通过：

| 场景 | v1 | v2 |
| --- | --- | --- |
| 单用户刷 30 次详情 vs 2 个真实用户各看 1 次 | 刷量商品第一（30 > 2） | 真实商品第一（1 < 2） |
| 伪造匿名事件（无快照归因） | 计入热度 | 不计 |
| 候选 A 有 semantic=1、候选 B 不在 semantic 通道 | B 的 semantic 按 0 计，A/B 差值被放大 | B 按请求均值补，列入 missing |
| 无画像的匿名请求 | semantic/wish 权重仍占 .5 但恒 0，`rankScore` 上限 .5 | 去权后正权重归一回 `RANK_POSITIVE_WEIGHT_SUM` |
| 候选来源 `['fresh','explore']` | 不算 explore，配额落空 | 可进探索位，`primary_source = explore` |
| 登录用户有画像 + 当前模型向量 | 模型名错配，semantic 全 missing | semantic 命中、出现在 `primary_source` |

## 8. 不做 / 后续

- 第 7 条（对外暴露推荐原因 / `rank_breakdown`）：Owner 决定不在本 PR 做。
- ANN 索引：当前线上商品量级（~22 条）exact scan 足够。**触发重估的阈值**：当前模型商品向量 > 5000 条，或 `pgvector` 延迟 P99 > 50ms（admin 指标 `latency`）。
- 事件表去重索引：不加（Q6），去重在聚合时做。
- 热度仍是每次请求现算（14 天窗口聚合，匿名事件多一次按 `request_id` 索引的快照归因 `EXISTS`）。流量上来后若 `findPopularRecallCandidates` 成为瓶颈，再改为 worker 定时预计算。
- 探索位按"排序后的位置"决定；`listCardsByIds` 在召回到出卡之间丢掉商品（极少：刚下架）时位置会重排，个别探索位可能挪到相邻窗口，不影响整体约 20% 的占比。
- 候选全部被负反馈隐藏时仍出一条空的 ranked 请求（沿用 v1），不算 `no_candidates` 降级：退回 newest 会把用户刚隐藏的商品又推回来。

## 9. 部署后只读核对 SQL

```sql
-- ① 读侧模型与库里向量是否一致（应只有 EMBEDDING_MODEL 一行或其占绝大多数）
select model, count(*) from embeddings where listing_id is not null group by model;

-- ② 最近 24h 登录用户的 v2 快照：semantic 缺失占比、primary_source 分布
select i.primary_source,
       count(*) as items,
       avg(case when i.rank_breakdown->'missing' ? 'semantic' then 1 else 0 end) as semantic_missing_rate
from recommendation_request_items i
join recommendation_requests r on r.id = i.request_id
where r.strategy_version = 'rec-v1-rule+interest-v1+recall-v2+rank-v2'
  and r.user_id is not null
  and r.requested_at > now() - interval '24 hours'
group by i.primary_source order by items desc;

-- ③ 探索位占比（前 20 位，期望约 20%）
select avg(case when i.primary_source = 'explore' then 1 else 0 end) as explore_rate
from recommendation_request_items i
join recommendation_requests r on r.id = i.request_id
where r.strategy_version = 'rec-v1-rule+interest-v1+recall-v2+rank-v2'
  and r.requested_at > now() - interval '24 hours'
  and i.position < 20;

-- ④ 降级原因分布
select coalesce(degrade_reason, '(legacy/null)') as reason, count(*)
from recommendation_requests
where strategy_version = 'rec-v1-none' and requested_at > now() - interval '24 hours'
group by 1 order by 2 desc;

-- ⑤ 刷量体检：14 天内单身份对单商品的事件数 Top 10（v2 只计 1 次/类型）
select listing_id, coalesce(user_id::text, anonymous_session_id::text) as identity, event_type, count(*)
from recommendation_events
where occurred_at > now() - interval '14 days'
group by 1, 2, 3 order by 4 desc limit 10;
```

---

由 AI agent 协助完成（DSH / claude-opus-5-5）。
