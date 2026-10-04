# #322 M4：backfill / 可观测 / live 验证（设计说明）

> 阶段：M4（M1 = pgvector + embedding 基础，M2 = 向量候选召回，M3 = Hybrid Ranking）。
> 本阶段对应 Issue #322 的「M4 — backfill / observability / live validation：批量重建、指标与日志、
> live provider smoke、性能 / recall 对照」。
> 上游文档：`docs/design/issue-322-matching-v2-m1.md`、`-m2.md`、`-m3.md`。
> 本 PR **不写 `closes #322`**：M4 是 #322 的最后一段，但是否关闭由 Owner 决定。

## 0. Owner 看这里

1. **四个运维脚本**（`embed:backfill` / `obs:summary` / `ann:probe` / `embed:eval`）负责回填、聚合与对照；
   本阶段也包含运行时观测、参数标定、EMBED 结算后补投、时钟及显式约束门禁，不能声称只改脚本。
2. **参数在真模型尺度上重标定**：锚点 `0.5/0.95 → 0.42/0.70`，外加两处门禁口径（不限分类不再摊薄
   结构证据、`acceptSimilar=false` 只认关键词）。权重（S4）与阈值 70 **不动**。依据是 57 条冻结标注对
   的实测 cosine，一致度 `39/57 → 53/57`。
3. **时钟根因修复**（跨范围，Owner 明确要求顺手做）：`updated_at` 的写入从"插入 DB 钟 / 更新应用钟"
   更新版本改取 DB `clock_timestamp()`（插入默认不变），避免事务开始顺序与取得行锁顺序反转。
   详见 §9；队列 `run_at` 的调度协议不变。
4. **ANN 复核结论：当前不建生产索引**。旧合成语料每批重复一条向量，其曲线已撤回；§5 是逐行独立
   采样且验证 distinct 数量后的新探针，1 万行 exact p95=102.017ms。触发线仍为 p95>50ms 或约10万行；
   合成语料不是生产语料，HNSW recall/计划必须一起报告，不能只看延迟。
5. **完整 57 条主指标：53/57，FP=3、FN=1**。四条是当前算法错误，不是标签矛盾，不从分母排除。
   旧冻结实现的N验证达门禁，但最终审查BLOCK后再次修复；当前实现需新独立验证与fresh复审，见 §13。

## 1. 目标与非目标

M4 要回答四个问题，每个问题都必须有**可复算的证据文件**（`.m4-evidence/`，见 §11）：

| 问题 | 交付 |
|---|---|
| 历史 ACTIVE 实体怎么补 embedding 并升到 v2 | §6 `embed:backfill` + live 实测 |
| 线上怎么知道"语义链是否健康" | §7 `obs:summary` + 事件日志 |
| 真实 provider 下参数还成立吗 | §3 重标定 + §4 recall 对照 + §8 live 端到端 |
| 现在的规模需要 ANN 吗 | §5 `ann:probe` |

非目标（明确不做）：

- 不改召回算法、不改权重与阈值（M3 冻结）、不动外部 API 契约与前端。
- 不在本阶段建生产 HNSW 索引（理由见 §5）。
- 不改 seed 契约（§10.5 的 demo 对仍由 backfill 提升，见 §12）。

## 2. 交付物

| 交付物 | 命令 | 出网 | 需要 DB |
|---|---|---|---|
| `apps/worker/scripts/backfill-embeddings.ts` | `bun run embed:backfill` | ✅（真 provider）/ stub | ✅ |
| `apps/worker/scripts/obs-summary.ts` | `bun run obs:summary` | ❌ | ✅ |
| `apps/worker/scripts/ann-probe.ts` | `bun run ann:probe` | ❌ | ✅（只建临时表） |
| `apps/worker/scripts/embed-eval.ts` | `bun run embed:eval` | ✅ | ❌ |
| `apps/worker/src/jobs/matching/calibration-pairs.ts` | 被 `--sections=calibration` / `fit` 使用 | — | — |

运行时代码（被上面这些脚本与生产路径共用）：

| 位置 | 改动 |
|---|---|
| `apps/worker/src/log.ts`（新增） | 结构化观测出口：一条事件 = 一行 JSON；私密文本只以 `contentHashOf()` 指纹 + 长度出现，**不写用户文本与向量** |
| `apps/worker/src/index.ts` | 事件接线：`worker.started` / `worker.recovered` / `job.settled`（带 model、rankingVersion、`MatchRunResult`，`worker.started` 另带 #324 视觉 provider 的 transport / model / dimensions），把 provider 的 `embed.request` 与 handler 的 `embed.entity` 输出到 stdout/stderr |
| `apps/worker/src/jobs/embedding/handlers.ts` | 每个实体一行 `embed.entity`（`generated` / `unchanged` / `stale` / `missing`） |
| `apps/worker/src/jobs/embedding/providers/live.ts` | 显式发 `dimensions`（端点默认 1024，与迁移的 `vector(1536)` 不符）；`onRequest` 观测回调（条数/尝试/耗时/分类/上游 status） |
| `apps/worker/src/jobs/matching/engine.ts` | `MatchRunResult` 增加 `topKLatencyMs`（§5 的 ANN 触发条件的观测项） |
| `apps/api/src/modules/{listings,wishes}/…`、`governance/service.ts` | 投递顺序不变量：`EMBED_*` 必须先于 `MATCH_*`（§6.1） |

根 `package.json` 新增四行（形状与既有 `core:smoke` / `rank:compare` 一致）；Bun 自动读 cwd 的
`.env`，所以脚本不需要额外加载环境变量。

## 3. 标定：在真实 cosine 尺度上重标定参数

### 3.1 为什么必须重标定

M3 的 `0.5/0.95` 来自**人工给定的** cosine 估计值（M3 §7 口径说明已写清：那 12/12 只证明"给定相似度
时权重如何决定判定"）。真实 `text-embedding-v4` 的尺度完全不同：57 条标注对的实测 cosine 全部落在
**0.274–0.819**，真匹配 p50 只有 **0.639**、无关对最高也能到 **0.716**。旧刻度把 cos **0.566–0.713**
的真匹配压成 semanticScore **15–47**（×0.30 权重只加 4.5–14 分），18 条"标签=匹配"的对因此总分只有
**34–69**（其中 14 条落在 60–69、4 条不到 60）；旧锚点下 v1 口径只在其中 2 条上会建行，其余 16 条
v1 也判否（v1 = 0.35×category + 0.35×keyword + 0.30×price，见 `apps/worker/src/jobs/matching/scoring.ts:20`
的 `WEIGHTS_V1`；不限分类时把 category 权重按比例摊给其余两项），所以这批漏判不是 v2 独有的。

### 3.2 标定集

`apps/worker/src/jobs/matching/calibration-pairs.ts`：`CALIBRATION_ROWS` = **57 行**

- 12 行 = M3 冻结 fixture（id 与 M3 相同，带 `m3Similarity` 供对照）；
- 45 行 = M4 新增，覆盖同义改写、品牌/型号、只描述命中、不限分类、`acceptSimilar` 两态、超预算、
  分类不符、无关对、以及刻意的边界对；
- 4 行标 `needsOwnerDecision`（`cal-unlimited-cup`、`cal-bound-k580-keyboard`、
  `cal-bound-airpods3`、`cal-bound-powerbank-charger`），由 Owner 逐条裁决后**冻结**：
  `cal-unlimited-cup` = 匹配，其余 3 条 = 不匹配。
- 冻结标签：**32 匹配 / 25 不匹配**。评审表渲染在 `.m4-evidence/calibration-review.md`。

### 3.3 三处改动

| 位置 | 旧 | 新 | 依据 |
|---|---|---|---|
| `packages/contracts/src/matching/schema.ts:77-78` | `0.5 / 0.95` | `SEMANTIC_SCORE_FLOOR = 0.42` / `CEILING = 0.70` | 真实 cosine 分布 + 一致度 |
| `scoring.ts` `nullCategoryMode` | `renormalize` | `satisfied` | 不限分类时不能用"摊薄"惩罚结构证据 |
| `scoring.ts` `acceptSimilarGate` | `keyword-or-category` | `keyword-only` | 分类等值不算结构证据（`acceptSimilar=false` 要更严） |

**不动**：`WEIGHTS_V2`（S4 = 0.30/0.32/0.15/0.23）、`MATCH_SCORE_THRESHOLD = 70`、
`MATCH_SEMANTIC_TOP_K`（§4 复核后保留 50）。`DEFAULT_SCORING_PARAMS`
（`apps/worker/src/jobs/matching/scoring.ts:78-83`）只改这三处的默认值，公式一行未动。

附带的口径差异（`nullCategoryMode` 的副作用，`scoring.ts:301` 与 `:327`）：写进
`matches.category_score` 的这一列，**v1 行存的是原始分类分**（不限分类时为 0），**v2 行存的是生效
分类分**（不限分类 + `satisfied` 时为 100）。这一列只入库供引擎与重算使用，不上线（契约只暴露
总分，M3 §8 已冻结），所以不影响前端；但做数据核对时不要把两版的同名列直接相加或平均。

### 3.4 结果

| 口径 | 一致度 | 备注 |
|---|---|---|
| M3 参数（基线） | 39/57（0.684） | 误判全是漏判（18 条假阴性、0 假阳性） |
| **M4 参数** | **53/57（0.930）** | FP=3、FN=1；人估 cosine 的 M3 打分 fixture 仍12/12，不等于 live 质量12/12 |
| v1 口径对照 | 37/57（0.649） | `--sections=calibration` 内的 v1 对照 |
| 网格搜索（`--sections=fit`） | 122,880 组候选 | 网格最优 = `floor .25 / ceiling .60` + 权重重排 `{.20,.30,.20,.30}` + 阈值 75 → 同样 53/57（但 fp 3 / fn 1） |

关于"为什么不动权重与阈值"：网格里的权重是**十分位整数解**（四个权重各占 20 份），而 S4 =
`{.30,.32,.15,.23}` 不在这个网格上，所以"网格最优"不是一个可直接采用的点。实测下来两个候选
**一致度打平**：`--sections=fit` 的 `baseline`（即当前常量：0.42/0.70 + S4 + 阈值 70 +
`satisfied`）是 53/57（fp 3 / fn 1），网格最优点（`floor .25 / ceiling .60` + 权重重排
`{.20,.30,.20,.30}` + 阈值 75 + `keyword-only`）也是 53/57（fp 3 / fn 1）；两者的 4 条残差
**都是 §3.5 那 4 条 `knownDivergence`**，只是分数不同（当前常量 57/81/85/75，网格点
70/80/80/80）。既然一致度相同，Owner 选改动面更小的前者——只改 §3.3 那三处，不碰权重与阈值。
所有57条均计入主指标，包括4条错误；不再输出排除后的全对口径。
这是已参与调参的标定集，不能据其一致度证明独立泛化质量。

分离度证据：真匹配 p25 = 0.6124，无关对最大 = 0.7156，**separation = −0.283** —— cosine 单独
无法分开这两类，这正是不把 semantic 当唯一分数的实测依据（M3 §6 的设计原则 3 在这里被数据确认）。

floor 的语义被一并量化：`floorMisfires = 0`（没有任何"建议匹配"的对低于 floor）、
`floorLeaks = 20`（floor 只保证"明显无关的不进来"，不负责判否——判否由阈值 70 与结构项负责）。

### 3.5 4 条已知算法错误（保留历史标注名 `knownDivergence`）

| 样本 | cos | M4 分数 | 冻结标签 | 错误 |
|---|---|---|---|---|
| `any-category-similar-true` | .4327 | 57 | 匹配 | 假阴性：现有分数未召回应匹配的商品 |
| `cal-bound-k580-keyboard` | .6647 | 81 | 不匹配 | 假阳性：未满足机械键盘需求 |
| `cal-bound-airpods3` | .7156 | 85 | 不匹配 | 假阳性：缺少明确需要的降噪功能 |
| `cal-bound-powerbank-charger` | .605 | 75 | 不匹配 | 假阳性：相关用途被误当成所需商品 |

这些是当前模型/特征的能力限制，不是人工标签矛盾，也不是证明所有算法都无解。
标签不改、样本不删。calibration 主报告保留57条，直接输出 falsePositiveIds/falseNegativeIds 与计数。

