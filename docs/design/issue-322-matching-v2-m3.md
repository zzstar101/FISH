# #322 M3：Hybrid Ranking + acceptSimilar（设计说明）

> 阶段：M3（M1 = pgvector/embedding 基础，M2 = 向量候选召回，M4 = backfill/可观测/live 验证）。
> 分支：`feat/322-m3-hybrid-ranking`（stacked 在 `feat/322-m2-vector-recall` 之上）。
> 关联 Issue：#322（本 PR **不关闭** #322）。上游：#8（Matching v1）、#316（迁移 journal 门禁）。

## 0. Owner 看这里

1. **外部契约没变**：客户端仍只消费 `score: 0..100`（`MatchBaseSchema` 只有 `id/score/createdAt`）。
   M3 新增的两个字段只落库、只在 worker/内部可见。
2. **语义不是唯一分数**：`score` 仍是 0..100 的加权和，语义项只是其中一路；结构化硬过滤（状态、
   分类、价格边界、非自己商品）在召回前就已经生效，语义**不能**绕过它们。
3. **权重是证据冻的**：`SEMANTIC_WEIGHT_CANDIDATES` 里四组候选各跑一遍 12 条人工标注样本，只有
   S4 = `{semantic .30, category .32, keyword .15, price .23}` 与人工判断 12/12 一致（见 §7）。
4. **降级 = v1，不是新口径**：拿不到 cosine 时逐位退回 #8 的 `0.35/0.35/0.30`，并落
   `semantic_score = NULL`、`ranking_version = 1`；读侧据此能区分两种行。

## 1. 目标与非目标

**目标**

- `scoreMatch()` 增加一路 semantic 分（cosine → 0..100 的显式归一化），形成 hybrid 打分。
- `acceptSimilar` 从"无效字段"变成有可验证差异的门禁（§5）。
- `matches` 落 `semantic_score`（可空 smallint）与 `ranking_version`（NOT NULL，1|2），并给读侧
  留出"这行有没有语义分"的判定依据。
- 用人工标注样本冻结权重，并留下三档（v1 / semantic-only / hybrid）对比证据。

**非目标（留给后续阶段）**

- 不改召回面（`MATCH_SEMANTIC_TOP_K = 50` 与 M2 的候选集口径不动，见 §2 Q13）。
- 不建 ANN 索引（M2 已用 `explain (analyze)` 决策：5000 行 1536 维 exact scan 40.9 ms）。
- 不做 backfill / 真实 provider 的 live 语义质量验证（M4）。
- 不新增 `matches` 之外的 schema 变更，不改外部 `/matches` 契约。

## 2. 决策表（grilling Q1–Q16，逐条已确认）

| # | 决策 | 结论 |
|---|------|------|
| Q1 | M3 范围 | semantic 进分数 + `acceptSimilar` 门禁 + 两个新列 + 标注 fixture/三档对比 |
| Q2 | `acceptSimilar` 语义 | `false` 且 keyword 与 category **都未命中** ⇒ 语义分记 0（权重结构不变、不重新归一化） |
| Q3 | 归一化 | 分段线性锚点 `FLOOR = 0.5` / `CEILING = 0.95`，端点闭合，夹到 0..100 整数 |
| Q4 | 权重 | 四路 `{semantic, category, keyword, price}`，三组候选 S1/S2/S3 先跑对比 |
| Q5 | 阈值 | 默认仍 70；12 条样本下 70 与人工判断一致 ⇒ **不调阈值** |
| Q6 | 既有行补算 | 评估集合里"已有 match 但不在 Top-K"的行必须**按 id 精确补算 cosine**，否则会假降级 |
| Q7 | 语义可用性粒度 | 按**对**判定：目标有向量但候选没向量 ⇒ 这一对走 v1 口径（不是整轮降级） |
| Q8 | 降级口径 | 与 M2 的整轮降级一致：v1 公式 + `semantic_score = NULL` + `ranking_version = 1` |
| Q9 | 新列 | `semantic_score`（可空 0..100）、`ranking_version`（NOT NULL DEFAULT 1，仅 1\|2） |
| Q10 | fixture | 人工给定 cosine + 人工判断，12 条覆盖 Issue 点名的九类 |
| Q11 | 对照实验 | fixture + 专职测试 + 离线 `rank:compare` 脚本；semantic-only 只做对照、不进生产路径 |
| Q12 | core smoke | 加一条语义链：等 EMBED 落库 → 断言向量行/`semantic_score`/`ranking_version`；再用手工插入的相同向量证明"召回由向量而非 substring 决定" |
| Q13 | Top-K | `MATCH_SEMANTIC_TOP_K = 50` 不动（K 由展示量决定，与权重无关；重估留 M4） |
| Q14 | 打分入口 | `scoreMatch(listing, wish, semantic \| null)` 单入口；权重全在 `scoring.ts`，engine 只传 cosine |
| Q15 | 分支/PR | worktree `FISH-wt-322-m3`、分支 `feat/322-m3-hybrid-ranking`、PR base = M2 分支 |
| Q16 | 开工 | 按 Q1–Q15 实施 |

