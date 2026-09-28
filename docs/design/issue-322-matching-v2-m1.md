# #322 愿望匹配 v2 — 第一阶段（M1）：pgvector + embedding 基础与真实生成链路

> 状态：**代码已落地，待评审**。M1 只交付 embedding 基座（扩展 / 表 / provider / 文本指纹 / lifecycle）；
> **语义召回（M2）、Hybrid Ranking（M3）、backfill 与 live 验证（M4）均未开始**（见 §1、§11）。
> 关联：需求载体 [#322](https://github.com/zzstar101/FISH/issues/322)（OPEN）｜ v1 打分链 `apps/worker/src/jobs/matching/**`、`apps/api/src/modules/matching/**`
> 行号基线：`origin/main = 4f49325706b113e96063f12778b0fe4c5f40cabf`；实现分支 `feat/322-m1-embedding-foundation`；工作树 `D:\Program\FISH-wt-322-m1`
> 决策来源：Owner 在本次任务里逐条确认了 15 个设计分支（§2 逐条记录「用户选择」）

---

## 0. Owner 看这里

一句话：把「给商品/愿望生成并保存语义向量」这件事做成**可替换、可测、失败绝不落假向量**的基座，
并让创建/编辑路径**成对投递** `EMBED_*` job（与既有 `MATCH_*` 同事务、同入口），
但**一个字节都没有碰 v1 的候选 SQL、打分权重与 `matches` 语义**。

需要你本人知道的四件事：

1. **迁移里手动加了一条 `CREATE EXTENSION IF NOT EXISTS vector;`**（本分支新增迁移的开头）。
   drizzle-kit 0.31 没有 `CREATE EXTENSION` 的生成能力，`generate --custom` 只产 `.sql` + journal 条目、
   **不产 snapshot**，会直接踩红 `packages/db/src/migrations-journal.test.ts` 的「snapshot 数量 === journal 条目数」。
   因此按 `CONTRIBUTING.md` 第 8 节第 2 条的第二种例外处理，并把例外写进了根 `AGENTS.md` 与 `packages/db/AGENTS.md`（见 §9）。
2. **`EMBEDDING_TRANSPORT` 无默认值**：worker 启动期装配 provider，没配/配错**启动即失败**（与 `MAIL_TRANSPORT` / `AI_POLISH_TRANSPORT` / `CONTENT_MODERATION_TRANSPORT` 同款）。
   **已部署机器需要补一行 `EMBEDDING_TRANSPORT=...`**，否则 worker crash loop；`docs/deployment.md` 的追加脚本模式与 #141/#228 相同。
3. **`EMBED_*` 的唯一键只锁「待执行」那一行**（`status='PENDING'` 的部分唯一索引），
   与 `MATCH_WISH` 那条「一个愿望终身一条」刻意不同——否则编辑过内容后再也不会重新生成。
   这条差异是 M1 的核心修正之一（§4、§7）。
4. **M2 必须显式定义「向量未就绪 / 已过期」时怎么办**（降级成 lexical-only 还是等待重排）。
   M1 只保证：缺失向量不会产生伪匹配（`EMBED_*` 失败不写库、v1 打分链完全不受影响）。

本期刻意的「不做」是决定，不是遗漏：ANN/HNSW 索引、cosine Top-K 召回、hybrid 权重与阈值、
`acceptSimilar` 语义、backfill 脚本、真实 live 网络调用（§1、§11）。

---

## 1. 目标与非目标

### 目标（M1）

- **pgvector 可用**：正式 `CREATE EXTENSION IF NOT EXISTS vector`；`embeddings` 表用 `vector(1536)` 定长列。
- **单表 + 单一实体归属**：`embeddings` 同时承载 listing / wish，`CHECK` 保证「必须且只能属于一个实体」，FK `ON DELETE CASCADE` 保证删父实体不留孤儿。
- **provider 可替换**：`EmbeddingProvider` 接口不进任何 SDK；至少 deterministic test provider + live provider。
- **文本构造与内容指纹**：纯函数、单点构造、deterministic 单测；内容不变不重复生成。
- **真实生成链路**：新增 `EMBED_LISTING`/`EMBED_WISH` job + worker handler；API 创建/编辑路径**同事务只写 job 行**，网络调用绝不落在 DB transaction 或行锁内。
- **失败语义收敛**：超时 / 非 2xx / 非法响应 / 维度不符一律**类型化错误 fail-closed**，绝不产生「空向量 = 正常匹配」。

### 非目标（附理由）

| 不做 | 理由 |
| --- | --- |
| ANN / HNSW / IVFFlat 索引 | Issue 明确要求「第一版按真实数据量 + EXPLAIN 决定」；M1 没有召回查询，先建索引等于用 pgvector 而用 pgvector |
| cosine Top-K 候选召回 | M2 的范围（含 existing matches 的 union） |
| Hybrid Ranking、semantic 权重、阈值冻结 | M3 的范围；本阶段**不碰** `WEIGHTS`、`MATCH_SCORE_THRESHOLD` |
| `acceptSimilar` 真实语义 | M3 的范围；v1 仍是无效字段（在 §11 显式登记） |
| backfill / 换模型重建 / 速率上限 | M4 的范围 |
| 真实 live 供应商调用与密钥 | M1 只保证 live 实现存在且以假 fetch 全覆盖；真实出网 smoke 属 M4 |
| 修 `jobs_match_wish_wish_id_uidx` 的「终身一条」缺口 | 影响 v1 语义，另开 follow-up（§11） |

---

## 2. 交付范围与决策（Owner 逐条确认）

| # | 决策 | 用户选择 | 理由 |
| --- | --- | --- | --- |
| Q1 | M1 边界 | A：基座 + **真实生成链路** | 只做表不做链路无法验收 lifecycle；不碰 scoring/engine 让 M1 可独立评审 |
| Q2 | job 方案 | A：独立 `EMBED_*` job | 失败/重试面与匹配解耦；M1 能在不碰 v1 打分的前提下验收 |
| Q3 | 去重键 | A：payload 只带实体 id + `(payload->>'id') WHERE type='EMBED_*' AND status='PENDING'` 部分唯一索引；handler 运行时重读实体比对 `content_hash` | 照抄 MATCH 的实体终身唯一会让编辑后重算静默失效；运行时重读使「旧 job 晚到」结构性不可能覆盖新内容 |
| Q4 | 表形状 | A：单表 `embeddings` + 双可空 FK + `CHECK` + `(entity, model)` 部分唯一 | CASCADE 是机械的「删父实体即清孤儿」；唯一键含 model ⇒ 读侧必须显式带 model，不静默混用 |
| Q5 | 维度 | A：迁移写 `vector(1536)` + 常量 `EMBEDDING_DIMENSIONS` 放 db schema + 写前校验 provider 维度 | 三处一致（迁移 typmod / 常量 / provider）由测试钉住 |
| Q6 | 扩展落点 | A：追加在本分支新增迁移 `.sql` 开头 + 改两处 AGENTS 开例外 | 见 §0.1、§9 |
| Q7 | 契约落点 | A：`packages/contracts/src/embedding/{jobs,provider,text}.ts` | worker 与 M4 backfill 共用；维度常量归 db |
| Q8 | env | A：`EMBEDDING_TRANSPORT`（`stub`/`live`，无默认值）**只被 worker 读**；live 三项齐全 | 与既有 transport 范式一致，密钥不扩散到不需要它的进程 |
| Q9 | provider 调用 | A：单次调用 + `AbortSignal.timeout(10_000)` + **不重试**；重试交给队列 3 次有界重试 | 队列已有 `DEFAULT_MAX_ATTEMPTS = 3`；重试时 handler 会重新读实体，不会用旧文本重算 |
| Q10 | 文本/指纹函数位置 | A：`packages/contracts/src/embedding/text.ts` 纯函数 | worker 与 M4 backfill 共用同一份规范 |
| Q11 | 指纹 | A：`sha256(f"{EMBEDDING_TEXT_FORMAT_VERSION}:{规范化文本}")`，**不含** model/dimensions | 换模型由 `(entity, model)` 唯一键与读侧 model 参数表达；指纹只回答「内容有没有变」 |
| Q12 | 入队点 | B：**复用现有 MATCH 钩子**（listings store / governance / moderation / wishes match-queue 成对投递），并补 `updateWish` 的投递缺口 | 少一处新入口就少一处必漏；`updateWish` 此前一行 job 都不投 |
| Q13 | `MATCH_WISH` 终身唯一缺口 | A：M1 不修，写进 PR 说明 + follow-up | 属 v1 语义变更，不在 M1 范围 |
| Q14 | worktree / PR | A：独立 worktree + 单 PR + 本设计文档 + CONTRIBUTING §6 的 DB 变更说明 | 主 checkout 占着他人分支，不能切 |
| Q15 | 开工 | 用户答「开工，按共识实现 M1」 | — |

---

## 3. DB 变更说明（CONTRIBUTING 第 6 节）

```text
DB 变更说明
- 表/实体：新增 embeddings（语义向量存放；listing / wish 共用一张表）。
- 新增/修改的字段与类型：
  * embeddings.id uuid PK（uuidv7 默认）
  * embeddings.listing_id uuid NULL REFERENCES listings(id) ON DELETE CASCADE
  * embeddings.wish_id    uuid NULL REFERENCES wishes(id)   ON DELETE CASCADE
  * embeddings.model text NOT NULL（生成该向量的模型标识，读侧必须显式带 model）
  * embeddings.dimensions integer NOT NULL（并 CHECK dimensions = 1536）
  * embeddings.content_hash text NOT NULL（sha256(文本格式版本:规范化文本)）
  * embeddings.embedding vector(1536) NOT NULL（pgvector 定长列，typmod 由扩展保证）
  * embeddings.created_at / updated_at timestamptz NOT NULL DEFAULT now()
  * 既有表 jobs：仅新增两条**部分唯一索引**，列与约束不变
    - jobs_embed_listing_listing_id_uidx ON ((payload->>'listingId')) WHERE type='EMBED_LISTING' AND status='PENDING'
    - jobs_embed_wish_wish_id_uidx       ON ((payload->>'wishId'))    WHERE type='EMBED_WISH'    AND status='PENDING'
- 使用场景（对应 Issue）：#322 M1 —— 愿望/商品语义向量的生成、存放与失效；M2 在此表上做 cosine Top-K。
- 是否影响已有数据：不影响。新表为空；两条索引是新增约束，只要求「同实体同类型的待跑 job 不重复」。
  迁移同时执行 CREATE EXTENSION IF NOT EXISTS vector（pgvector 0.8.6，镜像 pgvector/pgvector:pg18 自带）。
- 迁移文件：packages/db/src/migrations/20260928163726_jittery_ink.sql（generate 产出 + 文件开头一条手加 CREATE EXTENSION，见 §9）
```

---

## 4. 数据模型

### `embeddings`（`packages/db/src/schema/embeddings.ts`）

- `EMBEDDING_DIMENSIONS = 1536` 是**唯一常量**：迁移 `vector(1536)`、表 CHECK、provider 校验三处都指向它，
  测试 `packages/db/src/embeddings.test.ts` 直接断言 `format_type(atttypid, atttypmod) === 'vector(1536)'`（改常量不重生成迁移即红）。
- 唯一键 `(listing_id, model) WHERE listing_id IS NOT NULL` / `(wish_id, model) WHERE wish_id IS NOT NULL`：
  **同一实体允许新旧模型并存**（换模型期间不覆盖旧向量），但读侧必须 `findEmbedding(db, entity, model)` 显式带 model。
- `CHECK ((listing_id IS NULL) <> (wish_id IS NULL))`：必须且只能属于一个实体。
- 两条 FK `ON DELETE CASCADE`：删 listing / wish 时向量随之消失，不需要清理任务。

### `jobs`（`packages/db/src/schema/jobs.ts`）

```ts
export type JobType = 'MATCH_LISTING' | 'MATCH_WISH' | 'EMBED_LISTING' | 'EMBED_WISH'
```

两条新的部分唯一索引见 §3。与 `jobs_match_wish_wish_id_uidx`（谓词只有 `type='MATCH_WISH'`，**不含 status**）
的关键差别：`EMBED_*` 只锁「待执行」，任务跑完之后再次编辑会真正插入新 job。
（`jobs_match_wish_wish_id_uidx` 的「终身一条」是 v1 既有缺口，见 §11。）

---

## 5. 文本构造与内容指纹（`packages/contracts/src/embedding/text.ts`）

- `EMBEDDING_TEXT_FORMAT_VERSION = 1`，参与指纹计算；改文本规范必须递增它，否则旧指纹会被误判成「内容没变」。
- 规范化（`normalizeValue`）：`\r\n?` → `\n`，两端 `trim`，空串与 `null` 等价。
- `compose(fields)`：**空值整行省略**（不写 `描述: ` 这种半截行），不做大小写折叠、不做中英标点归一。
- Listing 文本：`标题: <title>\n描述: <description>\n分类: <category>`
- Wish 文本：`需求: <keyword>\n描述: <description>\n分类: <category 或 不限>`
- `contentHashOf(text) = sha256(f"{EMBEDDING_TEXT_FORMAT_VERSION}:{text}")`（`Bun.CryptoHasher`，64 位 hex）。
  **不含 model/dimensions**：换模型靠 `(entity, model)` 与读侧 model 参数表达，不靠指纹。

---

## 6. Provider 契约与 env

```ts
export interface EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  embed(texts: string[]): Promise<number[][]>
}
export type EmbeddingFailureReason =
  | 'timeout' | 'network' | 'http_status' | 'invalid_response' | 'dimension_mismatch'
export class EmbeddingProviderError extends Error { readonly reason: EmbeddingFailureReason }
```

- **stub**（`EMBEDDING_TRANSPORT=stub`，进程内确定性）：`STUB_EMBEDDING_MODEL = 'stub-deterministic-v1'`，
  按词元 sha256 投到固定维度并做 L2 归一化；**全空白文本给固定方向而不是零向量**（零向量余弦无定义）。
  `stub` 在 `NODE_ENV=production`（trim + 小写归一）时**启动即失败**，避免假向量产生看似合理的召回。
- **live**（`EMBEDDING_TRANSPORT=live`，需 `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` 三项齐全）：
  `POST {baseUrl 去尾斜杠}/embeddings`，body `{ model, input }`，`AbortSignal.timeout(EMBEDDING_TIMEOUT_MS = 10_000)`，
  **不重试**；错误消息不含请求文本、也不搬运上游响应体（响应体可能回显用户原文）。
- env loader `loadEmbeddingEnv()` 在 `packages/shared/src/env.ts`，**只被 worker 读取**：
  transport 缺失/非法一律抛错（`必须显式设置`），live 缺项逐项点名，错误只报变量名不回显密钥值。
- 维度护栏三处：provider 声明 `dimensions !== EMBEDDING_DIMENSIONS` → 立即失败；返回向量长度不符 → `dimension_mismatch`；
  非有限数值 → 拒绝写入；DB 层还有 `vector(1536)` typmod 与 `dimensions` CHECK 兜底。

---

## 7. Job 方案 A：embedding lifecycle

- 新增 `EMBED_LISTING` / `EMBED_WISH`（`packages/contracts/src/embedding/jobs.ts`，payload `strictObject` 只带实体 id）。
- worker 侧 `createEmbedJobHandlers(db, provider)`（`apps/worker/src/jobs/embedding/handlers.ts`）：
  1. `safeParse` 失败 → `InvalidJobPayloadError`（FATAL，不重试）。该类已从 matching 域提到 `apps/worker/src/jobs/invalid-payload-error.ts` 共用。
  2. **运行时重读实体**（listing 读 `title/description/category`，wish 读 `keyword/description/category`）；查不到 → `status: 'missing'`（job 正常 DONE，重试无意义）。
  3. 构文本 + `contentHashOf`；`findEmbedding(entity, model)` 命中且 `contentHash` 相同且 `dimensions` 一致 → `unchanged`，**不调用 provider**（内容不变不重复计费）。
  4. 否则 `provider.embed([text])` → `saveEmbedding`（`(entity, model)` upsert）→ `generated`。
- provider 抛错时不写库：**旧向量原样保留**（不会先删后写），因此匹配侧在重算失败时仍有可用向量。
- **「旧 job 晚到不能覆盖新 embedding」是结构性满足的**：job payload 不带文本、也不带指纹，
  handler 永远读当前内容；写入按 `(entity, model)` 覆盖，不存在「旧向量盖新向量」的窗口。
- 队列语义沿用既有 `createJobQueue`：`DEFAULT_MAX_ATTEMPTS = 3`、无退避、`isFatalError` 只认坏 payload。

---

## 8. 入队点（API，全部与对应写入同事务或紧随其后）

| 位置 | 变化 |
| --- | --- |
| `apps/api/src/modules/listings/store.ts` | helper 更名 `enqueueMatchJobWith` → `enqueueListingJobsWith`：先插 `MATCH_LISTING`（原样），再插 `EMBED_LISTING`（`.onConflictDoNothing()`）。4 处引用（create 仅 APPROVED / 公共 `enqueueMatchJob` / update / setStatus）全部走它 |
| `apps/api/src/modules/governance/service.ts` | 同款更名 `enqueueMatchJob` → `enqueueListingJobs`（下架 / 恢复 ACTIVE 两处调用点）：审核通过是商品进入匹配链路的入口，缺 `EMBED_LISTING` 会让 M2 对审核通过的商品失效 |
| `apps/api/src/modules/moderation/store.ts` | 人工放行路径在 `tx.insert(jobs)` 的 `MATCH_LISTING` 之后补 `EMBED_LISTING` + `.onConflictDoNothing()` |
| `apps/api/src/modules/wishes/match-queue.ts` | `enqueue` 在 `MATCH_WISH` 之后追加 `INSERT ... 'EMBED_WISH' ... ::text::jsonb ON CONFLICT DO NOTHING`（保留两段转型，否则 jsonb 二次编码会让 `payload->>'wishId'` 恒 NULL） |
| `apps/api/src/modules/wishes/service.ts` | `updateWish` 在 `store.update` 成功、`invalidatePoolCache()` 之后新增 `await matchQueue.enqueue(id)`：**此前编辑愿望不投递任何 job**（既不重算也不刷新向量）。投递不假装原子（wish store 的 update 本身非事务化），注释已写明 |

---

## 9. pgvector 扩展的引导语句与例外

- 迁移 `packages/db/src/migrations/20260928163726_jittery_ink.sql` 的**最前面**手加：

```sql
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
```

  必须放在最前：`CREATE TABLE ... vector(1536)` 依赖该类型。
- 例外边界（已写进根 `AGENTS.md` 第 8 节与 `packages/db/AGENTS.md`）：**只允许追加这一条引导语句，生成器产出的其它语句一个字节不改**；
  rebase 到新 main 后按既有规则把本分支迁移交回生成器重建，再重新加回这一条。
- 不建 ANN 索引：`packages/db/AGENTS.md` 已登记「第一版不建，M2 用真实数据量 + `explain (analyze)` 决定」，
  并附实测事实：裸 `vector`（无 typmod）**不校验维度**、在其上建 HNSW 会报 `ERROR: column does not have dimensions`。
- 运维注意：两条部分唯一索引会拒绝「同实体同类型的多条待跑 job」。
  全新库 / 干净环境无影响；若某环境在本迁移之前就手工插过重复的 `EMBED_*` job，需要先清理再迁移（本例本机就是这么处理的）。

---

## 10. 验收清单映射（M1 相关条目 → 证据）

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| extension 可用 | ✅ | `embeddings.test.ts`：`pg_extension.extname='vector'` 恰 1 行；本机实测 `0.8.6` |
| embedding 正确写入 / 读取 | ✅ | `embeddings.test.ts` 往返（含 dimensions/contentHash/vector 全等）；`findEmbedding` 换 model 读不到 |
| model / dimension 不兼容明确失败 | ✅ | 错维 `'[1,2,3]'::vector` → `expected 1536 dimensions`；`dimensions=768` → `embeddings_dimensions_matches_column`；provider 声明 768 维 / 返回错维 / NaN 各自拒绝 |
| cosine Top-K 顺序有固定 fixture | ✅（语义钉住，召回属 M2） | `embeddings.test.ts` 用 `<=>` 断言顺序 `[near, middle, far]` 与距离 `0 / 0.2929 / 1` |
| 删除父实体不留孤儿 embedding | ✅ | CASCADE 测试（删 listing / wish 后 0 行） |
| create 生成 embedding | ✅ | `handlers.test.ts` 首次 `generated` + 指纹 == `contentHashOf(build*EmbeddingText(...))`；API 侧 `app.wishes.test.ts` 断言创建愿望投 `MATCH_WISH`+`EMBED_WISH`、`listings/store.test.ts` 断言投 `MATCH_LISTING`+`EMBED_LISTING` |
| 内容改动失效并重算 | ✅ | 改 title/description（listing）与改 keyword（wish）后 `generated` 且指纹变化；同一实体仍只有 1 行 |
| 内容不变不重复生成 | ✅ | 第二次 `unchanged` 且 provider 调用次数 `=== 1` |
| 旧 job 晚到不能覆盖新 embedding | ✅（结构性） | handler 运行时重读实体 + `(entity, model)` upsert；测试覆盖「编辑后重算覆盖同一行」 |
| provider timeout/5xx 不产生伪匹配 | ✅ | 失败抛类型化错误且 `embeddings` 0 行；重算失败时旧向量 `toEqual(before)` 原样保留；live provider 单测覆盖 `http_status` / `timeout` / `network` / `invalid_response` / `dimension_mismatch`，且断言**不重试** |
| `bun run typecheck` | ✅ | 全包 exit 0 |
| `bun run lint` | ✅ | `biome check .`：909 文件 0 错误 |
| `bun test --isolate` | ✅ | 全量回归 **1968 通过 / 0 失败**（211 个文件，含本轮新增的 4 个测试文件与 4 处既有断言更新） |
| Worker + API 真实 DB 集成测试 | ✅ | `apps/worker/src/jobs/embedding/**`、`apps/api/src/app.wishes.test.ts`、`apps/api/src/modules/listings/store.test.ts`、`packages/db/src/embeddings.test.ts` 全绿 |
| core smoke 覆盖语义匹配链 | ➖ | M1 不涉及召回/排序，语义链属 M2/M3；本阶段未改 core smoke |
| production embedding provider 最小 live smoke | ➖ | M1 只保证 live 实现存在 + 假 fetch 全覆盖；真实出网属 M4 |

---

## 11. 交给 M2/M3/M4 的契约与未决项

1. **「向量未就绪 / 已过期」策略（M2 的硬前置）**：`EMBED_*` 可能晚于 `MATCH_*` 执行（队列按 `run_at, id` 领取、重试无退避）。
   M2 必须在两处显式定义：候选召回时向量缺失 / `model` 不匹配 / `content_hash` 与实体当前内容不一致时，是**降级为 lexical-only 继续打分**还是**等待重排**。
   无论选哪种，都要保证「缺失向量 ≠ 伪匹配」这条 M1 的性质不被破坏。
2. **ANN 索引决策（M2）**：第一版允许 exact cosine scan；上 HNSW 必须带索引参数理由 + Top-K recall/latency 对照 + 无索引/有索引 `explain (analyze)`。
3. **`acceptSimilar` 仍是无效字段（M3）**：M1 未触碰其语义，Issue 要求 M3 冻结（`false` 更严格、`true` 允许近似品牌/型号/同用途）。
4. **`jobs_match_wish_wish_id_uidx` 的「终身一条」缺口（follow-up，M1 未修）**：
   该索引谓词不含 status ⇒ 一个愿望终身最多一条 `MATCH_WISH` job（连「投递失败后重投」都做不到）。
   `EMBED_WISH` 刻意没有沿用这一点。修它属 v1 语义变更，需要单独 Issue。
5. **`EMBED_*` 连续 3 次失败后无补投**：job 置 `FAILED` 后，若没有新的编辑就不会再排一条。
   M2 的「缺失即降级」契约必须能容忍这种状态（或由一个 backfill/巡检任务兜底）。
6. **文本规范版本化**：改 `EMBEDDING_TEXT_FORMAT_VERSION` 或换 model 时，`embeddings` 里会有「旧规范/旧模型」的向量混存；
   读侧必须按 `model` 过滤（M2/M4 的重建流程负责收敛），不允许「取任意一行」。
7. **换维度意味着 ALTER + 重建**：`EMBEDDING_DIMENSIONS` 与迁移 typmod 绑定，不同时改会直接被 DB 拒绝（这是有意的）。

---

## 12. 本地验证命令

```bash
bun run db:up && bun run db:migrate     # 首次需要：装上扩展 + 建表 + 两条部分唯一索引
bun run typecheck
bun run lint
bun test --isolate
```

集成测试需要 `.env` 里的 `DATABASE_URL`，以及 `.github/workflows/ci.yml` 顶层 env 那组 transport 选择
（`MEETUP_TOKEN_SECRET`、`AI_POLISH_TRANSPORT=stub`、`WECHAT_TRANSPORT=off`、`CONTENT_MODERATION_TRANSPORT=local`、
`EMBEDDING_TRANSPORT=stub`）。缺任一项都会由各自的 loader 直接报错，不会静默回退。