## 4. 召回面：`MATCH_SEMANTIC_TOP_K` 重估

`bun run embed:eval -- --sections=recall --corpus=5000 --seed=20260929`：

| 指标 | 值 |
|---|---|
| recall@10 / @20 / @50 / @100 / @200 | **1.0 / 1.0 / 1.0 / 1.0 / 1.0** |
| 正确对的排名分布 | min 1 / p25 1 / p50 1 / p75 1 / max **3** |
| 植入正例的 cosine | min .5574 / p50 .6923 / max .7735（全部 > floor .42） |
| 耗时 | 364.7 s（5000 条真实向量 + 20 条植入，精确扫描） |

**结论：保留 `MATCH_SEMANTIC_TOP_K = 50`。** 正确对的最差排名是 3，理论上 K 可以小得多；保留 50 是
给"同一商品多份同义改写描述挤占前排"留余量，而 K=50 的代价在当前规模下由 §5 的无索引精确扫描承担。

## 5. ANN（HNSW）决策复核

**旧1万/5万/10万行曲线撤回**：原 synthetic SQL 的非关联 scalar subquery 被一次求值，每批大量行
共用向量，不能按独立随机分布解释旧延迟/HNSW收益。原日志保留，不作为当前性能证据。

修复为维度窗依赖外层行号 g 的逐行采样。每档先执行 count(*) 与 count(DISTINCT embedding::text)，
synthetic 不全 distinct 即停止；事件 ann.probe.corpus 只报告计数，不记录向量。
测完每档删除索引，再进入下一档无索引测量；索引存在不代表使用索引，计划和 indexUsed 同时报告。

本轮命令（隔离 scratch、零HTTP请求）：
`bun run ann:probe --source=synthetic --sizes=1000,5000,10000 --queries=5 --k=50`。
用 EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) 测量临时 vector(1536) 表；每档 distinct 数与行数相等。

| 行数 | 无索引 p50 / p95 (ms) | 有索引 p50 / p95 (ms) | 有索引实际计划 | recall@50 |
|---|---|---|---|---|
| 1,000 | 6.533 / 8.531 | 3.155 / 3.461 | Seq Scan + Sort，未用HNSW | 1.00 |
| 5,000 | 31.399 / 41.194 | 9.034 / 10.545 | HNSW Index Scan | 0.86 |
| 10,000 | 71.684 / 102.017 | 11.168 / 13.499 | HNSW Index Scan | 0.80 |

证据：`.m4-evidence/ann-review-fixed.log`。这些是合成语料、单个语料内查询向量的5次计时；
不是5个独立需求查询，也不是生产结构化过滤链。第一档差异不能归因于HNSW，可能反映缓存/本机噪声。
索引采用库默认建图参数，临时会话 ef_search=max(40,K)=50（候选宽度不能小于K），两档均实际返回50行。
recall 是对该语料该查询的 exact Top-K id 集交集比例；这不是语义标签一致度，也不是生产参数建议。

source=auto/real/synthetic 行为不变：real 不足报错，不重复采样同一行，但真实内容可能有重复向量，
因此也报告 distinct。旧6条 live 向量的 real 探针只证明通路，不能拿其亚毫秒数字推断生产规模。

**决策仍为不建生产索引**：当前没有达到真实量级的结构化链性能/recall证据，合成数据也观察到召回损失。
触发线 p95>50ms 或约10万向量仅用于提示复评；1万行合成 exact 越线，不代表当前生产已越线。
达到真实规模后，需按当前模型、合法候选分布与新鲜度规则重测，再选参数并由Owner裁决。

## 6. backfill：批量重建

`bun run embed:backfill [-- --entity=listing|wish|both] [--limit=N] [--concurrency=N]
[--model=<name>] [--requests-per-second=N] [--dry-run]`

旧模型向量必须保留；脚本已移除 purge 开关。切换和回滚均须执行
[模型切换 runbook](issue-322-matching-v2-cutover.md)，只改配置或只补向量不算完成。

- 复用生产 job 的 `generateEntityEmbedding()`，所以不存在"脚本口径 / job 口径"两套文本构造或指纹；
- 取数谓词与读路径的候选条件一致：两类都要求 `status = 'ACTIVE'`，**listing 侧另要求
  `moderation_status = 'APPROVED'`**（对应 `engine.ts` 的 `creatable()` / `visibleToWishOwner()`）。
  不筛这一项就是给永远不会成为候选的实体付费调 provider；按 `created_at, id` 排序，`--limit`
  是**每类**上限，`--concurrency` 上限 4；
- 幂等：指纹命中的实体报 `unchanged`，不重复生成向量；默认最多每秒启动1次HTTP请求，provider内部重试也计入，
  并发默认1/上限4，不攒突发额度；`--requests-per-second` 可显式调整；
- 投递顺序：同一事务里 EMBED 先于 MATCH 入队（`run_at` 相同、`newId()` 是 UUIDv7 ⇒ 领取序 = 插入序）。
  **这条只覆盖入队时刻**：非致命失败重试与 `kill -9` 回收都会把该行 `run_at` 推到 `now()`，此后
  执行序可能反转。反转的后果由 **EMBED 结算后补投同实体 `MATCH_*`** 兜住（§6.1 末尾），所以最坏
  只是"同一对多算一轮"，不再停在第 6.1 节描述的那种永久状态；
- listing 侧先删同实体的 `PENDING MATCH_LISTING`（该类型无 partial unique index）再 INSERT；
  wish 侧用 `ON CONFLICT DO NOTHING`（M2 §失败补投）；
- 失败处理：逐实体 `embed.backfill.entity.failed`，结尾 `embed.backfill.summary`；有失败则
  `process.exitCode = 1`，参数错误走 `UsageError` → exit 2。

live 实测（seed 后 4 个 ACTIVE listing + 2 个 ACTIVE wish；真跑的原始输出
`.m4-evidence/backfill-fresh.log`，复算时先 `DELETE FROM embeddings` 清空向量行再跑；`--dry-run`
那一行的原始输出是 `.m4-evidence/backfill-dry-run.log`；**rebase 到 `origin/main` 之后的同一套复跑**
是 1148 ms / 32 ms，见 §8）：

| 场景 | 结果 |
|---|---|
| `--dry-run` | `dryRun:true`、targets 6（listings 4 / wishes 2），transport live，model `text-embedding-v4`，1536d；`counts` 全 0、0 次 provider 请求 |
| 首次真跑（清空 `embeddings` 后） | `generated 6 / unchanged 0 / stale 0 / failed 0 / matched 6`，**1196 ms**；6 次 `embed.request` 全 `ok` 且 `attempt:1`（385/152/171/144/106/107 ms） |
| 立刻重跑 | `generated 0 / unchanged 6 / matched 6`，**0 次 provider 请求**，58 ms（指纹命中，不重复计费） |

### 6.1 投递顺序不变量：`EMBED_*` 必须先于 `MATCH_*`

队列的领取键是 `(run_at, id)`，`id` 是 `newId()` 生成的 UUIDv7（时间有序）。同一事务里插入
`EMBED_LISTING` 与 `MATCH_LISTING` 两条 job 时 `run_at` 相同 ⇒ 领取序 = `newId()` 序 = 插入序。
原先 `governance/service.ts` 的 `enqueueListingJobs` 先插 `MATCH_LISTING`、后插 `EMBED_LISTING`，
于是**首轮 MATCH 跑在向量落库之前**（`vectorCandidates = 0`），而它之后不会再有第二轮——EMBED 完成
不会触发第二次 MATCH，该实体永久停在 v1（这正是 §8「反序投递」观测到的现象）。

修法：全部投递点统一为 EMBED 在前，并把这条不变量写进代码注释。下面是全仓 `insert(jobs)` /
`INSERT INTO jobs` 的**生产**投递点全集（种子数据、`core:smoke`、`embed:backfill` 属于测试/运维脚本，
不是生产投递；`embedding/enqueue.ts` 只投 `EMBED_*`）。rebase 到 `origin/main = 0b8ab72e` 之后其余
domain 各自只投**单一**类型，不参与这条成对不变量：`apps/api/src/modules/recommendation/interest-queue.ts:40`
投 `REFRESH_USER_INTEREST`（#323 R2）、`apps/worker/src/jobs/visual-embedding/enqueue.ts:43` 投
`VISUAL_EMBED_*`（#324）；`apps/worker/src/jobs/matching/enqueue.ts:52` 只投 `MATCH_*`，且只在
`EMBED_*` 结算成功之后调用（就是本节末尾那条补投修复，不存在"先 MATCH 后 EMBED"的旁路）：

| 位置 | 说明 |
|---|---|
| `apps/api/src/modules/listings/store.ts:1003-1026` | `enqueueListingJobsWith`：发布 / 编辑 / 重新上架（调用点 `:575/583/794/842`） |
| `apps/api/src/modules/governance/service.ts:588-603` | `enqueueListingJobs`：下架（`:306`）/ 重新上架（`:397`）走这条 helper——原先顺序颠倒的正是这里，不是审核入口 |
| `apps/api/src/modules/moderation/store.ts:170-183` | 人工放行（待审 → APPROVED）是待审商品进入匹配链路的唯一入口，自己有独立的一对 insert（EMBED_LISTING → MATCH_LISTING；其中 `EMBED_LISTING` 带 `ON CONFLICT DO NOTHING`，`MATCH_LISTING` 没有——该类型没有 partial unique index） |
| `apps/api/src/modules/wishes/store.ts:148-155` | 创建路径改为同事务三条语句（不再是一条 CTE），顺序 EMBED_WISH → MATCH_WISH |
| `apps/api/src/modules/wishes/match-queue.ts:89-105` | 编辑 / 状态变更路径同一不变量 |

回归断言落在 `apps/api/src/modules/listings/store.test.ts:189,197`、`apps/api/src/modules/wishes/store.test.ts:112,115`
（创建路径）与 `:148,151`（编辑路径）、`apps/api/src/modules/moderation/store.test.ts:313`：不只断言"两行 job 存在"，
而是**按队列自己的领取键（`(run_at, id)`）排序**断言谁先被领取（`ORDER BY type` 或对着结果 `.sort()`
——如 `listings/store.test.ts:192`——只能把两行排出来，不代表执行顺序）。

**这条不变量的边界（第四轮审查 F1，major）→ M4 已修**：入队序正确 **≠** 执行序正确。`run_at` 是
退避字段（`packages/db/src/schema/jobs.ts:48`），非致命失败重试（`apps/worker/src/jobs/queue.ts:145`
`run_at = now()`）与 `kill -9` 后的僵死回收（`:179` 改回 `PENDING`、`:187` 超额度转 `FAILED`，两处都
`run_at = now()`）都会把它推后，而领取序是 `ORDER BY run_at, id`（`:115`）——一次 EMBED 非致命失败或
进程被强杀，同实体的 `MATCH_*` 就会先被领取，
`engine.ts:401` 判目标向量 stale ⇒ `recall = 'v1-fallback'`（`:536-538` / wish 侧 `:649-651`），
只补投 `EMBED_*`、**不重投 `MATCH_*`** ⇒ 该对停在 v1。

**修法（补投对称化）**：`apps/worker/src/jobs/embedding/handlers.ts` 里的
`generateAndResumeMatching()` 在 `generateEntityEmbedding()` 返回 `generated` / `unchanged` 后调用
新增的 `apps/worker/src/jobs/matching/enqueue.ts` `enqueueMatchJob(db, entity)`，给**同一实体**补一条
`MATCH_*`：`INSERT INTO jobs ... SELECT ... WHERE NOT EXISTS (同实体 status='PENDING' 的 MATCH_*)`。
`MATCH_LISTING` 没有 partial unique index（`packages/db/src/schema/jobs.ts:59-72` 只有 wish 侧与两条
EMBED 的），所以必须显式 `NOT EXISTS` 去重；并发窗口最坏多一条**幂等**重算（重算同一对走 `updated`
分支、不产生第二条通知），要彻底关掉得给该类型加 partial unique index + migration，属另一件事。
（尾项分支已补上该索引，见 §12.1 第 2 条；`NOT EXISTS` 保留为廉价前置过滤。）
补投发生在 EMBED job 结算**之前**，所以新 `MATCH_*` 的 `(run_at, id)` 必然晚于本次 EMBED。
`stale` / `missing` 不补投——那两种情况下向量没有变新，补投就是"MATCH → 补投 EMBED → MATCH"空转。