> 权重组的最终选择（S1/S2/S3 之外的 **S4**）是 Q4 的落地结果，依据见 §7。

## 3. DB 变更说明（CONTRIBUTING §6）

迁移：`packages/db/src/migrations/20260928223702_pale_toro.sql`（本分支 `drizzle-kit generate` 产出，
未手改；链在 M2 的 snapshot 之后）。

```sql
ALTER TABLE "matches" ADD COLUMN "semantic_score" smallint;
ALTER TABLE "matches" ADD COLUMN "ranking_version" smallint DEFAULT 1 NOT NULL;
ALTER TABLE "matches" ADD CONSTRAINT "matches_semantic_score_range"
  CHECK ("matches"."semantic_score" IS NULL OR ("matches"."semantic_score" >= 0 AND "matches"."semantic_score" <= 100));
ALTER TABLE "matches" ADD CONSTRAINT "matches_ranking_version_known"
  CHECK ("matches"."ranking_version" IN (1, 2));
```

- **数据迁移**：无。历史行由 `DEFAULT 1` 填 `ranking_version = 1`、`semantic_score` 保持 NULL ——
  与"v1 行没有语义分"的语义一致，不需要回填。
- **回滚**：`ALTER TABLE matches DROP COLUMN semantic_score; DROP COLUMN ranking_version;`（读侧只
  多读两列，去掉即回到 M2 行为）。
- **索引**：不加。两列都只在写路径与内部观测使用，`/matches` 的排序/过滤仍走既有索引。
- `db` 包不依赖 `contracts`（已核），所以 CHECK 里的 `1/2` 是字面量；`packages/contracts` 的
  `RANKING_VERSION_V1 / RANKING_VERSION` 是同一口径的唯一定义处，两处必须同步（改一处要改两处）。

## 4. 打分口径

`apps/worker/src/jobs/matching/scoring.ts` 是唯一入口：

```
scoreMatch(listing, wish, semantic: { similarity } | null)
  ├─ semantic === null → v1：#8 的 0.35/0.35/0.30（wish.category === null 时按 keyword+price 归一化）
  │                       semanticScore = null, rankingVersion = 1
  └─ semantic !== null → v2：S4 四路加权
                          semanticScore = acceptSimilar 门禁后 normalizeSimilarity(similarity)
                          rankingVersion = 2
```

- 归一化：`round(clamp((similarity - 0.5) / (0.95 - 0.5), 0, 1) × 100)`。锚点面向**真实** embedding
  （Issue 指出真实 cosine 集中在 0.6–0.95）；stub provider 的余弦落在 0.10–0.49，**尺度不可比**，
  所以不为它调锚点 —— stub 环境里语义项为 0 是预期行为（§9 的 smoke 断言据此写成与 provider 无关
  的**算式不变式**）。
- `wish.category === null`（"不限分类"）时，v2 只按 `semantic + keyword + price` 三路**归一化**
  （除以三者权重和），与 v1 对 category 的处理方式一致。
- 分数仍是 0..100 整数，`Math.round` 一次（与 v1 相同的收敛方式）。

