# #322 愿望匹配 v2 — 第二阶段（M2）：向量候选召回（Top-K）

> 状态：**代码已落地，待评审**。M2 只把**候选集**从「结构化全量」换成「结构化过滤 ∩ 向量 Top-K ∪ 已有匹配行」；
> 打分仍是 v1 的三项加权（**Hybrid Ranking 属 M3**），backfill 与 live 验证属 M4。
> 关联：需求载体 [#322](https://github.com/zzstar101/FISH/issues/322)（OPEN）｜ 前置阶段 [M1 设计文档](./issue-322-matching-v2-m1.md)（PR #328，stacked base）
> 行号基线：`origin/main = 4f49325706b113e96063f12778b0fe4c5f40cabf`；实现分支 `feat/322-m2-vector-recall`（从 M1 的 `ff99efa` 开出）；工作树 `D:\Program\FISH-wt-322-m2`
> 决策来源：Owner 在本次任务里逐条确认了 13 个设计分支（§2 逐条记录「用户选择」）

---

## 0. Owner 看这里

一句话：让匹配引擎**真的用上 M1 生成的向量**——先把候选收窄（结构化硬过滤），再按 cosine 距离取 Top-K，
然后照旧用 v1 打分与写入；目标向量不可用时**不等待、不假装**，退回 v1 的全量候选并补投一条 `EMBED_*`。

需要你本人知道的四件事：

1. **「向量未就绪 / 已过期」的硬前置已按「降级」定案**（M1 §11.1 交给 M2 的必答项）：
   目标实体**缺向量** / **向量与当前内容指纹不一致** / **只有别的模型的向量**时，本轮**退回 v1 的结构化全量候选**
   （仍然含已有匹配行），并补投一条 `EMBED_*` job；**候选侧**没有向量只是「进不了 Top-K」，不额外投递。
   没有选「跳过本轮 + 重排 job」，因为那会让已有匹配停止重算（旧高分残留）并把队列变成无退避的热循环（§5）。
2. **召回回退是明确的取舍，不是 bug**：M2 的打分仍是 v1，语义相似度**不进分数**，所以
   「v1 本来能匹配、但没进 Top-K」的组合在 M2 不再新建匹配（`K = 50` 控制影响面）。
   Issue 里「无 substring 的语义近似也能召回」这条验收**属 M3**——只有 semantic 进了分数才可能成立（§1、§9）。
3. **修掉了 `MATCH_WISH` 的「终身一条」缺口**（M1 §11.4 列的 follow-up，Owner 明确要求并入 M2）：
   部分唯一索引谓词从 `type='MATCH_WISH'` 改为 `type='MATCH_WISH' AND status='PENDING'` 并改名为
   `jobs_match_wish_wish_id_pending_uidx`。旧谓词下 `DONE` 的行会永久占位，编辑愿望后投的 job 被
   `ON CONFLICT DO NOTHING` 静默吃掉——「改了就重算」从不发生（§3）。
4. **第一版不建 ANN 索引**（Issue 允许 exact cosine scan）：实测 5000 行 1536 维的 `explain (analyze)` 是
   `Seq Scan + top-N heapsort`，**40.9 ms**；当前真实数据量是个位数商品。何时再上 HNSW 见 §8。

---

## 1. 目标与非目标

### 目标（M2）

- **两个方向同一套语义**：结构化硬过滤 → pgvector cosine Top-K → v1 打分 → 写入/降级。
  `narrowedWishes` / `narrowedListings` 是**同一份 SQL 片段**，既喂 Top-K 的 `WHERE`，也喂退化路径的全量查询。
- **评估集合 = 新 Top-K ∪ 该 target 已有 matches**（Issue 原话）：掉出 Top-K 的旧匹配仍要按真实分数重算，
  否则旧高分永久残留（§6）。
- **「目标向量新鲜」判据**：`model`（查询已带）+ `dimensions` + `content_hash == 当前内容指纹` 三者齐备。
- **可观测**：`MatchRunResult` 增 `recall` / `fallbackReason` / `vectorCandidates`（只供 worker 内部与 M4 指标，不进客户端契约）。

### 非目标（附理由）

- **Hybrid Ranking / semantic 进分数 / 权重与阈值冻结（M3）**：M2 一个字节都没碰 `scoring.ts`。
- **`acceptSimilar` 语义（M3）**：Issue 明确归 M3。
- **ANN / HNSW 索引**：见 §8，数据量与证据都不支持现在加。
- **backfill 脚本、真实 live 网络 smoke（M4）**。
- **core smoke 覆盖语义匹配链**：core smoke 的数据没有 embeddings，本轮实际走 `v1-fallback`，语义链要到 M3 才有意义。

---

## 2. 交付范围与决策（Owner 逐条确认）

| # | 决策 | 用户选择 | 理由 / 影响 |
| --- | --- | --- | --- |
| Q1 | 分支与 PR | A | 新 worktree `D:\Program\FISH-wt-322-m2`、分支 `feat/322-m2-vector-recall` 从 M1 的 `ff99efa` 开；PR base = `feat/322-m1-embedding-foundation`（stacked，M1 合入后 GitHub 自动重定向到 main） |
| Q2 | 向量未就绪策略 | A | **降级**：目标不可用 → v1 全量候选 + 补投 `EMBED_*`；候选侧不可用 → 不进 Top-K。否决「跳过本轮 + 重排 MATCH job」（已有匹配停止重算 ⇒ 旧高分残留；队列重试无退避 ⇒ 热循环）与「匹配路径内同步补生成」（违反 M1 决策） |
| Q3 | 打分范围 | A | 保持 v1 打分，M2 只换候选集；接受「掉出 Top-K 不再新建」的回退；「语义近似可召回」验收归 M3 |
| Q4 | Top-K 的 K | A | `MATCH_SEMANTIC_TOP_K = 50` 放 `packages/contracts/src/matching/schema.ts`，两方向共用，**不做 env 可配**（避免部署差异导致回归不可复现） |
| Q5 | 查询落点 | A | `packages/db/src/embedding-store.ts`：一条查询 + `topKSimilarListings` / `topKSimilarWishes` 两个类型化封装（`model` 过滤 + `innerJoin` + `ORDER BY embedding <=> $vec` + `LIMIT`），结构化条件由引擎以 `SQL` 片段传入 |
| Q6 | 模型名来源 | A | `createMatchEngine(db, { embeddingModel })`，worker 传 `provider.model`；引擎不读 env、不从表里「取任意一行」（M1 §11.6 禁止） |
| Q7 | 运行结果扩展 | A | `MatchRunResult` 增 `recall: 'vector-topk' \| 'v1-fallback'`、`fallbackReason: 'missing' \| 'stale' \| 'model-mismatch' \| null`、`vectorCandidates: number`；contracts 不暴露 ⇒ 客户端契约不变 |
| Q8 | 测试方式 | A | 手工插入 `embeddings` 行做受控 fixture（绕过 provider）：DB 层测排序/model 过滤/LIMIT/结构化过滤；worker 层测两方向对称、Top-K 边界、existing rows union、三种退化、K380 demo |
| Q9 | 文档与 PR | A | 新增本文档；PR 标题 `feat(matching): #322 M2 vector candidate retrieval`，base = M1 分支，不 `closes #322` |
| Q10 | ANN 索引 | A | 不建（exact cosine scan），PR 附 `explain (analyze)` 证据 + 何时再上 HNSW |
| Q11 | `MATCH_WISH` 终身一条 | **B** | **就在 M2 里修**（M1 原计划另开 follow-up）：谓词加 `status='PENDING'` 并改名 |
| Q12 | 索引修复的落点 | A | 落 M2 自己的新迁移，**不动 M1 已评审的迁移**（保持 stacked diff 干净） |
| Q13 | 开工确认 | A | 「按此计划开工」 |

---

## 3. DB 变更说明（CONTRIBUTING 第 6 节）

**新增迁移**：`packages/db/src/migrations/20260928213551_misty_madrox.sql`（`drizzle-kit generate` 产出，无手改）。

```sql
DROP INDEX "jobs_match_wish_wish_id_uidx";
CREATE UNIQUE INDEX "jobs_match_wish_wish_id_pending_uidx" ON "jobs" USING btree (("payload"->>'wishId')) WHERE "jobs"."type" = 'MATCH_WISH' AND "jobs"."status" = 'PENDING';
```

- **为什么**：旧谓词只有 `type`，于是「同一愿望的第一条 `MATCH_WISH`」一旦落库（无论后来是 DONE 还是 FAILED）
  就永久占用唯一键；`apps/api/src/modules/wishes/match-queue.ts` 的 `ON CONFLICT DO NOTHING` 会把后续投递**静默吃掉**。
  M1 已经把愿望编辑接进了重算路径（`updateWish` 投递 `MATCH_WISH` + `EMBED_WISH`），不修这条索引那个修复等于没生效。
- **影响面**：只放宽唯一性（`PENDING` 仍至多一条），不放宽任何读写语义；`DONE`/`FAILED` 的历史行不受影响。
- **回滚**：反向 `DROP` + 重建旧索引；因为旧索引更严格，回滚前需确认没有同愿望的多条 `PENDING` 行。
- **数据迁移**：无（纯索引替换）。
- **schema 侧同步**：`packages/db/src/schema/jobs.ts` 的索引名与谓词同步改（`drizzle-kit` 能正确识别「改名 + 谓词变化」并产出 `DROP`+`CREATE`，
  因此**不需要**新增 `AGENTS.md` 例外，journal/snapshot 门禁自然满足）。
- **`embeddings` 表结构**：M2 未改动（M1 已建），无新迁移。

---

## 4. 召回语义（两个方向共用）

```
结构化硬过滤（ACTIVE/APPROVED、非自己、分类、预算/2×预算、2 倍上限…）
        ↓  同一份 SQL 片段（narrowedWishes / narrowedListings）
pgvector cosine Top-K（ORDER BY embedding <=> $queryVector LIMIT MATCH_SEMANTIC_TOP_K）
        ↓  model 过滤（embeddings.model = 引擎当前模型）
按 id 回表拿完整行（与已有匹配行共用同一列投影）
        ↓
评估集合 = 新 Top-K ∪ 该 target 已有 matches  →  v1 打分 → matches 写入/降级
```

- **为什么把收窄条件做成 SQL 片段**：Top-K 的 `WHERE` 与退化路径的全量查询必须逐条等价，
  否则「有没有向量」会悄悄改变业务规则（例如某天多召回一个超预算愿望）。同一份片段是唯一能保证这点的写法。
- **为什么先收窄再排序**（而不是先 Top-K 再过滤）：过滤后取 K 才是「K 个**合格**候选」；
  反过来会让被硬规则排除的行白占名额（`packages/db/src/embeddings.test.ts` 有专门用例钉住）。
- **K = 50 的由来**：`/matches` 读接口默认 10 条、上限 50 条，召回池必须显著大于展示量才有「重排」的余地；
  这个值在 M3 冻结权重时需要重新评估（§10）。

---

## 5. 向量就绪与降级契约（M1 §11.1 的必答项）

| 状态 | 判据 | 本轮行为 | 补投 |
| --- | --- | --- | --- |
| `ready` | 有本模型的行，且 `dimensions` 与 `content_hash` 都与当前内容一致 | 向量 Top-K | 否 |
| `missing` | 没有本模型的行，且**也没有**别的模型的行 | v1 全量候选 | `EMBED_*` |
| `model-mismatch` | 没有本模型的行，但**有**别的模型的行 | v1 全量候选 | `EMBED_*`（按当前模型重建） |
| `stale` | 有本模型的行，但 `content_hash` ≠ 当前内容指纹（或 `dimensions` 不符） | v1 全量候选 | `EMBED_*` |

- **为什么 `content_hash` 是就绪判据的一部分**：`EMBED_*` 可能在 provider 网络调用期间被编辑（M1 用写入 CAS 保证
  最终写的是新内容，但**旧 job 也可能先落库**）。只判「有没有行」会把过期向量当新内容召回，
  违反 #322「stale embedding 不能被当新内容继续匹配」。
- **为什么不等待、不重排**：等待需要「job 依赖 job」的机制，而队列当前是单进程轮询 + 重试无退避；
  重排 `MATCH_*` 会让**已有匹配**也停止重算（旧高分残留），并且在没有新编辑时形成热循环。
  降级路径保证的是：**功能不倒退**（v1 行为原样保留）+ **不产生伪匹配**（缺失向量绝不等于「无候选」或「全命中」）。
- **为什么候选侧不补投**：一次召回可能有上百个候选，为它们排队会淹没队列；
  候选自己的 `EMBED_*` 由「创建/编辑」路径负责（M1 已接），补投责任不重复。
- **候选向量必须新鲜，而且判据必须是「内容」而不是「时间戳」**（#333 复审 blocker，第二轮）：目标侧的
  `content_hash` 判据只保证「target 的向量对应当前内容」，Top-K 里的**候选行**同样可能过期——候选实体被
  编辑、`EMBED_*` 还没跑完时，旧向量会挤掉新鲜候选，还会被按 id 补算进打分，得到「当前结构事实 + 旧语义」
  的混合分。分三层落实：
  - **主判据 = 写路径按内容指纹失效（prune-on-write）**：编辑/创建商品或愿望时，用新字段重算内容指纹，
    删掉该实体下指纹不符的向量行（`packages/db/src/embedding-store.ts` 的 `pruneStaleEmbeddings()`；不软标记，
    因为 `EMBED_*` 会重建）。于是「行还在」本身就等于「它描述的是当前内容」，与时间戳精度无关，也不取决于
    worker 何时跑到 `EMBED_*`。指纹一致的行一行不删——只改价格/图片/状态这类不进 embedding 文本的编辑照旧
    走 `unchanged`，不重复调用 provider。调用点：商品侧 `apps/api/src/modules/listings/store.ts` 的
    `enqueueListingJobsWith()`（创建/编辑/审核通过/重投递四个入口，其中三个在实体写入的**同一事务**里）；
    愿望侧 `apps/api/src/modules/wishes/match-queue.ts` 的 `invalidateStaleEmbedding()`（`enqueue` 内，
    在 HTTP 响应返回之前）。
  - **为什么不能只用时间戳**：实体 `updated_at` 由应用侧 `new Date()` 写入（毫秒分辨率），同一毫秒内的两次
    编辑内容不同却版本号相同——#328 已确立「时间戳相等推不出内容相同」。以版本相等当作主判据，这类编辑后的
    旧向量会被当成新鲜（`embeddings.test.ts` 里「同一毫秒内改内容」的用例钉住了这个边界）。
  - **时间戳谓词降级为纵深防御**：`WHERE` 里仍保留 `date_trunc('milliseconds', embeddings.source_updated_at)
    = date_trunc('milliseconds', <实体>.updated_at)`，用来兜住「某个写路径忘了调 prune」的情形（此时旧行版本
    仍停在编辑前，只要编辑落在不同毫秒就会被挡掉）。**毫秒截断是必需的**：实体 `updated_at` 是 `now()` 的微秒
    精度，而版本经 JS `Date` 往返后只剩毫秒，直接等值比较几乎永不成立（第一版实现就是这么红的）。新鲜度无法
    证明的候选**不进 Top-K**，而不是进来再降级。
  - **愿望写路径的事务性**：愿望的 `store.update` 本身不事务化（既有语义，`service.ts` 有「不假装它原子」的
    注释），所以愿望侧的失效与 `EMBED_WISH` 投递一样发生在 `enqueue()` 里、且在响应返回之前；商品侧与实体写入
    同事务。
- **「只改价格」不会误伤**：价格不进 embedding 文本，这类编辑后 `EMBED_*` 判定 `unchanged`——但版本已经前进，
  所以 `unchanged` 分支会把版本标记推进到实体当前值（`refreshEmbeddingSourceVersion()`，两个守卫：
  指纹仍然一致 + 只前进不回退），合法向量不会被后续召回判成过期。
- **`fallbackReason` 分三档**而不是布尔：`missing` 与 `model-mismatch` 的运维含义完全不同
  （前者是「还没生成」，后者是「换模型了、需要 backfill」），M4 的指标要能区分。
- **候选侧的新鲜度（M3 补，PR #338 评审 blocker）**：上表只判「目标」向量。候选侧也要判，而且必须在
  **读路径的 SQL 里**判——`topKSimilar*` 与 `similar*ByIds` 现在都带
  `source_updated_at` 与实体 `updated_at` 的（毫秒截断）相等谓词，因此「实体编辑后向量还没重算」的
  候选**不进 Top-K**（不占 K 名额），也不会被按 id 补算拿去打分（否则会得到「当前结构事实 + 旧语义」
  的混合分）。详见 M3 设计文档 §6 与 §13。

---

## 6. 评估集合与降级（「不残留旧高分」）

`matchListing` / `matchWish` 都先并行发出「该 target 已有 matches」的查询，再按 `id` 合并进评估集合：

- 候选集里**有**的行：`hadRow` 标记为已有 → 走 `UPDATE` 覆盖分数（不重复建通知）。
- 已有行但**掉出**候选集（改分类、超 2 倍预算、愿望关闭、向量被删…）：仍要评估并按真实分数覆盖。
  这正是 Issue 说的「评估集合 = 新 Top-K ∪ 已有 matches」，也是「旧高分不残留」的唯一保证。
- 收窄判据（`creatable()`）在两条路径上都要带：裸分恰好 ≥ 阈值但已不满足硬规则的那种，
  必须被判成「不可新建」，而不是靠候选 SQL 恰好排除它。

---

## 7. 可观测性

`MatchRunResult` 新增三个字段（**不进 `packages/contracts`，客户端契约不变**）：

- `recall`：本轮走的召回路径（`vector-topk` / `v1-fallback`）。
- `fallbackReason`：退化原因（`missing` / `stale` / `model-mismatch`），未退化时 `null`；
  目标实体不存在/非 ACTIVE 的 `skipped` 结果是 `null`（没跑召回）。
- `vectorCandidates`：Top-K 实际返回的候选数（`LIMIT` 截断后的数量，退化时为 0）。

M4 的「hybrid matched/downgraded 数、每次运行所用 model/ranking_version」可以直接在这三个字段上聚合。

---

## 8. 索引决策：第一版不上 ANN

**实测**（本机 `pgvector/pgvector:pg18` + pgvector 0.8.6，临时表内造 5000 行 1536 维单位向量，
`explain (analyze, buffers)`，事务内临时表、不落盘）：

```
Limit  (cost=318.90..319.02 rows=50 width=12) (actual time=40.791..40.797 rows=50.00 loops=1)
  ->  Sort  (cost=318.90..331.40 rows=5000 width=12) (actual time=40.789..40.792 rows=50.00 loops=1)
        Sort Key: ((p.v <=> q.v))
        Sort Method: top-N heapsort  Memory: 26kB
        ->  Nested Loop  (cost=0.28..152.80 rows=5000 width=12) (actual time=0.047..40.012 rows=5000.00 loops=1)
              ->  Index Scan using probe_emb_pkey on probe_emb q  (actual time=0.013..0.016 rows=1.00 loops=1)
              ->  Seq Scan on probe_emb p  (cost=0.00..82.00 rows=5000 width=22) (actual time=0.006..0.560 rows=5000.00 loops=1)
Planning Time: 0.237 ms
Execution Time: 40.863 ms
```

- 计划是 `Seq Scan + top-N heapsort`（**exact scan**，无索引），5000 行 ≈ **40.9 ms**；当前开发库的真实数据量是
  6 个商品 / 2 个愿望 / 个位数向量，量级上比这低三个数量级。
- **加 HNSW 的触发条件**（写进 §10 交给 M4）：单次 Top-K 的 p95 超过约 50 ms，或带向量的实体超过 ~10 万行，
  或 `explain (analyze)` 显示排序成为瓶颈。届时必须同时给出：索引参数（`m` / `ef_construction` / 查询侧 `hnsw.ef_search`）
  的选择理由、**Top-K recall 对照**（exact scan 作为 ground truth）与无索引/有索引两份 `explain (analyze)`。
- 现在不建的理由：ANN 是**近似**，会牺牲召回质量换延迟；在数据量不构成瓶颈时引入它，
  等于用一个不可解释的近似去换一个不存在的性能问题。

---

## 9. 验收清单映射（M2 相关条目 → 证据）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 两个方向同一套语义 | ✅ | `narrowedWishes`/`narrowedListings` 同一份 SQL 片段既喂 Top-K 的 `WHERE` 也喂退化全量查询；`engine.test.ts` 两个方向各有向量用例 |
| pgvector cosine Top-K 顺序 / model 过滤 / LIMIT | ✅ | `packages/db/src/embeddings.test.ts`：`topKSimilarWishes` 升序 `[near, middle, far]` + 距离 `0 / 0.2929 / 1`；`LIMIT 2` 截断；别的 model 的行不出现；`topKSimilarListings` 同构 |
| 结构化收窄在 Top-K **之前**生效 | ✅ | `embeddings.test.ts`「被过滤的最近候选不占名额」（`LIMIT 1` 时返回的是被允许的那个） |
| 评估集合 = 新 Top-K ∪ 已有 matches | ✅ | `engine.test.ts`「已有匹配掉出 Top-K：仍被 union 回来重算，旧高分不残留」（`vectorCandidates=0` 但 `evaluated=1`、旧 100 分被覆盖成 65） |
| Top-K 的 K 是硬边界 | ✅ | `engine.test.ts`：造 `K+1` 个候选，词法命中的那个恰是最远的第 `K+1` 个 ⇒ 不建匹配；删掉最近一个后立刻能建（证明挡住它的是 K） |
| 向量未就绪不产生伪匹配（`missing`） | ✅ | `engine.test.ts`「目标缺向量：退化 v1 全量候选 + 补投 `EMBED_*`（两方向对称）」；v1 的建行/通知行为逐项不变 |
| stale embedding 不被当新内容 | ✅ | `engine.test.ts`「目标向量过期：判 stale 并退化」；判据含 `content_hash` 与 `dimensions` |
| 不静默混用不同模型的向量 | ✅ | `engine.test.ts`「只有别的模型的向量：判 `model-mismatch`，绝不用另一种模型的向量召回」；`hasEmbeddingFromOtherModel` 在 DB 层单独覆盖 |
| 候选侧缺向量不替它投递 | ✅ | `engine.test.ts`「候选侧没有向量就进不了 Top-K：本轮不新建匹配，也不替候选投递」（`vectorCandidates=0`、`embedJobs('wish')=0`） |
| 候选向量过期时不得参与召回/打分（#333 复审） | ✅ | `embeddings.test.ts`「过期向量不进 Top-K，重算后恢复」「`topKSimilarListings` 与愿望方向同一套判据」「`refreshEmbeddingSourceVersion` 只推进内容对得上的向量」；`engine.test.ts`「候选向量过期不进 Top-K，重算后恢复」（`vectorCandidates=0`、`created=0`，重算后 `created=1`/100 分） |
| 内容变了旧向量必须**当场**失效，不能靠时间戳证明新鲜（#333 复审第二轮） | ✅ | `embeddings.test.ts`「同一毫秒内改了内容（版本号完全相同）也能让旧向量退出召回」+「只删内容对不上的行」；`apps/api/src/modules/listings/store.test.ts`「编辑内容后旧向量当场失效；只改价格不删向量」；`apps/api/src/modules/wishes/store.test.ts`「db match queue：投递前先让旧内容的向量行失效」 |
| K380 + 机械键盘 ≤¥200 demo 继续成立 | ✅ | core smoke 的 demo 流程没有 embeddings ⇒ 走 `v1-fallback`，打分与召回前的 v1 完全一致；`bun run core:smoke` 覆盖 |
| `MATCH_WISH` 编辑后能真正重算 | ✅ | 索引谓词修复（§3）+ `apps/api/src/modules/wishes/store.test.ts` 的「重复投递幂等」与 `app.wishes.test.ts` 的「PATCH 重投两条 job」 |
| `bun run typecheck` | ✅ | 全包 exit 0 |
| `bun run lint` | ✅ | `biome check .`：0 错误 |
| `bun test --isolate` | ✅ | 见 PR 描述（本轮新增 11 条用例：DB 层 4 条 + worker 层 7 条；#333 复审修复再新增 4 条：DB 层 3 条 + worker 层 1 条） |
| Worker + API 真实 DB 集成测试 | ✅ | `apps/worker/src/jobs/matching/**`、`packages/db/src/embeddings.test.ts`、`apps/api/src/**` 全绿 |
| ANN 索引决策 | ✅ | §8：exact scan 实测 + 触发条件 |
| 「无 substring 的语义近似可召回」 | ⏸ M3 | semantic 不进分数时 M2 不可能发生（§1） |
| `acceptSimilar` 有可验证差异 | ⏸ M3 | M2 未触碰 |
| 权重与阈值在证据基础上冻结 | ⏸ M3 | M2 保持 v1 权重 |

---

## 10. 交给 M3/M4 的契约与未决项

1. **`MATCH_SEMANTIC_TOP_K = 50` 是 M2 的临时值**：M3 冻结权重时必须用标注 fixture 重新评估
   （召回池大小会直接改变「哪些对有机会被重排」）。
2. **semantic 分数怎么进总分仍未定义**：cosine ∈ [-1, 1] 必须显式归一化到 0..100 并固定边界，
   不能直接混进现有 0..100 体系（Issue 原文）。M2 只保证「候选集」这一层已经就位。
3. **召回回退的影响面需要 M3 的对比数据**：M2 下「v1 能匹配但掉出 Top-K」的组合不建匹配；
   M3 有了 semantic 分数后这类组合应当被重新纳入（正是语义召回要解决的场景）。
4. **`fallbackReason` 的三档要进 M4 指标**：`missing` / `stale` / `model-mismatch` 的比例直接反映
   「embedding lifecycle 是否跟得上写入路径」与「是否发生过换模型」。
5. **`EMBED_*` 连续 3 次失败后仍无补投**（M1 §11.5）：M2 的降级路径会**每次匹配都补投一次**
   （`ON CONFLICT DO NOTHING` 去重），这实际上给「失败后自愈」提供了一条兜底路径；
   但若目标实体长期没有匹配请求，仍然不会重试——backfill/巡检仍属 M4。
6. **`recall` / `vectorCandidates` 尚未落库或上报**：M4 的观测要么把它们记进 job 结果日志（聚合），
   要么单独建表；现在只有返回值。
7. **索引决策的复核条件**（§8）：p95 > 50 ms 或带向量实体 > ~10 万行时重估 HNSW，
   并必须带 recall 对照与两份 `explain (analyze)`。

---

## 11. 本地验证命令

```bash
bun run db:up && bun run db:migrate     # 应用 M2 的索引替换迁移
bun run typecheck
bun run lint
bun test --isolate
bun run core:smoke                      # K380 demo（无 embeddings ⇒ v1-fallback 路径）
```

集成测试需要 `.env` 里的 `DATABASE_URL` 与 `.github/workflows/ci.yml` 顶层 env 那组 transport 选择
（`MEETUP_TOKEN_SECRET`、`AI_POLISH_TRANSPORT=stub`、`WECHAT_TRANSPORT=off`、`CONTENT_MODERATION_TRANSPORT=local`、
`EMBEDDING_TRANSPORT=stub`）——与 M1 相同。

---

## 12. 与 M1 的关系（stacked PR）

- 本分支从 M1 的 `ff99efa` 开出，PR base 指向 `feat/322-m1-embedding-foundation`；
  M1（PR #328）合入后 GitHub 会把 base 自动重定向到 `main`。
- **两条分支的迁移 snapshot 的 `prevId` 都指向同一个 main snapshot**（M1 §13 已记录）：
  开发可以并行，**合并不能并行**——M1 先合，本分支 rebase 最新 main 后**重新生成**迁移
  （`packages/db/AGENTS.md` 的规则：rebase 后必须重新生成），不能把两条 sibling snapshot 直接拼进 journal。
- M2 的迁移只做索引替换（§3），与 M1 的 `CREATE TABLE embeddings` 互不冲突。

---

## 13. 评审修复（第二轮 #333）：候选新鲜度的判据必须是内容，而不是时间戳

### 评审意见（review 5346491423，commit `a8b4e69`，blocker）

第一轮把「候选向量必须新鲜」放进 Top-K 的 `WHERE` 里是对的，但**判据仍然是时间戳**：
`embeddings.source_updated_at` 与实体 `updated_at` 相等（毫秒截断后）只能证明「两者是同一版本号」，
不能证明「向量描述的就是当前内容」。实体 `updated_at` 由应用侧 `new Date()` 写入（毫秒分辨率），
**同一毫秒内的两次编辑内容不同、版本号却完全相同** ⇒ 内容 A 的旧向量仍被判成新鲜，能进 Top-K 占名额；
M3 还会拿它算 cosine，与内容 B 的当前结构事实混成「旧语义 + 新结构」的分数。评审要求补一条与 #328
同款的回归：旧向量的 `sourceUpdatedAt` 与编辑后的实体 `updatedAt` **完全相同**、文本不同时，
新 `EMBED_*` 跑完之前该候选必须进不了 semantic Top-K，新向量落库后才恢复。

### 修法：写路径按内容指纹失效（prune-on-write）

**主判据换成内容指纹，时间戳谓词降级为纵深防御。** 实体内容一变，写路径就在同一执行器里删掉该实体下
`content_hash` 与「当前内容指纹」不符的向量行（`packages/db/src/embedding-store.ts` 的
`pruneStaleEmbeddings(executor, { entity, contentHash })`）。这样「行还在」本身就等价于「它描述的是当前内容」，
与时间戳精度无关，也不取决于 worker 何时跑到 `EMBED_*`。

| 文件 | 改动 |
| --- | --- |
| `packages/db/src/embedding-store.ts` | 新增 `pruneStaleEmbeddings()`；候选新鲜度谓词的注释改写为「纵深防御，不是主判据」 |
| `apps/api/src/modules/listings/store.ts` | 新增 `invalidateStaleEmbeddingWith()`（select 当前 title/description/category → prune）；`enqueueListingJobsWith()` 执行器放宽到 `insert \| select \| delete` 并在投递前调用它（创建/编辑/审核通过/重投递四个入口，其中三个与实体写入同事务） |
| `apps/api/src/modules/wishes/match-queue.ts` | 新增 `invalidateStaleEmbedding()`；`enqueue()` 第一行调用（愿望的 `store.update` 不事务化，失效与 `EMBED_WISH` 投递同样在响应返回之前完成） |

**为什么不用时间戳做主判据**：同一毫秒内的两次编辑版本号相同（#328 已确立的边界），
`embeddings.test.ts` 新增的用例先断言「此时 Top-K 仍能召回它」把这条边界钉住，再证明 prune 之后立刻召回不了。

**为什么保留时间戳谓词**：它兜住「某个写路径忘了调 prune」的情形——那种情况下旧行的版本仍停在编辑前，
只要编辑落在不同毫秒就会被挡掉。**毫秒截断依旧必需**（实体 `updated_at` 是 `now()` 的微秒精度，
版本经 JS `Date` 往返后只剩毫秒，直接等值比较几乎永不成立）。

**被否决的替代方案**：
- 实体维护单调 `revision`：同样要给每个写路径加维护代码，忘了就 fail-open；而且 M3 已经证明
  「忘记维护」的失败模式正是本次 blocker，换成 revision 只是把同一个坑换了个字段。
- SQL 生成列 / SQL 侧重算 `content_hash`：必须在 SQL 里复刻 `buildListingEmbeddingText` /
  `buildWishEmbeddingText` 的 null 处理、空行省略与 `EMBEDDING_TEXT_FORMAT_VERSION` 规则 ⇒ 必然漂移。
- `xmin` 当版本号：冻结元组的 `xmin` 会塌成 `2`，旧版本与当前版本相等 ⇒ 不成立。

**只改价格这类编辑不误伤**：指纹一致的行一行不删，`EMBED_*` 照旧判 `unchanged`（§5 的
`refreshEmbeddingSourceVersion()` 仍负责把版本推进到实体当前值）。

### 回归证据

| 层 | 用例 | 钉住的行为 |
| --- | --- | --- |
| DB | `embeddings.test.ts`「同一毫秒内改了内容（版本号完全相同）也能让旧向量退出召回」 | 时间戳相等**不足以**证明新鲜（先召回得进来）→ prune 后立刻出局 → 落新指纹向量后恢复 |
| DB | `embeddings.test.ts`「只删内容对不上的行——指纹一致的行与别的实体一行不动」 | 指纹一致得 0 行；同一实体的多种模型旧行一起清；别的实体不受影响 |
| API | `listings/store.test.ts`「编辑内容后旧向量当场失效；只改价格不删向量」 | 编辑事务提交后 `findEmbedding` 即为 null；只改价格时向量原样保留 |
| API | `wishes/store.test.ts`「db match queue：投递前先让旧内容的向量行失效」 | `enqueue()` 返回时旧指纹行已消失；新指纹行不受影响 |