**端到端证据**（`.m4-evidence/core-smoke-rebase.log`，rebase 到 `origin/main` 后 `bun run core:smoke`
**266 断言全绿 / 28110 ms / exit 0**；rebase 前同一条链在 `core-smoke-scope5b.log` 里是 236 断言 /
29.1 s，main 的新用例加了 30 项断言）：seed 只投的那条 `MATCH_LISTING`（`recall: "v1-fallback"`,
`fallbackReason: "missing"`, `created: 1`）→ `EMBED_LISTING` `status: "generated"` → **第二条
`MATCH_LISTING`**（除了这次修复没有任何东西会投它）`recall: "vector-topk"`, `fallbackReason: null`,
`created: 0`。smoke 的断言是"`MATCH_LISTING` 行数 ≥ 2 + `EMBED_LISTING` 行数 > 0"。

**还剩一半的不对称（别读成"已经全修"）**：补投只覆盖**目标实体自己的**向量。一条 match 要升到 v2
需要**两侧都有新鲜向量**：`MATCH_LISTING` 的候选来自 `topKSimilarWishes()`（只返回有新鲜向量的愿望），
愿望侧没有向量时它只能靠"并回的已有行"打分，`similarity === undefined` ⇒ 仍走 v1 分支
（`engine.ts:440-545`）。所以 seed 的 demo 对（愿望侧没有任何 job）终态就是 v1 / 100 分；
必须先 `bun run embed:backfill`（默认 `--entity=both`）把两侧都补上，它才会升到 v2——实证见
`.m4-evidence/backfill-v1-to-v2.log`：把库退回"商品已补、愿望未补"的 v1 状态（`score 100 /
semantic NULL / ranking_version 1`）后只补 wish 侧，`embed.backfill.summary` 报
`generated 2 / matched 2`，随后 `MATCH_WISH` 以 `recall: "vector-topk"`, `vectorCandidates: 2` 结算，
同一行变成 `score 93 / semantic_score 77 / ranking_version 2`。

上面四个回归断言断的仍然只是**入队时刻**的 `(run_at, id)` 序（回归断言无法覆盖"重试/回收之后"的
执行序；那一段由 `handlers.test.ts` 新增的 6 个补投用例——`generated` / `unchanged` / 已 `DONE` 补投、
wish 侧不串号、`missing` 与 `stale` 都不补投——加 `core:smoke` 的端到端断言覆盖）。

## 7. 可观测：`obs:summary`

`bun run obs:summary [-- --model=<name>]`（只读，不出网）打印五组事件。`--model=` 缺省时取
**写入侧实际用的模型名**：stub transport 下就是 `STUB_EMBEDDING_MODEL`（此时 `EMBEDDING_MODEL`
只描述"将来切 live 会用谁"，拿它统计会报出假的 0 覆盖率），否则取 `EMBEDDING_MODEL`；两者都没有、
或给了不认识的参数、或 `--model=` 为空，按用法错误 exit 2（与另外三个脚本一致）。

| 事件 | 内容（字段名即实现里的 key） |
|---|---|
| `obs.embeddings` | 顶层 `model`；`coverage.{listings,wishes}` = `active` / `withAnyVector` / `withVersionFreshVector` / `withFreshVector`；`models[]` = 按 `(model, vector_dims(embedding))` 分组的 `model` / `dimensions` / `vectorRows` / `listingVectors` / `wishVectors` / `freshVectors` |
| `obs.matches` | `byRankingVersion[]` = `rankingVersion` / `rows` / `semanticNull` / `semanticFilled` / `scoreMin` / `scoreP50` / `scoreMax` |
| `obs.jobs` | `byTypeStatus[]` = `jobType` / `status` / `rows` / `retried`（`attempts > 1`）/ `withError`（`last_error IS NOT NULL`）/ `doneP50Ms` / `doneP95Ms`。**不含失败率**（在 `obs.summary`） |
| `obs.retries` | `entities[]` = `jobType` / `entityKey`（`listingId` / `wishId`）/ `entityId` / `failedInWindow` / `pending`。**这是状态而不是流**：`embed.retry` 的 stderr 事件只记录"当时做了决定"，事后问不出"现在哪些实体已经不再自动重试"；`pending` 为 `false` 表示该实体**此刻**连待跑的 `EMBED_*` 都没有了（不等于"自动路径断掉"：编辑商品仍会无额度闸门地重投一条）。出处 `listExhaustedEmbedRetries()`（`apps/worker/src/jobs/embedding/requeue.ts`），判据与补投路径复用同一组常量 |
| `obs.summary` | `model` / `modelCount` / `activeListings` / `freshListingVectors` / `activeWishes` / `freshWishVectors` / `matchRows` / `rankingVersion1Rows` / `rankingVersion2Rows` / `jobRows` / `settledJobs` / `failedJobs` / `exhaustedEmbedRetries` / `stuckEmbedRetries` / `failedRate` |

四个实现口径必须写下来，否则指标会被误读：

- **覆盖率的分母谓词与读路径一致**：可见性用 `status = 'ACTIVE'`，**listing 侧另加
  `moderation_status = 'APPROVED'`**（`engine.ts` 的 `creatable()` / `visibleToWishOwner()`）；
  少了这一项就会把永远不会成为候选的实体算进分母，报出偏低的覆盖率。
- **覆盖率的新鲜谓词是读路径两侧闸门的交集**：`date_trunc('milliseconds', e.source_updated_at) =
  date_trunc('milliseconds', t.updated_at)`、`e.dimensions = EMBEDDING_DIMENSIONS`、以及
  `e.content_hash = <SQL 里算出来的指纹>`（模型那道闸门由 `--model` / 分组维度提供）。
  ⚠️ 读路径两侧判据**不同**：目标侧是 `engine.ts:401` 的 `row.dimensions !== EMBEDDING_DIMENSIONS ||
  row.contentHash !== contentHashOf(text)`（维度 + 指纹，**不比版本号**），候选侧是
  `packages/db/src/embedding-store.ts:252-254` 的 `freshListingsEmbedding()` / `freshWishesEmbedding()`
  （模型 + 毫秒级版本号，**不比 dimensions / content_hash**）。这里报的是**两者的交集** ⇒ 比任何一侧
  都严，`withFreshVector` **偏低（少报）**，不是"读路径实际召回数"；只算后两条的
  `withVersionFreshVector` 才是上界。
  指纹那一腿由新增的 `apps/worker/src/jobs/embedding/content-hash-sql.ts` 在 SQL 侧复刻 TS 的
  `contentHashOf(build*EmbeddingText(...))`：
  `encode(sha256(convert_to('v1:' || concat_ws(E'\n', '标签: ' || nullif(btrim(regexp_replace(列, E'\r\n?', E'\n', 'g'), <JS 空白集>), ''), …), 'UTF8')), 'hex')`。
  归一化必须逐字符对齐 `String.prototype.trim()`：Postgres 的 `btrim(x)` 默认只去 U+0020，所以显式
  传了 JS 的空白集（U+0009/000A/000B/000C/000D/0020/00A0/1680/2000–200A/2028/2029/202F/205F/3000/FEFF）。
  对拍证据：`content-hash-sql.test.ts`（14 例：首尾空白、CRLF 与孤立 CR、空串整行省略、全角空格、NBSP、
  垂直制表+换页、emoji 代理对、多行描述、wish 的 `category ?? '不限'`…）与真实库（6 行向量）都是
  **SQL ≡ JS**。所以 `withFreshVector` 与 `withVersionFreshVector` 的差应该恒为 0；保留这一对字段是
  为了**诊断**：一旦非 0，就是"版本号对上了、内容指纹错位"的暂态（同一毫秒内改过两次内容）。
  残余风险：任何**没列进上面空白集**的 Unicode 空白字符会让 SQL 侧少 trim 一点——要修就往
  `normalizedSql()` 单点定义的 `JS_TRIM_CHARS` 里加字符。
- **新鲜覆盖率还要按 model 作用域**：读路径取候选时带 `eq(embeddings.model, query.model)`
  （`packages/db/src/embedding-store.ts:312/332`），所以 `withFreshVector` 也必须加 `e.model = <model>`；
  只有 `withAnyVector` 是"任意模型的向量都算"的诊断口径。否则换过模型之后会报出"假新鲜"
  （旧模型的向量对上版本号，读路径根本取不到）。
- **job 耗时含排队等待**：`extract(epoch FROM (updated_at - created_at)) * 1000` 是从入队到落库的
  墙钟时间，不是纯执行耗时；观察"M1 遗留的失败补投"这类问题时不能拿它当处理能力。
- **`failedRate` 的分母是"已结算"的 job**：`failedRate = failedJobs / settledJobs`，其中
  `settledJobs` 只统计 `status IN ('DONE','FAILED')`；`jobRows` 才是全量（含 PENDING / RUNNING）。
  本机反复起停 worker 会留下成片 PENDING，若把它们算进分母就会系统性低估失败率（`settledJobs`
  也一并输出，便于消费者自己核对分母）。
- **`exhaustedEmbedRetries` / `stuckEmbedRetries` 是"额度用尽"的查询口径，不是告警通道**：
  前者 = 24 h 窗口内已有 `FAILED_EMBED_RETRY_LIMIT`（3）条 `FAILED` 的 `EMBED_*` 实体数，
  后者 = 其中**此刻连待跑任务都没有**的实体数（`stuck ⊆ exhausted`）。注意 `stuck` **不等于**
  "自动路径已断"：它只说"现在没有待跑的 `EMBED_*`"——编辑商品 / 治理动作会在同一事务里重投一条
  `EMBED_LISTING`（`apps/api/src/modules/listings/store.ts` 等三处成对投递），那条路径没有额度闸门，
  额度只约束 `scheduleFailedEmbedRetry()`。所以人工 `bun run embed:backfill` 是兜底而不是唯一出路。
  口径与 `scheduleFailedEmbedRetry()` 逐条对齐：只算 `EMBED_LISTING` / `EMBED_WISH`、窗口与上限
  复用同一组常量、`payload` 里没有实体键的行不分组。仓库里**没有**告警基建（无 metrics 服务、
  无外部通知），所以它把"需要人看日志"变成"可随时重跑、可聚合"，但**不等于**真正的告警通道。
- **`topKLatencyMs` 只在 worker stdout**：`jobs` 表没有 result 列（`packages/db/src/schema/jobs.ts`），
  引擎把它放进 `MatchRunResult` 后只由 `job.settled` 打出，`obs:summary` 聚合不到——要复核 §5 的
  ANN 触发条件，得 grep worker 日志里的 `job.settled`。

live 实测（M4 live 环境，见 §8；rebase 到 `origin/main = 0b8ab72e` 之后重跑的原始输出是
`.m4-evidence/obs-summary-rebase.log`（worker 起停中途）与 `.m4-evidence/obs-summary-rebase2.log`
（这一轮把队列领完后的终态）；`.m4-evidence/obs-summary-scope5.log` 是 rebase 前那次的同一口径快照，
`obs-summary-final.log` 是加指纹腿**之前**那版，`.m4-evidence/verify-clockfix-live.log` 的 obs 段更早，
只用来看当时的覆盖率与分数）：

```
obs.embeddings : listings {active 4, withAnyVector 4, withVersionFreshVector 4, withFreshVector 4},
                 wishes {2, 2, 2, 2}；model text-embedding-v4 / dimensions 1536 / vectorRows 6 / freshVectors 6
obs.matches    : rankingVersion 2 → rows 2, semanticNull 0, semanticFilled 2, score 85 / 89 / 93
obs.jobs       : EMBED_LISTING 46 + EMBED_WISH 6 + MATCH_LISTING 62 + MATCH_WISH 10，全部 DONE
                 （retried 0, withError 0, 无 PENDING）；另有 3 条 VISUAL_EMBED_LISTING FAILED（见下）
obs.summary    : jobRows 127 = settledJobs 127, failedJobs 3, failedRate 0.0236,
                 rankingVersion1Rows 0, rankingVersion2Rows 2
```