> **M4 修订（已完成，本节上面的公式是 M3 口径）**：锚点按真实 `text-embedding-v4` 分布重标定为
> `SEMANTIC_SCORE_FLOOR = 0.42` / `CEILING = 0.70`；`nullCategoryMode` 从 `renormalize` 改成
> `'satisfied'`（"不限分类"不再摊薄结构证据，生效分类分按满分计入），`acceptSimilarGate` 从
> `keyword-or-category` 改成 `'keyword-only'`。`WEIGHTS_V2`（S4 = 0.30/0.32/0.15/0.23）与
> `MATCH_SCORE_THRESHOLD = 70` 未动。逐样本分数与一致度见
> `docs/design/issue-322-matching-v2-m4.md` §3。

## 5. `acceptSimilar` 门禁（Q2）

```ts
semanticAllowed = wish.acceptSimilar || keywordScore > 0 || categoryScore > 0
```

- `acceptSimilar = false`：只有**结构上确实对得上**（关键词命中或分类命中）才让语义分参与；
  否则记 0 —— 语义再高也不能只凭"语义相近"把近似商品推给一个明确说"不要相似品"的愿望。
- `acceptSimilar = true`：语义分照常计权。
- **权重结构不变**：被门禁拦下时记 0（不重新归一化），所以同一对的分数差异可直接归因于门禁。
- 12 条样本里唯一真正绑到这个门禁的场景是"不限分类 + 关键词 0 命中"：S4 下 `false` 得 34 分
  （不建 Match）、`true` 得 78 分（建 Match）—— 见 `ranking.test.ts` 的对照用例。

## 6. 按对判定与既有行补算（Q6/Q7）

- 语义分是**按对**计算的：目标实体有新鲜向量、候选实体也有同 model 的向量时，这一对走 v2；
  候选侧没有向量（或 M2 判定目标向量缺失/过期）时，这一对逐位退回 v1 口径。
- 评估集合 = M2 的「结构化收窄 ∩ 向量 Top-K ∪ 既有 matches 行」。**既有行不在 Top-K 里**时
  （掉出 Top-K、或超预算被收窄过滤掉），engine 用 `similarWishesByIds / similarListingsByIds`
  按 id 精确补算 cosine —— 否则这些行会被当成"没有语义"而降级，出现"分数掉下阈值、旧高分残留"
  或"假降级"。
- 补算是**一次批量查询**（`inArray`，无 LIMIT、无结构化过滤），不做逐行查询。
- **新鲜度不变量（#338 评审 blocker，判据在 #333 第二轮复审后改为内容指纹）**：只有"描述的就是当前
  实体内容"的向量才允许进召回与打分。
  - **主判据 = 写路径按内容指纹失效**（M2 §13 第二轮）：实体内容一变，写路径就在同一执行器里删掉该实体下
    `content_hash` 与当前文本指纹不符的向量行（`pruneStaleEmbeddings()`），所以"行还在"等价于"它描述的是
    当前内容"，与时间戳精度无关，也不取决于 worker 何时跑到 `EMBED_*`。
  - **时间戳谓词是纵深防御**：候选侧仍带
    `date_trunc('milliseconds', embeddings.source_updated_at) = date_trunc('milliseconds', <实体>.updated_at)`
    （`freshListingsEmbedding()` / `freshWishesEmbedding()`，见 `packages/db/src/embedding-store.ts`），
    兜住"某个写路径忘了调 prune"的情形。实体被编辑后、`EMBED_*` 还没跑完（或失败）时，旧向量
    **不进 Top-K**（不占 K 名额），也**不被按 id 补算**去算 hybrid 分 ⇒ 这一对退回 v1 口径
    （`ranking_version = 1`、`semantic_score = NULL`）。
  - 目标侧仍用更精确的判据（`content_hash` 与当前文本指纹一致）。
  - 按毫秒截断是必须的：库里 `updated_at` 是微秒精度（`now()`），而 JS `Date` 只有毫秒精度，handler
    读出来再写进 `source_updated_at` 时已经截断，直接等值比较会**永远不成立**（所有候选都被误判过期）。
  - 内容没变但实体版本前进（改价/改状态这类不碰 embedding 文本的编辑）由 handler 的
    `refreshEmbeddingSourceVersion` 推进标记——两个守卫（指纹一致 + 版本只前进）保证它不会把旧向量
    写成新的。