那 3 条 `VISUAL_EMBED_LISTING FAILED` **不是 M4 的问题**：它们是 rebase 带进来的 #324 视觉向量链路
（`attempts = 3`、`last_error = EmbeddingProviderError: 封面对象读取失败（listings/seed-{textbook,monitor,k380}/0.jpg）`）
——本机 MinIO 里没有这些 seed 封面对象，而 stub transport 仍要先把图读出来。同一库在 worker 起停
**中途**的快照 `.m4-evidence/obs-summary-rebase.log` 是 `jobRows 118 / settledJobs 100 / failedJobs 0 /
failedRate 0`，可见那 3 条失败全部来自视觉链路，与 M4 的 EMBED/MATCH 四类 job 无关（它们 retried 0）。
M4 自己的失败率口径没有变化：`failedRate` 的分母仍是已结算 job。

（重标定前同一套观测是 `score 71 / 75 / 79`，M4 参数生效后升到 `85 / 89 / 93`——两行 v2 都是
"关键词精确命中 + 预算内 + 语义高"的对，锚点拉低后语义项从 15–47 分升到 60+，总分随之抬升。
`doneP50Ms` 在 `obs.jobs` 里很大（数十万毫秒）是因为这些 job 是历次 smoke 累积的、含排队等待，
不能当处理能力看——见上文的耗时口径说明。

另注：`obs:summary` 读的是**当前库**，所以本机反复跑 smoke / 全量测试 / 短暂起 worker 之后会看到新的
`PENDING` 行（例如 `.m4-evidence/obs-summary-final.log` 里是 5 行 `EMBED_LISTING` + 14 行
`MATCH_LISTING` + 2 行 `MATCH_WISH` PENDING）。这不是故障：本机没有常驻 worker 去领取它们。
看覆盖率与 `matches` 分布不受影响；rebase 后那一轮 worker 把队列领完了，所以
`.m4-evidence/obs-summary-rebase2.log` 里 PENDING = 0。）

### 7.1 worker 侧的观测接线

`obs:summary` 是**事后聚合**，运行时的日志出口是新增的 `apps/worker/src/log.ts`：一条事件 =
一行 JSON（正常事件 stdout、失败事件 stderr），不引任何 logger 依赖。分流在**接线点**做，规则两条：
`embed.request` 按 `outcome === 'ok'`（`retryable` / `fatal` 走 stderr），`embed.entity` 与
`job.settled` 按 `status === 'failed'`。于是失败态的 `embed.entity`（handler 先发事件再 rethrow）、
`job.settled` 的失败分支、**上游请求失败**都走 stderr——只收 stderr 的告警系统不会漏掉模型调用失败。
硬约束写在模块头：
**事件里只允许出现计数、耗时、状态、模型名、实体 id 与哈希——绝不写用户文本或向量**；要指代
一段私密文本时用内容指纹 `contentHashOf()`（`packages/contracts/src/embedding/text.ts:79`）
+ 文本长度，两者都不含原文。

| 事件 | 出处 | 用途 |
|---|---|---|
| `worker.started` | `apps/worker/src/index.ts` | 一次记录 pollInterval / transport / model / dimensions / rankingVersion；#324 之后同一事件还带 `visualTransport` / `visualModel` / `visualDimensions`（原来那三行 `console.log` 启动横幅并入这一行） |
| `worker.recovered` | 同上 | 僵死 job 回收（requeued / failed） |
| `embed.retry` | 同上（`scheduleRetryFor`） | 一条 `EMBED_*` 结算成 `FAILED`（或启动回收判死）后的**有界补投**决定：`scheduled` / `reason`（`budget-exhausted` / `already-pending` / `bad-payload` / …）/ `failedInWindow` / `delayMs`；统一走 stderr（见 §12 的"3 次失败后无补投"） |
| `job.settled` | 同上 | 每个 job 一行：job 类型 / 状态 / 耗时 / `MatchRunResult`（含 recall、fallbackReason、vectorCandidates、topKLatencyMs、matched、downgraded） |
| `embed.request` | `providers/live.ts` 的 `onRequest` 回调 | 每次**上游请求**一条（含重试）：条数、尝试序号、耗时、`ok/retryable/fatal`、失败分类与上游 status |
| `embed.entity` | `jobs/embedding/handlers.ts` | 每个**实体**一条：`generated` / `unchanged` / `stale` / `missing` + contentHash + 字符数 + 耗时 |

`embed.request` 与 `embed.entity` 是"请求数 vs 实体数"两个不同粒度：前者回答"花了多少次模型调用、
重试与失败率多少"，后者回答"多少实体内容指纹命中（`unchanged`）"——§6 的幂等重跑就是靠
`embed.request` 计数 = 0 与 `embed.entity` 全 `unchanged` 同时证明的。

**stub transport 不接 `onRequest`**（`providers/index.ts` 的 stub 分支不传回调），所以本地 stub
跑起来只会看到 `embed.entity`，看不到 `embed.request`——这不是漏接线，而是 stub 不出网、没有
"上游请求"可计。另外 `onRequest` 回调自身抛错已被 provider 吞掉（`providers/live.ts` 的 `notify`），
观测坏掉不会把一次成功的上游请求变成 job 失败。

`dimensions` 是 M4 在 provider 上补的显式参数（`providers/live.ts`）：多数兼容端点把维度当可选
参数，省略时按**模型默认**返回（百炼 `text-embedding-v4` = 1024），与迁移里的 `vector(1536)` 不符，
每条都会栽在 `readEmbeddings` 的维度校验上。

## 8. live 验证（真实 provider 端到端）

- **环境**：隔离库 `fish_322_m4`。共享库 `fish` 的迁移 journal 血统不一致（`db:migrate` 报
  `relation "favorites" already exists`，42P07），与其它 worktree 同惯例各用隔离库；`.env` 指向它，
  `db:migrate` + `db:seed` 均成功。rebase 到 `origin/main` 后 main 的 #324 要求**显式**给
  `VISUAL_EMBEDDING_TRANSPORT`（`packages/shared/src/env.ts:436`：不给就 `环境变量校验失败`，不允许静默
  回退），本 worktree 只验 #322 M4，所以在 `.env`（gitignored）里设 `VISUAL_EMBEDDING_TRANSPORT=stub`；
  worker 启动事件里随之多出 `visualTransport / visualModel / visualDimensions` 三个字段。
- **worker live**：`worker.started = { pollIntervalMs: 1000, transport: "live",
  model: "text-embedding-v4", dimensions: 1536, rankingVersion: 2 }`。`dimensions: 1536` 是
  `EMBEDDING_DIMENSIONS`（`packages/db/src/schema/embeddings.ts:24`）随请求传上去的结果——**v4 的
  默认输出 1024 维，不传 dimensions 会直接 `dimension_mismatch`**，这是 M1 补丁在真实端点上的验证点。
- **结果**（原始输出 `.m4-evidence/verify-clockfix-live.log`）：`job.settled` 全部 `DONE`
  （EMBED_LISTING 6 条 + MATCH_LISTING 16 条）。其中 12 条 MATCH_LISTING 是本机反复跑 smoke / 测试
  留下的历史 PENDING，目标 listing 已被删，所以 `skipped: "target-missing"`、`vectorCandidates: 0`；
  真正走到候选检索的 4 条是 `recall: "vector-topk"`、`fallbackReason: null`、
  `vectorCandidates` 0–1、`topKLatencyMs` 4–5、`durationMs` 18–29。
- **时钟修复后的复验**（同一份 `.m4-evidence/verify-clockfix-live.log`）：`embed:backfill`
  `generated 0 / unchanged 6 / matched 6`（41 ms，**0 次 provider 请求**）；worker live 仍报
  `dimensions: 1536` / `rankingVersion: 2`，状态全 `DONE`；`obs:summary` 见 §7。
- **rebase 后复跑**（`origin/main = 0b8ab72e` 之上）：`embed:backfill` 先清空 `embeddings`
  （`DELETE 6`）再跑 = `.m4-evidence/backfill-rebase-run1.log`（`targets 6` /
  `{generated:6, unchanged:0, stale:0, missing:0, failed:0, matched:6}` / 1148 ms / 6 次
  `embed.request`），立刻重跑 = `.m4-evidence/backfill-rebase-run2.log`（`{generated:0, unchanged:6,
  matched:6}` / 32 ms / **0 次 `embed.request`**）；worker = `.m4-evidence/worker-rebase-run.log`，
  1 条 `worker.started`（含视觉三字段）、16 条 `embed.entity`、24 条 `job.settled` 全 `DONE`
  （13 EMBED_LISTING + 3 EMBED_WISH + 6 MATCH_LISTING + 2 MATCH_WISH），其中 6 条 MATCH 走
  `recall: "vector-topk"`。
- **反序投递**：seed 产生的历史行先是 v1（`obs.matches` 里 v1 行 > 0），`embed:backfill` +
  worker 跑完后 `rankingVersion1Rows = 0`，即历史实体确实被提升到 v2。
- **密钥**：只从 `.env`（gitignored，`.gitignore:6-7`）读取；日志只打 model / dimensions / 耗时，
  不打 key、不打向量。

## 9. 时钟根因修复：更新版本使用数据库 `clock_timestamp()`

这一节不是 M4 的验收项，而是做 M4 时被全量测试抓出来的跨范围根因。Owner 看过证据后要求
「顺手修根因」。

**现象**：三条"编辑后重算"的用例确定性变红——`apps/worker/src/jobs/embedding/handlers.test.ts`
的 `EMBED_LISTING > 编辑 title/description 后重算`（测试声明在 `:223`）与 `EMBED_WISH > 编辑 keyword
后重算`（`:485`）都拿到 `stale`（期望 `generated`），`packages/db/src/embeddings.test.ts:706`
（`refreshEmbeddingSourceVersion` 的版本推进守卫，失败断言落在 `:732` 的 `.toBe(true)`）同样失败。

**根因**：`packages/db/src/schema/common.ts` 的 `updatedAt` 是"插入用 DB 钟
（`defaultNow()`）、更新用应用钟（`$onUpdate(() => new Date())`）"。实测本机容器 Postgres 比宿主
快 **42–52 ms**，于是"编辑后的 `updated_at`"可能**小于**已经存下的 `source_updated_at`；而
`packages/db/src/embedding-store.ts:150` 的守卫是
`DO UPDATE ... WHERE excluded."source_updated_at" >= embeddings.source_updated_at`，
条件为假时 Postgres **静默不写、不报错**，`saveEmbedding` 只返回 `rows.length > 0`（= false），
handler 于是把一次合法重算当成"旧 job 晚到"而返回 `stale`。在高负载机器上测时曾伪装成时序抖动，
但最小复现（`insert` 用 DB 钟 → `update` 用应用钟 → delta = −38 ms ⇒ CAS 拒绝）证明它是确定性的。

**最终修法**：更新版本使用 DB `clock_timestamp()`，同时避免跨时钟比较和冻结事务开始时间导致的倒退。
插入 `defaultNow()` 不变；其它业务事件时刻与队列调度不调整：

| 位置 | 改动 |
|---|---|
| `packages/db/src/schema/common.ts` | `$onUpdate` 更新取 `sql\`clock_timestamp()\``；插入默认不变 |
| `packages/db/src/embedding-store.ts` | onConflict/refresh 的元数据 updatedAt 同样取实际求值时间 |
| `apps/api/src/modules/listings/store.ts` | 编辑与 setStatus 两处取 clock_timestamp() |
| `apps/api/src/modules/wishes/store.ts` | update/updateStatusIfActive 的 updated_at 取 clock_timestamp() |
| `apps/api/src/modules/governance/service.ts`、`moderation/store.ts` | Listing 更新版本取 clock_timestamp()，业务事件时刻保持原语义 |
| `apps/api/src/modules/transactions/store.ts` | accept / cancel / confirm 完成 / 核销完成四条路径里的 listing 状态更新取 clock_timestamp()（`transactions.updated_at`、`completed_at`、`cancelled_at` 等业务时刻保持原语义） |
| `apps/api/src/modules/governance/store.ts` | restriction 审计时刻不属于 embedding 实体版本，保持原语义 |

**状态漂移的向量版本补投（同批修复）**：`listings.updated_at` 一前进，
`freshListingsEmbedding()`（`packages/db/src/embedding-store.ts:256`）的毫秒等值新鲜度谓词就会把旧
向量行判成"不新鲜"，该商品随之掉出语义召回的候选集合；而 `apps/worker/src/jobs/matching/engine.ts:415`
的 `loadTargetVector` 按**内容指纹**判过期，所以只改状态（不进 embedding 文本）的写入永远不会触发
重嵌。此前 transactions 的 accept / cancel / confirm 完成 / 核销完成四条路径都只 bump `updated_at`
且不投 job，于是商品一被接受 / 取消 / 售出就**永久**退回 v1 召回（`ranking_version = 1`），直到内容
被编辑。修法：四条路径在同一个事务里补投 `EMBED_LISTING`（`apps/api/src/modules/transactions/store.ts`
的 `enqueueListingEmbedding()`，`ON CONFLICT DO NOTHING` 复用 `EMBED_LISTING` 的部分唯一索引）；
handler 发现内容指纹未变时走 `unchanged` 并调 `refreshEmbeddingSourceVersion()` 把向量行的版本标记
推进到实体当前版本（`apps/worker/src/jobs/embedding/handlers.ts`，不调 provider、不重复计费）。
不连投 `MATCH_LISTING`：商品状态不是匹配输入，引擎求值时按状态过闸。
新回归：`apps/api/src/modules/transactions/store.test.ts` 的
`#322 M4：状态流转补投 EMBED_LISTING（向量版本跟上实体版本）` 两条用例（accept/cancel；
双侧确认置 SOLD），修复前 **2 fail / 0 pass**，修复后 **2 pass**。

随之修正的陈旧口径注释：`apps/api/src/modules/listings/store.ts`（内容指纹判据的说明）、
`apps/api/src/modules/wishes/match-queue.ts`、`packages/db/scripts/utc8-timestamp-prefix.ts`、
`apps/worker/src/jobs/embedding/handlers.test.ts`。

**语义变化（重要，写在这里以免后人误解）**：

- `wishes.store.update()` / `updateStatusIfActive()` 不再接受 `updatedAt` 参数；
  `createOrGetRecent()` 的入参改为 `NewWishRow = Omit<WishRow, 'updated_at'>`，`updated_at` 由 DB
  生成，**`created_at` 仍由调用方给**——`store.test.ts` 靠回拨 `created_at` 60 s 来走出软幂等窗口，
  这个能力不能丢。
- `now()` 是事务开始时间，不能证明写入序单调。两连接回归构造 A 先开始、B 先写并刷新 source version、
  A 后取得行锁只改价：旧写法导致 source version 永久无法回退，候选一直消失；实际求值时间避免这个路径。
- transactions 的 listing 状态更新（accept / cancel / confirm 完成 / 核销完成）此前既写 `now()`、
  也不投 EMBED job：现在同样取 `clock_timestamp()` 并按上一段补投（fresh 对抗审查的 MAJOR 3）。
- 比较仍按毫秒截断。时钟不是严格递增 revision，同毫秒更新/时钟校正仍有边界；旧内容的最终防线是
  锁实体行后的 content hash 复检与写路径 prune，而不是仅靠时间戳。
- 不改 CAS、refresh 的单向守卫或队列 run_at。新回归验证两次 unchanged、不重复生成向量且候选仍可召回。

**回归证据**：三条红用例恢复 green；`apps/worker/src/jobs/matching/engine.test.ts` 里 M3 评审期间
临时加的 `updatedAt: new Date(Date.now() + 1000)` workaround 已回退（根因修好后不再需要），M3 的
Top-K 硬边界期望值（95 → 100，锚点变更的直接后果）保留。

## 10. 历史基线验收记录（不代表本轮收尾全部通过，当前门禁见 §13）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 批量重建（backfill） | ✅ | §6：6 实体 live 跑通 + 幂等重跑 0 请求 |
| 指标与日志 | ✅ | §7：`obs:summary` 五组事件 + `embed.*` / `job.*` 事件 |
| live provider smoke | ✅ | §8：worker live 6 job 全 DONE；脚本 live 6/6 |
| 性能 / recall 对照 | ✅ | §4 recall@K 表、§5 ANN 对照表（固定 seed 可复算） |
| `bun run typecheck` | ✅ | 8 个包 exit 0 |
| `bun run lint` | ✅ | `Checked 1044 files. No fixes applied.`（rebase 到 `origin/main = 0b8ab72e` 之后；两条 warning 来自 main 已有文件：`apps/api/src/modules/listings/service.test.ts` 的 3 处 `noNonNullAssertion`、`apps/api/src/modules/moderation/store.test.ts:195` 的 `noUnusedFunctionParameters`，Biome 判为 warning、exit 0） |
| `bun test --isolate` | ✅ | 最近一次 **3279 pass / 0 fail / 11305 断言 / 313 文件 / 115.86 s**（第七轮审查修复后，`.m4-evidence/verify-rebase2-full.log`，本机负载偏高；比上一轮只多了 `handlers.test.ts` 的 `stale` 不补投用例）；rebase 到 `origin/main = 0b8ab72e` 后是 **3278 / 0 / 11303 / 313 文件 / 64.89 s**（`verify-rebase-full.log`）；旧基线上范围外发现修复后是 2371 / 231 文件 / 156.54 s（`verify-scope5-full.log`）；第五轮审查修复后 2344 / 229 文件（`verify-reviewfix4-full.log`，本机负载下 182 s）；此前三次全绿分别 52.00 s / 52.61 s / 85.05 s，见 `verify-reviewfix3-full.log` / `verify-reviewfix2-full2.log` / `verify-reviewfix-final3.log`） |
| Worker + API 真实 DB 集成测试 | ✅ | 用隔离库 `fish_322_m4` 跑 worker live + backfill + obs |
| core smoke 覆盖一条语义匹配链 | ✅ | `bun run core:smoke` live 全绿（最近一次 `.m4-evidence/core-smoke-rebase.log` = **266 断言 / 28110 ms / exit 0**，rebase 到 `origin/main` 后；rebase 前是 `core-smoke-scope5b.log` 236 断言 / 29.1 s，main 新增用例多了 30 项断言。两次都含 §6.1 的补投端到端断言）；语义链在 M4 加了"等创建路径的 `MATCH_WISH` 结算"这一步（见 §6.1），第三轮审查后该等待改成"必须全 `DONE`，出现 `FAILED` 直接判失败" |
| production provider 最小 live smoke（密钥不进日志） | ✅ | §8：本机用 `.env` 里的百炼 key 跑 backfill / worker live；证据日志 grep 密钥值 = **0 命中** |

（说明：全量测试在本机 **load average > 20** 时偶发 5 s hook/用例超时——本轮撞到过三次，
不同文件、每次都不一样，且失败文件单独复跑全绿：`engine.test.ts` 25/25 ×2、迁移/seed/auth/
wishes 五个文件 61/61。第三次最极端（`verify-reviewfix2-full.log`，load ≈ 118）：28 个失败全是
5 s 超时，还级联出一次 `ERR_POSTGRES_CONNECTION_CLOSED` 与遗留测试库 `..._test_61926`（已 DROP），
负载回落到数十后同一条命令 2344 pass / 0 fail（`verify-reviewfix2-full2.log`，52.61 s）。这些是历史过程记录，不可因此忽略失败或宣称与diff无关；本轮包含运行时改动，任何验证失败都须定位并重跑。）

M3 §10 交接的 7 项：

1. `MATCH_SEMANTIC_TOP_K` 重估 → ✅ §4（保留 50）
2. ANN 决策复核 → ✅ §5（当前不建，触发条件固化）
3. 真实 provider 语义质量 + 锚点复核 → ✅ §3（`0.5/0.95 → 0.42/0.70`）
4. backfill 脚本（历史 v1 → v2） → ✅ §6 / §8
5. seed demo 对仍 v1 → ✅ **条件式解决**：`bun run embed:backfill`（默认 `--entity=both`）把两侧向量补齐
   之后该对升到 v2（实证 `.m4-evidence/backfill-v1-to-v2.log`：`v1/100/NULL` → `93/77/v2`）。
   **只补商品侧不够**——v2 要求两侧都有新鲜向量（§6.1 末尾），所以 seed 契约仍然不动，`core:smoke`
   钉的是"v1 终态 + 补投发生过"而不是"demo 变 v2"
6. M1 遗留"3 次失败后无补投" → ✅ 已修：新增 `apps/worker/src/jobs/embedding/requeue.ts`
   （`scheduleFailedEmbedRetry`：额度 3 条 / 24 h 窗口 / 60 s 延后 / `NOT EXISTS PENDING` 去重），
   由 `apps/worker/src/index.ts` 在 `FAILED` 结算与启动回收两处触发，决定写进 stderr 的 `embed.retry` 事件
7. 聚合观测（请求数 / 失败率 / latency / 命中率 / Top-K / matched-downgraded / model 版本） → ✅ §7

## 11. 本地复算命令

```bash
bun run db:up && bun run db:migrate && bun run db:seed   # 隔离库需先把 DATABASE_URL 指过去
bun run typecheck && bun run lint && bun test --isolate

bun run rank:compare                                     # 权重对照（不出网、不需要 DB）
# 历史5000条recall记录不在本轮出网授权内，不运行默认全段评估。
# 新独立验证需先确认标签，并由预算受控的验证脚本执行。
bun run ann:probe --source=synthetic --sizes=1000,5000,10000 --queries=5 --k=50
bun run embed:backfill -- --dry-run
bun run embed:backfill
bun run obs:summary                                      # 也可 -- --model=<name> 指定模型
bun run core:smoke
```

`.m4-evidence/` 下留有本阶段全部原始输出：`ann-probe.log`、`calibration-review.md`、
`embed-eval-calibration.log`、`embed-eval-fit.log`、`embed-eval-recall.log`、`embed-eval-final.log`、
`verify-final.log`、`verify-clockfix-2.log`（时钟修复后的全量测试）、`verify-clockfix-live.log`
（时钟修复后的 live 复验），以及审查修复后的复算：`embed-eval-calibration-final.log`
（旧格式，保留用于复查，不作排除分母依据）、`embed-eval-fit-final.log`、`core-smoke-fix.log`（live 连跑 2 次）、
`obs-summary-final.log`、`rank-compare-final.log`、`verify-reviewfix-final.log`、
`verify-reviewfix-final2.log`、`verify-reviewfix-final3.log`（load 回落后全绿那次 = §10 引用的 2344/0）；
第三轮审查修复后重跑的是 `backfill-fresh.log`（先清空 `embeddings` 再跑的首跑 + 重跑，§6 的表）、
`worker-live-run.log`、`core-smoke-reviewfix2.log`（233 断言全绿）、`verify-reviewfix2-static.log`、
`verify-reviewfix2-full.log`（load > 100 那次，失败全是 5 s 超时，见 §10 说明）、
`verify-reviewfix2-full2.log`（load 回落后复跑）；第四轮审查修复后重跑的是
`core-smoke-reviewfix3.log`（233 断言全绿）、`verify-reviewfix3-full.log`（全量复跑）与
`obs-summary-final.log`（重生成，含 `dimensions` 字段）；第五轮审查修复后新增的是
`backfill-dry-run.log`（§6 的 `--dry-run` 行）、`probe-request-stderr.log` / `probe-request-stdout.log`
（把上游 base URL 指到死端口复现失败，证明 `embed.request` 的 `retryable` / `fatal` 全在 stderr、
stdout 一条都没有）、`verify-reviewfix4-full.log`（全量复跑）；**范围外发现修复（§12）那一轮**新增/重跑的是
`core-smoke-scope5b.log`（236 断言 / 29.1 s，§6.1 的补投端到端证据）、`obs-summary-scope5.log`
（§7 的 live 块：含内容指纹腿与 `withVersionFreshVector`）、`backfill-v1-to-v2.log`（§6.1 / §12 的
"v1 → v2"实证）、`worker-upgrade-run.log`（同一轮的 worker 日志全文）、`verify-scope5-full.log`
（全量复跑），以及 `core-smoke-scope5.log`——那是**失败**的一次：demo 段曾把终态钉成 v2，实际是
v1/100，保留它因为它是"补投只补目标侧"的现场（§6.1 末尾）；**rebase 到 `origin/main = 0b8ab72e` 之后**
重跑/新增的是 `backfill-rebase-run1.log` / `backfill-rebase-run2.log`（§8 的 rebase 复跑段：首跑 6 条请求、
立刻重跑 0 条请求）、`worker-rebase-run.log`（§8 的 worker live 全文）、`core-smoke-rebase.log`
（266 断言 / 28110 ms，§6.1 与 §10）、`obs-summary-rebase.log` 与 `obs-summary-rebase2.log`（§7 的 live
块，前后两次快照）、`verify-rebase-full.log`（§10 的全量 3278 pass / 313 文件 / 64.89 s）、
`ann-probe-real.log`（§5 / §12 的 `--source=real` 档位：`source:"real"`、`realEmbeddingRows 6`、
`realEmbeddingModels 1`、p50 0.076 / p95 0.148 ms、`needsAnn:false`）、
`verify-rebase2-full.log`（§10 的全量 3279 pass / 313 文件 / 115.86 s，第七轮审查修复后）；
另有过程诊断输出 `embed-eval.log`、`embed-eval-fixture.log`、`recall-diagnostic.log`。
这些文件是**本机复算留痕**，是否随 PR 提交由 Owner 决定。