## 7. 权重冻结证据（Q4/Q5）

- fixture：`apps/worker/src/jobs/matching/ranking-fixture.ts` —— 12 条人工标注样本（人工给定
  cosine + 人工判断 + 理由），覆盖 Issue 点名的九类：exact-lexical、chinese-synonym、brand-model、
  description-only、semantic-category-mismatch、semantic-over-budget、accept-similar-false、
  accept-similar-true、unrelated。
- 对照脚本：`bun run rank:compare`（`apps/worker/scripts/rank-compare.ts`，不出网、不需要 DB）打印
  分数对照表、与人工判断的一致性、按 cosine 的召回顺序、各组权重下的排序。

| 样本（cosine / 人工判断） | v1 | sem-only | S1 | S2 | S3 | **S4** |
|---|---|---|---|---|---|---|
| k380-exact-lexical（.93 ✅） | 100 | 96 | 99 | 99 | 98 | **99** |
| textbook-partial-keyword（.90 ✅） | 83 | 89 | 84 | 83 | 86 | **89** |
| k380-synonym-same-category（.88 ✅） | 65 | 84 | 70 | 67 | 74 | **80** |
| airpods-brand-model（.91 ✅） | 65 | 91 | 72 | 68 | 76 | **82** |
| k380-description-only（.86 ✅） | 100 | 80 | 94 | 96 | 92 | **94** |
| keyboard-books-category-mismatch（.88 ❌） | 65 | 84 | **70**✗ | 67 | **74**✗ | **63** |
| k380-over-budget（.90 ✅） | 77 | 89 | 81 | 82 | 80 | **79** |
| any-category-similar-false（.90 ❌） | 46 | 89 | 27 | 29 | 25 | **34** |
| any-category-similar-true（.90 ✅） | 46 | 89 | **62**✗ | **54**✗ | 70 | **73** |
| any-category-synonym（.87 ✅） | 46 | 82 | **59**✗ | **52**✗ | **66**✗ | **70** |
| unrelated-textbook-keyboard（.15 ❌） | 30 | 0 | 20 | 20 | 20 | **23** |
| unrelated-lamp-keyboard（.32 ❌） | 46 | 0 | 27 | 29 | 25 | **34** |
| **与人工判断一致** | 8/12 | 8/12 | 9/12 | 8/12 | 10/12 | **12/12** |

（加粗 = 误判：该建 Match 的没建、或不该建的建了。v1 与 sem-only 只作对照，不参与选型。）

选型理由（逐条）：

- **S1/S2 被硬约束淘汰**：`不限分类 + 关键词 0 命中` 时它们的天花板分别是 `(0.30×100 + 0.20×100)/0.75
  = 67` 与 `(0.20×100 + 0.20×100)/0.70 = 57`，**数学上不可能**过 70 —— 而 Issue 的验收要求"愿望
  描述真正参与、无 substring 也能召回"。S1 还把"分类不符但关键词命中"误判成 70。
- **S3 淘汰**：语义权重 0.40 让"分类不符 + 语义 0.88"误判成 74，且 `any-category-synonym` 仍漏判。
- **S4 冻结**：结构权重和 = `0.32 + 0.15 + 0.23 = 0.70`，因此"结构全中 + 语义 0"恰好压线 70
  （stub 环境下的 demo 对因此仍可见）；同时"不限分类 + 关键词 0 命中"的上限 `(0.30×100 + 0.23×100)
  / 0.68 ≈ 77.9`，语义够高就能召回。12/12 与人工判断一致。
- 阈值 70 在 S4 下**不需要动**：`MATCH_SCORE_THRESHOLD` 保持 70，`ranking.test.ts` 里 12 条样本
  的判定与人工判断逐条一致。
- **口径说明（#338 评审非 blocker）**：上表的 cosine 是**人工给定**的 fixture 值，用来钉住"给定
  相似度时权重如何决定判定"。因此本阶段冻结的是**算法口径**（四路权重、锚点、门禁、阈值），
  **不是**对真实模型语义质量的验证——12/12 是"fixture 与人工判断一致"，不等于"真实 provider 下
  的中文同义/品牌型号样本也 12/12"。真实分布的校准（含锚点 `0.5/0.95` 与 K）属 M4 live 验证。
- **M4 修订（已完成）**：上表 **S4 列的分数是旧锚点 `0.5/0.95` 下的值**，只用于比较权重方案，
  不代表现行排序。M4 用 57 条冻结标注对在真实 `text-embedding-v4` 上重标定，锚点改为 `0.42/0.70`，
  并调整两处门禁口径（`nullCategoryMode: 'satisfied'`、`acceptSimilarGate: 'keyword-only'`）；
  **权重 S4 与阈值 70 不变**。新口径下的一致度（39/57 → 53/57）与逐样本分数见
  `docs/design/issue-322-matching-v2-m4.md` §3，复算：
  `bun run embed:eval -- --sections=calibration`（需 live provider）/ `bun run rank:compare`。

## 8. 可观测（Q8/Q9）

- `matches.semantic_score`：这一行的语义分（0..100，v1 行为 NULL）。
- `matches.ranking_version`：`1` = v1 口径（无语义分），`2` = hybrid 口径。
- `MatchRunResult` 已带 M2 的 `recall / fallbackReason / vectorCandidates`（worker 内部），M4 的聚合
  指标直接在其上叠加，不需要新表。
- 日志不打印向量本身、不打印完整私密描述（M1 已确立）。

## 9. 验收清单映射

| Issue 验收项 | 本阶段状态 | 证据 |
|---|---|---|
| semantic 进入最终分数 | ✅ | `scoring.test.ts`（v1/v2 分支）、`engine.test.ts`（落库断言） |
| 保留 v1 全部 feature（category/keyword/price） | ✅ | `scoring.test.ts` 的 v1 分支用例逐位复算 #8 算法 |
| `acceptSimilar` 有可验证差异 | ✅ | `ranking.test.ts` 对照用例（34 vs 78）、`scoring.test.ts` 门禁用例 |
| 结构化硬规则不被语义绕过 | ✅ | `ranking.test.ts`（分类不符仍低于阈值）、`engine.test.ts`（收窄在召回前） |
| 人工标注 fixture + 三档对比 | ✅ | `ranking-fixture.ts` + `rank-compare.ts` + §7 表 |
| 权重/阈值基于证据冻结 | ✅ | §7（S4 12/12，阈值保持 70） |
| 分数兼容（客户端只消费 0..100） | ✅ | `MatchBaseSchema` 未改；新字段只落库 |
| 既有行掉出 Top-K/变低后能降级不残留 | ✅ | `engine.test.ts`（65 分覆盖 100 分、NULL/1 落库） |
| 候选向量过期时不得参与召回/打分（#338 评审 blocker） | ✅ | `embeddings.test.ts`（Top-K 与 by-ids 排除过期向量、`refreshEmbeddingSourceVersion` 三个守卫）、`engine.test.ts`（编辑候选后旧向量不进 Top-K、已有行退回 v1、重算后恢复 v2）、`handlers.test.ts`（改价后 `unchanged` 仍推进版本标记） |
| core smoke 覆盖一条语义匹配链 | ✅ | `apps/api/scripts/core-smoke.ts` 的「语义链」一节（零词法重叠 → 85 分） |
| 无 substring 的语义近似可召回 | ⏸ 部分 | smoke 用手工向量证明**召回由向量决定**；真实模型的语义质量属 M4 live 验证 |
| backfill / 真实 provider live smoke | ⏸ M4 | 不在本阶段 |

## 10. 交给 M4 的清单

1. `MATCH_SEMANTIC_TOP_K = 50` 的重估：用真实数据量 + recall@K / latency 对照。
2. ANN（HNSW）决策复核：M2 的触发条件是 p95 > 50 ms 或带向量实体 > ~10 万行。
3. 真实 provider 的语义质量：中文同义/品牌型号样本在 live 模型下的分数与人工判断一致性
   （本阶段的锚点 `0.5/0.95` 需要按真实分布复核）。