## 12. 已知问题与范围外发现

- **4 条已知算法误判**（§3.5）：FP=3、FN=1，全部计入57条主分母；历史字段名不用于豁免。
- **`floorLeaks = 20`**：更多弱相关对拿到非零语义分；floorMisfires=0 仅描述低于floor的漏召回，
  不代表没有假阳性。完整标定结果为53/57，不宣称排除后全对。
- **stub 环境的语义分恒 0**：stub 的余弦尺度（seed 相关对 0.33–0.49）与真实模型不可比。CI 不受影响，
  因为 S4 的结构权重和恰好 0.70（M3 §7）。
- **范围外发现（Owner 要求修，见 §12.1）**：下列 5 条在 M4 收尾时一并修掉了，`core:smoke` /
  `requeue.test.ts` / `content-hash-sql.test.ts` / `ann:probe` 的 live 复算覆盖：
  1. **补投不对称 ⇒ 该对永久 v1**（第四轮审查 F1，major）：EMBED 结算成功后补投同实体 `MATCH_*`
     （`generateAndResumeMatching()` + `jobs/matching/enqueue.ts`），机制、去重与端到端证据见 §6.1。
     残留：v2 要两侧都有新鲜向量，只补目标侧不够（§6.1 末尾）；
  2. **seed 的 demo 对仍是 v1**（M3 §10.5）：`embed:backfill`（默认 `--entity=both`）补齐两侧后升到 v2，
     实证 `.m4-evidence/backfill-v1-to-v2.log`（`v1/100/NULL` → `93/77/v2`）；seed 契约本身未动；
  3. **M1 遗留"3 次失败后无补投"**（M3 §10.6）：新增 `apps/worker/src/jobs/embedding/requeue.ts`
     的 `scheduleFailedEmbedRetry()`（额度 3 条 / 24 h 窗口 / `run_at = now() + 60 s` /
     `NOT EXISTS PENDING` 去重 / 坏 payload 不补投），由 `apps/worker/src/index.ts` 在
     `FAILED` 结算与启动回收两处触发，决定写进 stderr 的 `embed.retry` 事件；8 个用例见
     `requeue.test.ts`。**没有动队列退避**（`queue.ts:138` 的"重试不引入退避"注释与 `:145` 的
     `SET ... run_at = now()`，以及 `docs/architecture.md:150` 的"重试：不退避"，都是 M2 冻结协议）；
  4. **`ann:probe` 用合成随机向量**：新增 `--source=auto|real|synthetic`（默认 `auto`：真实向量够就
     `real`），`real` 时用 `ann_seed` 临时表按固定 `row_number()` 取语料（不重复用同一条，避免 recall
     虚高），真实行不足时直接 exit 2 并提示先跑 `embed:backfill`。本机 live 库只有 6 条真实向量，
     所以 `real` 只跑到 `--sizes=6`（实证 `.m4-evidence/ann-probe-real.log`：`source:"real"`、
     `realEmbeddingRows 6`、`realEmbeddingModels 1`、p50 **0.076** ms / p95 **0.148** ms、`--no-index`、
     `needsAnn:false`；探针里已注明 `realEmbeddingRows` 是"维度匹配"的**超集**，不区分模型、不排除
     版本号落后的行，只用于判"够不够跑 real 档"与 `needsAnn` 的行数腿，偏保守）；旧1万–10万行
     合成曲线已撤回，修正后1千/5千/1万行结果见§5；
  5. **`obs:summary` 的覆盖率缺 `contentHash` 腿**（第四轮审查 F3，minor）：新增
     `apps/worker/src/jobs/embedding/content-hash-sql.ts` 在 SQL 侧复刻 TS 指纹，`withVersionFreshVector`
     作为诊断对照；对拍见 §7。

### 12.1 仍未做 / 需要另开 issue

（第 1、3 条仍未做；第 2、4 条已在 #322 尾项分支修复，标 **已修**。）

- **合成向量下的 HNSW recall 损失**：§5 的触发条件（p95 > 50 ms 或 ~10 万行向量）是在合成分布上量的；
  真实语料到量级后要用 `--source=real` 复测（脚本已支持）。
- **`MATCH_LISTING` 没有 partial unique index**（**已修**）：`enqueueMatchJob()` 只能靠 `NOT EXISTS` 去重，
  并发窗口最坏多一条**幂等**重算（`core:smoke` 的"恰好 1 条通知"断言保证通知不重复）。彻底关掉要加
  partial unique index + migration。
  → 已加 `jobs_match_listing_listing_id_pending_uidx`（`(payload->>'listingId')` where
  `type = 'MATCH_LISTING' AND status = 'PENDING'`，drizzle 生成 `20261004193208_ordinary_bucky.sql`）；
  有编辑过的旧库里本来就堆着多条 `PENDING`，所以前一条数据迁移
  `20261004193147_dedupe_pending_match_listing_jobs.sql` 按 `(run_at, id)` 只留最早一条再建索引
  （否则 `CREATE UNIQUE INDEX` 直接 23505）。投递侧四处裸 INSERT 改成 `ON CONFLICT DO NOTHING`，
  语义从"每次编辑追加一条"变为"待跑期间复用同一条，领走后再编辑才追加"（`NOT EXISTS` 现在只是
  廉价前置过滤，原子性由索引保证）；回归 `apps/worker/src/jobs/matching/enqueue.test.ts`。
- **补投只覆盖目标侧**（§6.1 末尾）：愿望（候选）侧的向量只能靠 `EMBED_WISH` / `MATCH_WISH` 或
  `embed:backfill` 产生，引擎不会为候选侧补投。
- **失败补投只有日志**（**已修（部分）**）：`embed.retry` 是 stderr 事件，额度用尽（同一实体 24 h 内 3 条）
  后 job 停在 `FAILED` 终态，没有告警通道，需要人看日志。
  → `obs:summary` 新增 `obs.retries` 事件与 `obs.summary.exhaustedEmbedRetries` / `stuckEmbedRetries`
  两个计数（§7），把"额度用尽"从一行 stderr 变成**可随时重跑、可聚合**的查询口径；仓库里没有告警基建，
  所以**这不等于真正的告警通道**，人仍要主动跑 `obs:summary`（或接告警的人自己去查）。

## 13. 本轮收尾状态：最终审查BLOCK，当前修复版本需新独立验证

（本节记录的是**当时**状态；其后经第二轮、第三轮 fresh 审查修复，并已完成 O 组 live 测量，最终状态见 §16 与 §17。）

- Owner 确认“明确冲突才拦截，未知沿用hybrid”；本地门禁与解释边界见
  [constraint gate](issue-322-matching-v2-constraint-gate.md)。不调整权重/阈值，不加商品/品牌补丁。
- 新鲜度时钟倒退、未知陈述误杀、完整质量报告、保留旧模型及ANN重复语料均有新增回归。
  修复前5条失败；第三轮小修复后约束/引擎定向35/35，新增独立fixture/脚本定向6/6，最新全量3306/3306（317文件）。
  脚本strict类型检查/全仓typecheck/lint均exit 0，API+Worker的stub core smoke 266断言通过；工程证据与独立live质量分开报告。
- 五轮fresh审查均为BLOCK，不宣称通过。标题无条件肯定已移除，标题/描述共享完整声明语法；复合标题不解析时退为unknown。
  标题作用范围与复合命名退化均有回归，原误杀修复前失败；修复后约束/引擎定向38/38，全仓类型/lint及stub core smoke 266断言通过。
  脚本strict检查完整命令与明确退出码在`.m4-evidence/review-5-script-typecheck.log`。实现已改变，最终fresh复审与新独立门禁仍需完成。第三轮无问号疑问助词也已修复。第二轮三条发现均有修复前失败、修复后通过的回归：
  疑问不能截取“不是”当否定；queue.runOnce须在类型信息尚在时脱敏；补投测试须清理实际插入的新任务。
- Drizzle错误message含SQL/params，脚本采用安全errorMessage；常驻Worker的真实路径现由queue在落last_error前调用它，
  再将安全字符串传给job.settled。runOnce→存储→日志回归验证私密参数不泄露，不能仅凭logger单测宣称全链安全。
- requeue测试按本文件唯一实体ID及初始job ID清理，包含生产函数补投的任务；不改生产补投接口。
- H01–H24 是修复回归集，缓存回归22/24（FP=H17/FN=H07）明确标记非独立。完整57条历史标定集53/57（FP=3/FN=1）。
- [N01–N24 新独立样本](issue-322-matching-v2-holdout-2.md) 在Owner明确回复“确认”后冻结，未据结果修算法/改标签。
  `bun run embed:holdout --independent` 在旧冻结实现实测hybrid **23/24**、同组v1 **18/24**、semantic-only **17/24**；FP=N24、FN=0。
  全部24条保留，两方向一致，全部vector recall；分类/预算负例以及v1/hybrid两方向的状态/审核/自己商品8个探针均无硬规则违反。
  N24仍是兼容性误匹配（cosine .717785，score 85，constraint=unknown），不豁免，也不宣称任意兼容性推理可靠。
  第四、五轮审查后实现已修改，上述结果只证明冻结旧实现，不作为修复版本的独立通过证据；原结果保留，不重写通过状态。
  [O01–O24](issue-322-matching-v2-holdout-3.md)的O16标签已按本轮审查与Owner裁决从“否”纠正为“是（unknown放行）”（口径13是/11否，输入与算法未动）；当时尚未测量，**其后已于 2026-10-03 测量并通过（hybrid 23/24、v1 18/24、FP=O24、已知分歧=O16），见 §17**。
- 当时本次独立live请求5次，累计**10/200**；修复回归、ANN和stub core smoke不新增出网请求，不操作生产库。
  冻结记录与完整结果在 `.m4-evidence/holdout-independent-{freeze,result}.json`，执行记录在 `holdout-independent.log`。
  O 组测量又用 5 次（见 §17），累计 **15/200**。
- 切换/回滚必须执行[runbook](issue-322-matching-v2-cutover.md)，双侧补齐及结算验证不能省略。
  尚未提交/推送/合并本轮改动，也不关闭Issue。

## 14. 本轮 fresh 对抗审查的修复与最终工程验证

审查结论：**BLOCK**，可执行发现已全部处置；实现随之改变，因此最终 fresh 复审与新独立 live 质量门禁仍需重跑，**不报告就绪**。
（本节数字是**当时**状态；其后又经第二轮 fresh 审查修复，最新数字见 §15。）

已修：
1. **O16 标签（BLOCKER）**：冻结实现的完整分句口径下“不要有线的”判 unknown，而 O16 结构分项
   kw/cat/price 全 100 = 0.32+0.15+0.23 = 70 = `MATCH_SCORE_THRESHOLD`，任何语义分都过线 ⇒
   原“否”标签是确定性错配。我独立复算 24 条的结构下限（semantic=0）确认 O16 是唯一结构性错配。
   Owner 裁决改为“是（unknown 放行）”，与 O07 同口径；`holdout-3.md` 口径改 13 是 / 11 否，
   `independent-holdout-o-fixture.ts` 与转写测试同步，输入与算法未动。