4. backfill 脚本：给历史 ACTIVE 实体补 embedding，并触发 match 重算（历史行会从 v1 升到 v2）。
5. seed 的 demo 对仍是 v1 行（seed 按 #43 契约只投 `MATCH_LISTING`、不投 `EMBED_*`）：M4 的
   backfill 或 seed 调整会让它变成 v2。
6. `jobs_match_wish_wish_id_pending_uidx` 的失败补投（M2 已修"终身一条"，M1 遗留的"3 次失败后
   无补投"仍在）。
7. 聚合观测：embedding 请求数/失败率/latency、content-hash 命中率、Top-K latency、hybrid
   matched/downgraded 计数、每次运行所用 model/ranking_version。

> **M4 状态（见 `docs/design/issue-322-matching-v2-m4.md` §10）**：1 ✅（recall@10–200 全 1.0、
> 正确对最差排名 3 ⇒ 保留 `MATCH_SEMANTIC_TOP_K = 50`）；2 ✅（当前不建 HNSW，触发条件实测固化为
> p95 > 50 ms 或 ~10 万行向量）；3 ✅（锚点重标定为 `0.42/0.70`，57 条冻结标注一致度 39/57 → 53/57）；
> 4 ✅（`bun run embed:backfill`，live 6 实体 + 幂等重跑 0 provider 请求）；5 ✅ **条件式**：seed 契约
> 仍未动，`embed:backfill`（默认 `--entity=both`）把两侧向量补齐后该对才升到 v2——只补商品侧不够，
> v2 要求两侧都有新鲜向量（M4 §6.1 末尾，实证 `.m4-evidence/backfill-v1-to-v2.log`）；6 ✅ 已修：M4 新增
> 有界补投 `apps/worker/src/jobs/embedding/requeue.ts`（额度 3 条 / 24 h / 60 s 延后 / `NOT EXISTS
> PENDING` 去重），`apps/worker/src/index.ts` 在 `FAILED` 结算与启动回收两处触发，决定写进 stderr 的
> `embed.retry` 事件；7 ✅（`bun run obs:summary`，四组事件）。

## 11. 本地验证命令

```bash
bun run db:up && bun run db:migrate        # 本分支迁移（matches 两列 + 两条 CHECK）
bun run typecheck                          # 9 个包
bun run lint                               # biome check .
bun test --isolate                         # 全量（真库集成测试需要 DATABASE_URL）
bun test apps/worker/src/jobs/matching     # 打分 + 召回 + 落库断言
bun run rank:compare                       # 权重对照（不出网、不需要 DB）
bun run core:smoke                         # 端到端（含语义链一节）
```

M4 追加的复算命令（`bun run embed:backfill` / `obs:summary` / `ann:probe` /
`embed:eval -- --sections=calibration,recall,fit`）与证据文件清单见
`docs/design/issue-322-matching-v2-m4.md` §11。

## 12. stacked PR 与合并顺序

- M1（#328）→ M2（#333）→ 本 PR（M3）是 **stacked**：base 分别是上一层分支，合并顺序必须
  从下往上；本 PR 不写 `closes #322`。
- 每层都带自己的迁移（M1 = embeddings + 索引、M2 = 索引替换、M3 = matches 两列），
  snapshot 的 `prevId` 链必须连续 —— 上层 rebase 到最新 main 后要**重新 generate**，不能把两条
  sibling snapshot 直接拼进 journal（`migrations-journal.test.ts` 会红）。
- 本 PR 的 `matches` 迁移链在 M2 snapshot 之后；M1/M2 已审过的迁移在本分支不动。

## 13. 评审修复（#338）：候选向量新鲜度不变量

评审（zzstar101，针对 HEAD `3988afb`）指出的 blocker：M2 的 `topKSimilarListings/Wishes` 只按
`model` + 结构化条件筛，M3 新增的 `similarListingsByIds/similarWishesByIds` 只按 model + id 取
cosine，**都没有验证向量是否对应当前实体内容**。后果有三：①Top-K 仍按旧内容向量排序，过期候选会
挤掉新鲜候选；②旧 cosine 被送进 `scoreMatch(..., semantic)`，与当前的价格/分类事实拼成"混合版本"
的分；③既有行的按 id 补算把过期 cosine 当 v2 真值。