2. **`log.ts` SQLSTATE 丢失（MAJOR）**：真实 Bun 驱动错误把 SQLSTATE 放 `errno`
   （`code = 'ERR_POSTGRES_SERVER_ERROR'`）。改为 `errno` 优先、兼容 pg 风格 `code`
   （分支上已提交的 `queue.test.ts:206` 要求能取到 `23514`），并排除带数字 `errno`/`syscall`/`path`
   的 Node 系统错误。`log.test.ts` 用真实形状重写，新增 pg 风格与 EPERM 两条。
3. **`log.ts` fail-open（MINOR）**：裸驱动错误原会回传 `error.message`，把绑定参数值写进
   `job.last_error`（实测 `invalid input syntax for type integer: "PRIVATE_WISH_TEXT"`）。
   现默认拒绝，只回 `database query failed` 或 `database query failed (SQLSTATE XXXXX)`。
4. **transactions 时钟残留 + 状态漂移新鲜度缺口（MAJOR）**：见 §9 新增行与“状态漂移的向量版本补投”段。
   accept / cancel / confirm 完成 / 核销完成四条路径改 `clock_timestamp()` 并同事务补投 `EMBED_LISTING`；
   新回归 `apps/api/src/modules/transactions/store.test.ts` 修复前 2 fail / 修复后 2 pass。

最终工程验证（本机 scratch 库，0 次 live 请求，HTTP 预算仍为 10/200）：
- `bun test --isolate`：**3312 pass / 0 fail / 11534 expect / 318 文件**（149.42s）。
- `bun run typecheck`：9 个包 exit 0。
- `bun run lint`：Checked 1055 files / 4 warnings（来自 main 既有文件）/ exit 0。
- `EMBEDDING_TRANSPORT=stub bun run core:smoke`：266 断言通过（26858ms）。
- 日志：`.m4-evidence/verify-m4-final2-full.log`。

仍未通过 / 仍未做：
- 最终 fresh 对抗复审（实现已改变，必须重跑）。
- 新独立 live 质量门禁：O01–O24 未测量（已获批 5 次 HTTP）。
- `.m4-evidence/` 被 gitignore，N 组 23/24 与本轮日志无法从干净 checkout 复现，只有文档记录；
  `holdout-independent-freeze.json` 冻的是旧实现哈希（`2525d827…` ≠ 当前 `606aec56…`），
  O 组改用独立文件 `holdout-independent-o-freeze.json` 冻结当前实现。
- 尚未提交/推送/合并本轮改动。

## 15. 第二轮 fresh 对抗审查的修复与最终工程验证

审查结论：**BLOCK**，可执行发现已全部处置（F1–F6；F3 经 Owner 裁决）；实现再次改变，因此最终 fresh 复审与 O 组 live 门禁仍需重跑，**不报告就绪**。

已修：
1. **F1 MAJOR（日志脱敏漏点）**：`apps/worker/src/index.ts` 的视觉维护 catch 原用
   `error instanceof Error ? error.message : String(error)`，而该 catch 包住会查 DB 的
   `visualBackfill.runPass()` 与 `cleanupExpiredVisualQueryImages()` ⇒ 真实 drizzle 错误的 SQL 文本与绑定参数值原样进 stderr
   （实测形状 `message: "Failed query: select $1::int\nparams: PRIVATE_VALUE"`、`cause.errno: "22P02"`）。
   该文件顶层有副作用（建队列、`recoverStaleClaims`、主循环），无法被测试 import，故把维护逻辑抽到
   `apps/worker/src/jobs/visual-embedding/maintenance.ts` 的 `createVisualMaintenance()`，失败上报改 `errorMessage()`；
   `index.ts` 只保留 `const runVisualMaintenance = createVisualMaintenance({...})`，主循环调用点未动。
   新回归 `apps/worker/src/jobs/visual-embedding/maintenance.test.ts`（4 test / 13 expect）：
   失败前把上报改回 `error.message` → **2 pass / 2 fail**，失败断言收到的字面值含
   `Failed query: delete from media_objects where id = $1` 与 `params: PRIVATE_MEDIA_ID`；修复后 4 pass。
2. **F2 MEDIUM（愿望侧状态漂移）**：`apps/api/src/modules/wishes/store.ts:217` 的 `updateStatusIfActive` 取
   `clock_timestamp()` 推进实体版本，但唯一调用点 `transition`（`apps/api/src/modules/wishes/service.ts`）不投 job；
   实测 `similarWishesByIds` 由 1 条变 0 条而行仍在 ⇒ 需求 2 的不变式不成立。
   已修：`transition()` 在成功分支与“已经是目标态”分支都补投 `matchQueue.enqueue(id)`
   （成对投 EMBED_WISH + MATCH_WISH；对非 ACTIVE 愿望 `engine.ts:611` 会 `skipped('target-not-active')`，不写匹配行）。
   诚实边界：四个匹配读接口与 `narrowedWishes` 都只看 `status='ACTIVE'`，终态愿望今天本就不会再被匹配，
   所以这不是用户可见回归，而是**不变式缺口**（`matchListing` 既有行重算走无 status 谓词的 `similarWishesByIds`，只会剩结构分）。
   新回归在 `apps/api/src/modules/wishes/service.test.ts`：去掉两处补投 → **8 pass / 1 fail**；修复后 **9 pass / 0 fail / 24 expect**。
3. **F3 MEDIUM（口径分歧）**：O16 由“否”改为“是”后，`falsePositiveIds = hybridMatch && !expected` 会让这条已知错配
   在唯一剩下的独立 live 门禁里永久消失，还计入 `hybridAgreements` 分子。Owner 裁决**维持“是（unknown 放行）”并显式披露**：
   `independent-holdout-o-fixture.ts` 新增 `INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES = ['O16']`，
   `embed-holdout.ts` 把它写进 `summary.knownDivergenceIds`（随 `holdout.summary` 日志与 result JSON 输出），
   [holdout-3](issue-322-matching-v2-holdout-3.md) 验收口径写明这是 Owner 裁决显式披露的已知口径分歧；
   验收仍为 hybrid≥22/24 且 FP≤1（O16 不计入 FP），但**不得把它汇报成“0 条假阳性”**。
4. **F4 LOW（证据可复现）**：全量验证日志此前未固定传输方式（`.env` 是 live）。本轮起证据命令一律
   `EMBEDDING_TRANSPORT=stub bun test --isolate`，并把命令头写进日志（`verify-m4-final3-full.log`、`verify-m4-final4-full.log`）。
5. **F5 LOW（口径表述）**：审查报告认为 v1 基线不含门禁，经核代码**不成立**：v1 与 hybrid 都走
   `scoreConstrainedMatch`（`engine.ts:449` 商品方向、`:725` 愿望方向；`similarity` 缺失即 `null` 走 v1 分支），
   门禁两侧生效，判定是严格大于（`embed-holdout.ts` `hybridAgreements > v1Agreements`）；
   只有结果行的诊断字段 `v1Score` 不含门禁。[holdout-2](issue-322-matching-v2-holdout-2.md) 早已写明“同组v1正确（同一约束门禁，真实fallback落库）”，
   holdout-3 验收口径已补写同口径机制与严格大于。
6. **F6 LOW（结果可核对）**：`embed-holdout.ts` 原先只在独立验证时才计算 6 个算法文件哈希。现改成任何运行都算，
   并把 `algorithmHashes` 写进 result JSON ⇒ 单看结果文件即可判断跑的是哪份实现（冻结对象字段未变，N 组冻结比较仍通过）。

范围外只报告、未修（本 PR 未触碰这两个文件，按 AGENTS.md 不在本 Issue 顺手改）：
- `apps/api/src/app.ts:110-125` 的 `describeError` 取 `error.message.split('\n')[0]`，由 `:678` 输出 ⇒ drizzle 首行
  `Failed query: <SQL>` 会进日志（绑定参数因只取首行被截掉）。
- `apps/api/src/modules/recommendation/service.ts:131,:383` 直接 `console.error(..., error)` 打印整个错误对象。
若把需求 3 按“任何一条日志行都不得含 SQL 文本”字面执行，这两处尚未达成；是否开 Issue 由 Owner 决定。

最终工程验证（本机 scratch 库，0 次 live 请求，HTTP 预算仍为 10/200）：
- `EMBEDDING_TRANSPORT=stub bun test --isolate`：**3318 pass / 0 fail / 11553 expect / 319 文件**（199.64s）。
- `bun run typecheck`：9 个包 exit 0。
- `bun run lint`：Checked 1057 files / 4 warnings（来自 main 既有文件）/ exit 0。
- `EMBEDDING_TRANSPORT=stub bun run core:smoke`：266 断言通过（47532ms）。
- 日志：`.m4-evidence/verify-m4-final4-full.log`（首轮 pin stub 为 `verify-m4-final3-full.log`）。

仍未通过 / 仍未做：
- 最终 fresh 对抗复审（本轮修复后实现已再次改变）。
- O01–O24 live 质量门禁未测量（已获批 5 次 HTTP；`--independent-o` 用独立冻结文件 `holdout-independent-o-freeze.json`）。
- `.m4-evidence/` 被 gitignore，live 证据无法从干净 checkout 复现；上述两处范围外日志泄漏未修。
- 尚未提交/推送/合并本轮改动。

## 16. 第三轮（增量）fresh 对抗审查的修复与最终工程验证

审查范围只有本轮 delta 的 9 个文件，结论 **BLOCK**：只有 1 条可执行发现（F1），另有 2 条文档/口径缺口与 2 条 INFO 级注释口径问题。全部已处置；F4 类"其他 `now()` 写入点"按 AGENTS.md 只报告不修。

已修：
1. **F1（需求 2 不变式，LOW–MEDIUM）**：`apps/api/src/modules/wishes/service.ts` 的并发竞态分支
   `if (rowStatus(concurrent) === target) return toWishDto(concurrent)` 是一次**成功返回**（客户端不会重试），
   但没有补投向量刷新。若赢家写入状态后 `enqueue` 抛错或进程崩溃，这条愿望的向量行
   `source_updated_at` 就永久停在旧版本（`freshWishesEmbedding()` 要求毫秒等值），且如 §15 所述
   没有任何后续请求会修它 —— 与第 115-120 行修掉的是同一类问题。已在该分支 return 前加
   `await refreshVectorAfterTransition(id)`。
   新回归 `apps/api/src/modules/wishes/service.test.ts`：`并发竞态输家返回目标态时同样补投……`
   （`RacingWishStore` 覆写 `updateStatusIfActive` 把行改成目标态后返回 `null`，模拟另一连接先提交）。
   失败前证据：把该分支还原成单行 → 该文件 **9 pass / 1 fail**（`Expected -3 / Received +1`）；修复后
   三个定向文件 **16 pass / 0 fail / 44 expect**。
2. **F5（注释口径，INFO）**：`refreshVectorAfterTransition` 的注释原文称终态愿望"永久掉出语义候选"，
   高估了用户可见影响。已改为如实边界：向量行确实会掉出 `similarWishesByIds`（唯一调用点 `engine.ts:568`），
   但终态愿望本就被 `creatable()`（`engine.ts:584-596`）排除 ⇒ 这是**不变式与 `obs:summary` 新鲜度可观测性**的缺口，
   不是用户可见召回回归；并写明投递在状态写入之后、不假装原子、重试与并发分支都会补投。
3. **F2（验收口径透明，LOW）**：脚本 `passed`（`embed-holdout.ts:408-417`，进程退出码同源）除四条已批准口径外
   还要求 `summary.allVectorRecall`、`summary.hardRuleProbeControlValid`、`summary.hardRuleProbeViolations === 0`，
   而三份文档此前对这些字段零命中 ⇒ 门禁可能 exit 1 而"已批准口径全过"。
   [holdout-3](issue-322-matching-v2-holdout-3.md) 验收口径已逐项补写这三项的语义
   （并说明 `hardRuleProbeViolations` 与 `hardRuleViolationIds` 是不同字段），声明文档口径与脚本判定以该节为准。