修法（统一在向量读路径上建立不变量，而不是在每个调用点各判一次）：

| 位置 | 改动 |
|---|---|
| `packages/db/src/embedding-store.ts` | 新增 `freshListingsEmbedding()` / `freshWishesEmbedding()`（毫秒截断的版本相等谓词）；`topKSimilar*` 与 `similar*ByIds` 的 `where` 全部带上它 |
| 同上 | 新增 `refreshEmbeddingSourceVersion()`：把"内容指纹仍然一致"的向量行的版本标记推进到实体当前版本（两个守卫：指纹一致 + 版本只前进） |
| `apps/worker/src/jobs/embedding/handlers.ts` | `unchanged` 分支调用 `refreshEmbeddingSourceVersion`：内容没变但实体版本前进（改价/改状态）时，不推进就会让仍然正确的向量被候选侧判成过期 |
| 引擎 | 不需要改：召回与补算都被 SQL 谓词挡住，`similarities` 里没有这一对 ⇒ 自动退回 v1 口径 |

- **为什么按毫秒截断**：`updated_at` 是微秒精度（`now()`），JS `Date` 只有毫秒——handler 读实体后
  写进 `source_updated_at` 的值已被截断，直接等值比较几乎永不成立（第一次实现就是这样，全部候选被
  误判过期，6 条既有用例当场变红）。毫秒是应用层能表达的精度，也就取它作为比较精度。
- **为什么不用"写前重读实体"**：那只能在写入侧收敛，召回侧的排序问题（过期候选挤掉新鲜候选）依旧
  存在；判据放在读路径上，召回与打分同时被覆盖。
- 回归证据：`packages/db/src/embeddings.test.ts`（过期向量不进 Top-K、by-ids 同样过滤、重算后恢复、
  `refreshEmbeddingSourceVersion` 的三个守卫）、`apps/worker/src/jobs/matching/engine.test.ts`
  的 `describe('候选向量新鲜度（#322 M3 评审 blocker）')`（已有行退回 v1 → 重算后恢复 v2；没有既有行
  时过期候选连"新建"都进不来）、`apps/worker/src/jobs/embedding/handlers.test.ts`（只改价格时
  `unchanged` 且版本标记跟上实体）。

### 13.1 后续修订（#333 第二轮复审）：主判据改为内容指纹

上面这一轮的判据是**版本号相等**，但实体 `updated_at` 由应用侧 `new Date()` 写入（毫秒分辨率）——
同一毫秒内的两次编辑内容不同、版本号却完全相同，旧向量仍会被判成新鲜。这一条在 #333 的第二轮复审里
被指出，修法落在 M2 分支（`prune-on-write`：写路径删掉 `content_hash` 与当前指纹不符的行，
`pruneStaleEmbeddings()`），本 PR rebase 后即继承：

> **M4 修订**：`updated_at` 现统一由数据库 `now()` 写入（插入与更新同源），上面"应用侧 `new Date()`"
> 的描述已过时；**本节的结论不变**——主判据仍是内容指纹，版本号只是纵深防御。跨时钟比较带来的另一个
> 后果（编辑后 `updated_at` 可能小于已存 `source_updated_at`，导致合法重算被 CAS 静默丢弃）也已一并
> 修掉，见 `docs/design/issue-322-matching-v2-m4.md` §9。

- **主判据**：写路径内容指纹失效（"行还在"⇒"描述的是当前内容"）；
- **本 PR 的 `fresh*Embedding()` 谓词与 `similar*ByIds` 的 `where`**：降级为纵深防御，兜住"某写路径
  忘了调 prune"的情形；毫秒截断原因不变；
- **引擎与打分口径不变**：进不了召回/补算的候选依旧退回 v1（`ranking_version = 1`、
  `semantic_score = NULL`），所以 M3 的 hybrid 分数不会用到任何"旧语义"。

细节与回归证据见 `docs/design/issue-322-matching-v2-m2.md` §13 与 §5。