4. **F3（证据可复现，LOW）**：[holdout-3](issue-322-matching-v2-holdout-3.md) 记录的执行命令改为
   `EMBEDDING_TRANSPORT=live EMBEDDING_MODEL=text-embedding-v4 bun run embed:holdout --independent-o`，
   并说明为什么必须显式写前缀（`.env` 被 gitignore、`.env.example` 是 `stub`，干净 checkout 下会在
   `embed-holdout.ts:121-123` 中止；脚本自身拒绝非 live，所以产出的证据一定是 live）。
5. **F2 后半（冻结覆盖面）**：`embed-holdout.ts` 的 `algorithmFiles` 由 6 个扩到 **9 个**，加入
   `apps/worker/src/jobs/embedding/handlers.ts`、`apps/api/src/modules/wishes/match-queue.ts`、
   `packages/db/src/schema/common.ts` ⇒ 冻结记录现在也能发现后续对 M4 向量新鲜度修复的改动。
   （N 组冻结比较本就因 `constraints.ts` 哈希变化而失败，多这几项不改变该结论；O 组冻结尚未创建。）

只报告未修（均非本轮 delta 引入，且本 PR 未触碰这些文件）：
- `apps/api/src/modules/wishes/store.ts:142` 的 `createWish` INSERT 仍用 `now()` 写 `updated_at`：
  新行不存在版本倒退、等价 schema `defaultNow()`，且 EMBED_WISH 同事务投递 ⇒ 无新鲜度回归。
- 同类 `now()` 写入点（都不是 embedding 实体、按 §9 保持原语义）：`apps/api/src/modules/messages/store.ts:434,:478`、
  `apps/api/src/modules/messages/media-store.ts:241`、`apps/api/scripts/core-smoke.ts:1422`。
- §15 已列的两处范围外日志泄漏（`apps/api/src/app.ts:110-125`、`apps/api/src/modules/recommendation/service.ts:131,:383`）不变。

审查者独立复算并认可的（可引用）：需求 1 的脱敏修复**承重且 red-before-fix**（回退成 `error.message` → 2 pass / 2 fail，
泄漏原文含 `Failed query: select $1::int` 与 `params: PRIVATE_WISH_TEXT`）；`index.ts` 维护抽取忠实
（唯一行为差异是改用 `errorMessage`）；需求 4 只有 `contradicted` 归零、唯一入口 `engine.ts:449`/`:725`；
需求 2 商品侧 `listings/store.ts:816` 同事务；O 组 fixture 与文档逐字段一致且 `holdout-independent-o-{freeze,result}.json`
**不存在** ⇒ 标签未因任何测量结果改动。

最终工程验证（本机 scratch 库，0 次 live 请求，HTTP 预算仍为 10/200；命令头 pin `EMBEDDING_TRANSPORT=stub`）：
- `EMBEDDING_TRANSPORT=stub bun test --isolate`：**3319 pass / 0 fail / 11555 expect / 319 文件**（185.90s），exit 0。
- `bun run typecheck`：9 个包 exit 0。
- `EMBEDDING_TRANSPORT=stub bun run core:smoke`：266 断言通过（31967ms），exit 0。
- `bun run lint`：**Checked 1057 files / 4 warnings（全部来自 main 既有文件）/ exit 0**。
  工程注意：`bun run lint` 的第一次运行（与并行审查子代理同时）曾报 2 个 format error，来源是该子代理留在仓库内的
  临时探针目录 `apps/worker/.verify-scratch-red/`（不是本改动）；它清理后复跑即上表结果。
  教训：**并行子代理的仓库内 scratch 会污染 lint/全量测试证据**，验证必须在所有写者退出后重跑。
  本节的数字来自所有写者退出后的最后一次全量运行（`date: 2026-10-03T15:21:03+08:00`，日志头部含当时 `git status --short`）。
- 日志：`.m4-evidence/verify-m4-final6-full.log`。

### 16.1 第三轮窄口径验证（子代理 `00af54f7`，只审本轮 4 个文件）

结论：**无 blocker**。它独立复核了并发分支修复的完整性（`transition()` 恰有 3 个成功 `return` —— `service.ts:127`/`:136`/`:147`，
各自紧邻 `:126`/`:135`/`:146` 的补投；其余 `return` 全是 throw ⇒ 无漏投成功路径）、重复投递无害
（`enqueue` 先按内容指纹 prune、两条 INSERT 都 `ON CONFLICT DO NOTHING`；非 ACTIVE 愿望的 `MATCH_WISH` 被
`engine.ts:611`（愿望方向）/`:494`（商品方向）跳过）、新测试在去掉那一行后确实变红（9 pass / 1 fail），
以及 freeze 校验发生在 `CREATE DATABASE`（`:206`）与首次 `provider.embed()`（`:299`）之前。

它提出的 3 条（全部已处置）：
1. **[holdout-3](issue-322-matching-v2-holdout-3.md) 验收口径的项数与指代错误**：原文写"上面四条 + 三项 = **7 项**"，
   而脚本 `passed`（`embed-holdout.ts:408-417`）是 **9 个 `&&` 条件**（第一条验收口径本身含 6 个判定）。
   已改为逐条列出这 9 项并修正指代 —— 这正是 R5 要禁的口径漂移。
2. **过期行号**：原文引 `embed-holdout.ts:403-412`（`passed` 实际在 `:408-417`）。已改（holdout-3、本文件、constraint-gate 三处）。
3. **`algorithmFiles` 不是严格超集**：原 9 个文件未含真正产出被测量向量的
   `apps/worker/src/jobs/embedding/providers/index.ts`、`providers/live.ts`，以及 `packages/db/src/schema/embeddings.ts`。
   已扩到 **12 个**（残留风险：日后在 `live.ts` 加归一化这类不改 model/dimensions/text 的变换会让 O 组静默漂移）。
   它同时确认：旧 N 组冻结的 `algorithmHashes` 恰是旧 6 个键 ⇒ 现在重跑 `--independent` 会硬抛"独立集冻结记录不一致，未出网"，
   与"旧 N 结果不用于当前版本验收"自洽；O 组 freeze/result 均尚不存在，将首次冻结。

它未能验证（如实计入）：freeze 不一致时的抛错未实跑（需 live，被硬约束禁止）、O 组 live 门禁本体、真实上游行为。

仍未通过 / 仍未做：
- O01–O24 live 质量门禁**已于 2026-10-03 测量并通过**（5 次 HTTP，累计 15/200），见 §17；以上“仍未做”仅指本节当时状态。
- `.m4-evidence/` 被 gitignore，live 证据无法从干净 checkout 复现；三处范围外日志/`now()` 位点未修。
- 尚未提交/推送/合并本轮改动。

## 17. O 组（O01–O24）live 质量门禁：已测量并通过

Owner 批准的 5 次 live 请求已于 2026-10-03 执行完毕（累计 **15/200**）；实现与标签在此前已冻结，测量后未再改动。

命令与证据：
- `EMBEDDING_TRANSPORT=live EMBEDDING_MODEL=text-embedding-v4 bun run embed:holdout --independent-o`（真实 `text-embedding-v4` / 1536 维；传输显式固定，不依赖 gitignored 的 `.env` 默认值）。
- 冻结（在**任何建库与出网之前**写入）：`.m4-evidence/holdout-independent-o-freeze.json` —— 24 条样本 + `inputHash 7b927f0517df576041d2f5d964d4827a526eac2002c2feedf464ccafd8db8f1f` + 12 个算法文件哈希。
- 结果：`.m4-evidence/holdout-independent-o-result.json` —— 其 `inputHash` 与 `algorithmHashes` 与 freeze **逐字段相同**。
- 进程输出：`.m4-evidence/holdout-o-live.log`；通过后 scratch 库 `fish322_holdout_1791012360760_1324` 已 DROP（既有 N 组留存库未动）。
- 预算文件：`{"requests":15,"limit":200}`。

门禁结果：`passed = true`，进程 exit 0。

| 指标 | 实测 | 阈值 | 结论 |
| --- | --- | --- | --- |
| hybrid 一致 | **23/24** | ≥22 | 通过 |
| 同组 v1 一致 | **18/24** | 严格小于 hybrid | 通过（23 > 18） |
| FP | **1**（O24） | ≤1 | 通过 |
| FN | 0 | — | 通过 |
| 两方向不一致 | 0 | 0 | 通过 |
| 硬规则违反（`hardRuleViolationIds`） | 0 | 0 | 通过 |
| 硬规则探针 | `hardRuleProbeViolations=0`、`hardRuleProbeControlValid=true` | 0 / true | 通过 |
| 向量召回 | `allVectorRecall=true`（24 条两方向都走 `vector-topk`） | true | 通过 |
| 已知口径分歧（不计入 FP） | `knownDivergenceIds=["O16"]` | 显式披露 | 已披露 |

诚实口径（两条必须一起汇报，逐条细节见 [holdout-3](issue-322-matching-v2-holdout-3.md) 的“测量结果”节）：
1. **O24 是真实假阳性**：cos 0.7007 → 语义分 100、总分 85；愿望“必须支持华为平板”被落成 `unknown`
   （约束门禁未识别该需求谓词），而结构分项本身已达 70，因此过线。它与 N 组的 N24 同类，
   本组 FP 上限（≤1）因此被占满。
2. **O16 是已披露的已知分歧**：按标签它计入 23/24；按严格读法它是错配 ⇒ 严格口径下为 **22/24**。
   汇报**不得**写成“FP=1 且无已知分歧”。

语义召回的边际：O03/O04/O05/O06/O08/O11 六条（关键词分 0、v1 裸结构分 65 < 70，故 v1 漏判）由语义分
（cos 0.616–0.729）推到总分 76–85 而判中 —— 这是 v2 相对同组 v1 的主要增益（18 → 23）。
正确拒绝侧：O13/O21 语义分 0（总分 55）、O19（cos 0.493）/O20（0.433）/O23（0.570）均在阈值下；
O14/O15/O23 结构层 `eligible=false`；O17/O18/O22 命中 `contradicted` 被归零。

结论：O 组独立 live 门禁**通过**，且是在冻结实现上一次性测得（未因结果改标签、删样本或调参）。
仍如实保留的缺口：`.m4-evidence/` 被 gitignore ⇒ live 证据无法从干净 checkout 复现（指纹已记入文档与结果文件）；
§15/§16 列出的范围外日志与 `now()` 位点未修（本 PR 未触碰那些文件）。

## 18. 报告不修：CI 的 `scripts` 过滤器是子串匹配

推送后 CI 的 `unit-tests` 作业（**没有 postgres 服务**）报 2 个失败，全部落在
`apps/worker/src/jobs/embedding/maintenance-cli.test.ts` 的 ANN 探针用例上（本地与 `db-tests` 作业都有真实
pgvector 库，所以本地全量一直是绿的，这个缺陷在推送前不可见）。

- 机制：该作业用 `bun test --isolate "${targets[@]}"`，其中 `targets` 含裸路径参数 `scripts`；**Bun 把位置参数当子串过滤器**，
  因此任何路径里带 `scripts` 的测试文件都会被一起拉进这个无数据库的作业。
  实测：`bun test --isolate scripts` 会同时运行 `scripts/ci-changes.test.ts`、`scripts/utc8-timestamp-prefix.test.ts`
  与 `apps/worker/src/jobs/embedding/maintenance-scripts.test.ts`（后者的 ANN 用例要 spawn `ann-probe.ts` 建表/建索引）。
- 本 PR 的处置（在范围内）：把该文件改名为 `maintenance-cli.test.ts`（并加注释说明原因）。改名后
  `bun test --isolate scripts` 在无数据库时 **20 pass / 0 fail**（此前 23 pass / 2 fail），
  文件本身在真实库下 **5 pass / 0 fail**，且仍由 `db-tests` 作业的 `apps/worker` 过滤器覆盖。
- **不修的部分（报告给 Owner）**：`.github/workflows/ci.yml` 里 `targets+=(scripts)` 这个裸过滤器本身
  仍会误吞未来任何名字带 `scripts` 的测试文件；把它改成路径锚定（例如 `./scripts`）属于 CI 基础设施改动，
  不在本 Issue 范围。顺带记录：本地实测 `bun test --isolate ./scripts` 只会匹配到 `scripts/ci-changes.test.ts`（13 tests / 1 file），
  会漏掉 `scripts/utc8-timestamp-prefix.test.ts`，所以该改法不能照抄，需要按 Bun 的过滤器语义另行验证。
