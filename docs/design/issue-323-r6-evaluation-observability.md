# Issue #323 R6：评估与可观测性（Evaluation / Observability）设计

状态：**设计已定稿，且实现已合入 main**——Q1–Q11 决策（§2.1）与四处细化（§2.4）均已获 Owner 确认；
§9 的两个 PR 边界（读面 / 写面）与 §10.4 的收口项均已落地，见下方「实现落地」。
本文档保留设计时点的口径描述（「做什么、口径是什么、怎么验」），不含实现代码。

实现落地（`origin/main = 58a9e5f13db47df9cbe3b706aa2e827bbf905aa4`，2026-10-05 15:28:40 +0800 核对）：

- **读面（§9 PR-1）**：`f85cd882` `feat(recommendation): 补齐离线评估与线上可观测（#323 R6）`
  —— PR #436（merge `1819fd484b15508bf3271222d90378f6dad76b2e`，2026-10-03）。新增
  `packages/contracts/src/recommendation/{eval,observability}.ts`、
  `packages/contracts/src/admin/recommendation-metrics.ts`、
  `apps/worker/src/jobs/recommendation/{eval,eval-fixture,store,cleanup}.ts`、
  `apps/worker/scripts/rank-eval.ts`、`apps/api/src/observability/{latency,recommendation-metrics}.ts`，
  端点 `apps/api/src/modules/admin/router.ts:228` 的 `router.get('/recommendations/metrics', …)`。
- **写面（§9 PR-2）**：清理 job 已由 `apps/worker/src/index.ts:2,:14`
  （`RECOMMENDATION_CLEANUP_INTERVAL_MS` / `cleanupExpiredRecommendationData`）注册定时调度，
  CLI 为 `apps/worker/scripts/recommendation-cleanup.ts`；限流与 bot 隔离见
  `apps/api/src/modules/recommendation/`。
- **收口（M6 冷却 / M8 线上生命周期指标）**：`95f7c74f` `feat(recommendation): 补 M6 冷却与 M8 线上生命周期指标`
  —— PR #458（merge `c15f69e95f28532f7d11175ff0c4b63a928eab9f`，2026-10-05）。改
  `packages/contracts/src/admin/recommendation-metrics.ts`、
  `packages/contracts/src/recommendation/{rank,schema}.ts`、
  `apps/api/src/modules/admin/{router,store,service}.ts`，新增
  `apps/api/src/modules/recommendation/rank/cooldown.ts`、`packages/db/src/recall-store.ts`。
- **前置依赖**：R4/R5 由 `e4dac97d` 落地（PR #407，merge `23ed2152fb7e831258c81dc680297a9bdd3c543e`，
  2026-10-03），即下一节所假设的快照表与复合策略版本串已可用。

> 注：`apps/worker/scripts/obs-summary.ts` **不是** R6 产物 —— 它由 #322 M4（`d821716e`）创建，
> 只读聚合 `embeddings` / `matches` / `jobs`，与本文的推荐指标无关。

依赖（必须知道，否则本文的查询无法成立）：本文假设 **#323 R4/R5（PR #407，分支
`feat/323-r45-personalized-feed`）已合入 main**。文中引用的

- `recommendation_request_items`（服务端快照表，含 `position` / `primary_source` / `sources` /
  `rank_score` / `rank_breakdown`，≤200 行/请求，保留 90 天）、
- 复合策略版本串 `rec-v1-rule+interest-v1+recall-v1+rank-v1`（`composeRecommendationStrategyVersion`）、
- 「`position` / `source` 的真值来自快照、客户端上报被忽略」的归因规则、
- `docs/design/issue-323-r45-ranking-and-feed.md`

全部来自该 PR。它合入前，本文 §5 / §6 描述的查询没有可用的表；R1 时代的
`recommendation_requests` / `recommendation_events`（保留期 180/90 天、`position` 由客户端自述）
在 main 上是可用的，但不足以支撑本文的指标口径。

落点惯例（与仓库一致）：契约进 `packages/contracts/src/**`（subpath exports，无 barrel）；
SQL 读路径进各 domain 的 `store.ts`；离线/运维脚本进 `apps/worker/scripts/`（先例
`apps/worker/scripts/rank-compare.ts`）；定时任务进 `apps/worker/src/jobs/**`。

---

## 1 范围

R6 = Issue #323 的 Evaluation / Observability 阶段。**只做**六类此前明确「归 R6」的债：

| # | 债 | 出处 | 本轮交付 |
|---|---|---|---|
| 1 | 离线评估指标：Recall@K / MRR / NDCG / coverage / category diversity / seller coverage / fresh item exposure / repeated exposure rate | #323 §M8 | 回放式 CLI（§5） |
| 2 | 线上漏斗：impression→detail→favorite→chat→transaction→completed；首次发布→首次有效意向；成交前曝光量；新商品首次曝光时间；seller exposure concentration | #323 §M8 | admin 聚合端点 + 离线 CLI 的商品侧口径（§6.2 / §5.5） |
| 3 | Guardrail：API latency、pgvector latency、feed empty rate、推荐重复率、单 seller 曝光占比、SOLD/RESERVED 陈旧曝光、event write failure rate | #323 §M8 | admin 聚合端点（§6.3） |
| 4 | 保留期清理 job（事件 180 天 / 请求上下文 + 快照 90 天） | `docs/design/issue-323-r1-event-tracking.md:135`「R1 不含任何自动删除」 | worker 定时 job + CLI（§7） |
| 5 | 埋点写入限流（`POST /recommendations/events` 匿名可写、零限流） | 同上 `:138` | 进程内令牌桶 + 429（§8.1） |
| 6 | Bot / 开发预览隔离 | 同上 `:136-137` | 复用 R4/R5 的归因硬约束 + 限流 + 拒绝原因计数（§8.2） |

另外三处散落在 R3/R4-R5 文档里「归 R6」的项，本轮只**记录**、不改行为（写进 §11）：
单路召回超时（`docs/design/issue-323-r3-multi-channel-recall.md:146-147`）、popular 通道的缓存/物化取舍
（同文）、`RecallDegradeReason` 增加「空 vs 错」枚举以做通道分账（同文 `:150`）、探索哈希分布检验、
排序权重调参（`docs/design/issue-323-r45-ranking-and-feed.md` §11 第 9 条：`semantic 0.35` 等是初值）、
`rerank` 的 relaxations 计数接指标（同文 §7.6 第 5 条，`:692-696`）。

**明确不做**（与 #323「明确不做」一致，且是本轮多条决定的前提）：

- 不引入 Prometheus / OpenTelemetry / `/metrics` 端点，不引入任何指标后端或新依赖；
- 不建物化聚合表、不做定时预聚合；
- **不动 DB 结构**（零 schema 变更：无新表、无新列、无新索引、无迁移）；
- 不做在线训练 / DNN / LLM 在线打分，不做实验平台与 A/B 分流；
- 不改客户端（沿用 R4/R5 的 D9「客户端零改动」）；不改确定性 Listing Feed（`GET /listings`）；
- 不把推荐指标混进搜索排序，不落任何用户标识（手机号 / 邮箱 / 学号 / 微信标识）。

---

## 2 写进实现的决定

### 2.1 与 Owner 逐条确认的决策（Q1–Q11）

| # | 问题 | 决定 | 理由（摘要） |
|---|---|---|---|
| D1 | 本轮交付物 | **只写本文档**；实现等 #407 合入 main 后从 main 开分支（**已按此执行**：见文首「实现落地」，读面 PR #436、写面与收口 PR #458） | R6 依赖 R4/R5 的快照表；绑在未合并分支上会让 R6 的 PR 携带整份 R4/R5 的 diff |
| D2 | 文档粒度 | 六类债写进**一份**文档，实现拆 PR | 六类共享同一套数据来源与口径，拆文档会让「窗口 / 归因 / 保留期」三处定义各自漂移 |
| D3 | 落地形态 | 分层：离线评估 = CLI；线上漏斗 + guardrail = admin 只读端点 | 仓库零指标基础设施（无 `/metrics`、无 Prometheus/OTel）；`apps/worker/scripts/rank-compare.ts` 是 fixture CLI 先例，`GET /admin/overview` 是计数型聚合先例；引指标后端与「最小改动」相背 |
| D4 | 离线评估输入 | **纯回放**已落库数据（`recommendation_requests` + `recommendation_request_items` + `recommendation_events`） | 快照表已含 `position` / `primary_source` / `sources` / `rank_score` / `rank_breakdown`，通道分账靠 `primary_source`/`sources` 就够；新增通道候选持久化会让每请求写入量翻几十倍并多一份保留期 |
| D5 | schema 尺度 | **零 schema 变更** | 延迟 = 进程内环形直方图；限流 = 进程内令牌桶；清理复用现有 `requested_at` / `occurred_at` 索引；bot = 归因硬约束 + 频率启发式。任何新表都要新迁移 + 新保留期 + 写入放大 |
| D6 | 相关性分级 | 三级：`PURCHASE` / `TRANSACTION_START` = 3，`CHAT_START` / `COMMENT` / `FAVORITE` = 2，`DETAIL_VIEW` = 1；`QUICK_SKIP` / `HIDE` / `UNFAVORITE` 从相关集**剔除**（不算负分） | 二值分级分不出「点了」与「买了」；只用最强信号则样本极稀疏（小体量下没有统计意义）。分级写成契约常量，可调且可被文档引用 |
| D7 | 评估协议 | 请求级 + **归因窗 `W` = 请求后 30 分钟**（固化契约常量，**不可** CLI 调）+ 评估/回放窗默认 7 天（`--window` 可调）+ K 报 5/10/20 + **首次曝光归因** | 同一商品会反复出现在多次请求的快照里；不归因到「最早把它放进快照的那次请求」，recall 会随快照重叠虚高、不能跨日比。`W` 刻意不给 CLI 旗标：改了它历史数据就不再可比，只能整段重算（见 §4.3） |
| D8 | 线上出口 | 单一 `GET /admin/recommendations/metrics?window=24h\|7d\|30d`，响应分 `funnel` / `guardrails` / `latency` 三块 | 与 `GET /admin/overview` 同族（扁平计数卡片、口径写进契约注释）；拆三个端点会让口径重复、契约变三份 |
| D9 | 保留期清理 | worker 定时 job（间隔 1h）+ 批量 LIMIT 循环 + `--once` / `--dry-run` CLI | 复用 `apps/worker/src/index.ts` 的 `VISUAL_MAINTENANCE_INTERVAL_MS` 与 `jobs/visual-embedding/cleanup.ts` 先例；只写 CLI 会「忘了跑就无限增长」 |
| D10 | 埋点限流 | 进程内令牌桶、身份维度、容量 120 / 补充 2·s⁻¹、超限 429 + `Retry-After`、LRU 上限 1 万身份、阈值可配、登录用户同样受限 | 每个事件批在 202 高频路径上多一次 DB 往返（auth 的滚动窗口范式）得不偿失；见 §8.1 对「键」的一处细化 |
| D11 | PR 切法 | **两个 PR**：PR-1 读面（离线评估 CLI + admin 聚合端点 + 延迟直方图 + 契约）；PR-2 写面（限流 + bot/开发预览隔离 + 保留期清理 job） | 读面零线上行为变化、可先合；写面会拒绝请求、会删数据，风险更高，单独审 |

### 2.2 由上述决定直接推出、不再单独提问的条款

- **N1 bot 命中只能「丢弃写入 + 计数」**：D5 禁止新列，所以没有「标记可疑行」的落点。判定命中的批
  直接不写、并把原因计进进程内计数器（§8.2）。
- **N2 延迟直方图是单进程口径**：进程重启清零、多实例各自为政。契约字段名与注释必须写明
  「自本进程启动以来」，不能让读的人误以为是全局值（§6.4）。
- **N3 fixture 模式进 CI**：离线评估 CLI 的 `--fixture` 不需要 `DATABASE_URL`（与 `rank:compare` 同族），
  因此可以进 CI；真实回放需要 DB，只在本地/运维跑（§5.1）。
- **N4 CLI 输出双格式**：默认 Markdown 表（人读），`--json` 供脚本消费（§5.2）。
- **N5 商品侧生命周期指标（首次发布→首次有效意向 / 成交前曝光量 / 新商品首次曝光时间）放离线 CLI**，
  不进 admin 端点：它们要对 `listings` 做全表性质的连接与分组，端点必须保持在「按窗口 + 索引扫描」的
  量级（§5.5 / §6.1）。

### 2.3 对 D10 的一处细化（**已确认**，见 §2.4）

D10 的表述是「键 = 登录 `userId` / 匿名 `anonymousSessionId`」。实现前必须改掉匿名侧的键，理由在仓库里
已有明确先例：

- `apps/api/src/modules/auth/router.ts:81` 的注释写着「不用 `x-forwarded-for` 之类可伪造的请求头，
  否则限流形同虚设」；
- 匿名限流的既有实现（`apps/api/src/modules/visual-search/subject.ts`）对匿名主体用**两条**额度：
  会话标识的 HMAC + **可信出口 IP** 的 HMAC，IP 无法归因时落到共享兜底桶（fail-closed，
  `UNATTRIBUTED_IP_SUBJECT`）。

事件体里的 `anonymousSessionId` 是客户端自述（`packages/contracts/src/recommendation/schema.ts` 的
`RecommendationEventInputSchema`），换一个 UUID 就是新身份 ⇒ 只按它限流等于没有限流。

因此细化为：**键 = 登录用户 `user:<userId>`；匿名同时过 `session:<anonymousSessionId>` 与
`ip:<trustedClientIp>` 两条桶，IP 无法归因时过共享 `unattributed` 桶**（§8.1）。IP 只作为进程内 Map 的
键存在，**不落库、不进日志**，与 R1「不落 IP」的承诺不冲突。

**定稿（Owner 已确认）**：采用带 IP 维度的方案。只按会话标识限流的替代方案改动更小，但会把
「轮换会话即可绕过限流」变成真实边界——那等于没限流，所以不采纳（§11 第 7 条记的是 IP 无法归因时的
兜底桶行为，不是这个替代方案）。

### 2.4 定稿时确认的四处细化（Owner 已确认：全按文档默认）

1. **§2.3 匿名限流键加可信 IP 维度**（D10 的细化）；
2. **§5.3 的 0/0 口径**：无任何正向信号的请求不进 Recall/MRR/NDCG 分母，单列
   `requestsWithoutPositiveSignal`（D7 的细化）；
3. **§8.1 给 `GET /recommendations/feed` 也加一份更宽的桶**（D10 之外的配套默认）；
4. **§7.1 把 worker 的单个 `lastMaintenanceAt` 换成 `SCHEDULES` 小表**（D9 的实现形态）。

---

## 3 契约与常量

### 3.1 新增 `packages/contracts/src/recommendation/eval.ts`

```ts
/** 相关性分级（D6）。写成常量而不是散在脚本里：换权重就是换指标定义，必须显式。 */
export const RANK_EVAL_RELEVANCE_GRADES = {
  PURCHASE: 3,
  TRANSACTION_START: 3,
  CHAT_START: 2,
  COMMENT: 2,
  FAVORITE: 2,
  DETAIL_VIEW: 1,
} as const

/** 命中这些事件就把商品从相关集里剔除（不是负分：NDCG 的分级增益不支持负值）。 */
export const RANK_EVAL_NEGATIVE_EVENT_TYPES = ['QUICK_SKIP', 'HIDE', 'UNFAVORITE'] as const

/** 同时报三档 K：5 是一屏内、10 是首屏、20 是默认页大小（RECOMMENDATION_FEED_QUERY 默认 limit=20）。 */
export const RANK_EVAL_K_VALUES = [5, 10, 20] as const

/** 观察窗默认 7 天（D7）。上界受快照保留期（90 天）与事件保留期（180 天）双重限制。 */
export const RANK_EVAL_DEFAULT_WINDOW_DAYS = 7

/** fresh item exposure 的「新」：发布 ≤ 7 天（与 R4/R5 的 freshness 半衰期口径独立，这里只用于统计）。 */
export const RANK_EVAL_FRESH_ITEM_DAYS = 7
```

### 3.2 新增 `packages/contracts/src/recommendation/observability.ts`

```ts
/** 保留期（R1 文档 §6 的政策值，落成机器可读常量，清理 job 与 admin 端点共用一份）。 */
export const RECOMMENDATION_EVENT_RETENTION_DAYS = 180
export const RECOMMENDATION_CONTEXT_RETENTION_DAYS = 90

/** 清理批大小与间隔（D9）：一批 1000 行，够用且不会长时间占住连接（对齐 VISUAL_QUERY_CLEANUP_BATCH_SIZE 的思路）。 */
export const RECOMMENDATION_CLEANUP_BATCH_SIZE = 1_000
export const RECOMMENDATION_CLEANUP_INTERVAL_MS = 3_600_000

/** 限流（D10 + §2.3）：令牌桶容量 / 补充速率，按主体各一份。 */
export const RECOMMENDATION_EVENT_RATE_LIMIT = { capacity: 120, refillPerSecond: 2 } as const
export const RECOMMENDATION_FEED_RATE_LIMIT = { capacity: 60, refillPerSecond: 1 } as const
/** 桶表上限（LRU 淘汰最久未用）：防匿名流量把进程内存撑爆。 */
export const RECOMMENDATION_RATE_LIMIT_MAX_SUBJECTS = 10_000

/** 延迟直方图每个指标的样本数（环形缓冲，读时排序取分位）。 */
export const RECOMMENDATION_LATENCY_SAMPLE_CAPACITY = 2_048
```

容量取值的依据：一次 Feed 页（20 张卡）最多产生 20 条 `IMPRESSION` + 若干 `QUICK_SKIP` / `DETAIL_VIEW`，
快速滚动 3 页 ≈ 60–100 条；容量 120 / 2·s⁻¹（≈120 条/分钟均值）足够真实用户，同时把脚本刷量压到
「每分钟百余条」这个与线上量级同阶的水平。

### 3.3 新增 `packages/contracts/src/admin/recommendation-metrics.ts`

```ts
export const RecommendationMetricsWindowSchema = z.enum(['24h', '7d', '30d'])
export const RECOMMENDATION_METRICS_WINDOW_MS = {
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
} as const

export const RecommendationFunnelSchema = z.object({
  feedRequests: z.number().int().nonnegative(),
  degradedFeedRequests: z.number().int().nonnegative(), // strategy_version = 'rec-v1-none'
  impressions: z.number().int().nonnegative(),
  detailViews: z.number().int().nonnegative(),
  favorites: z.number().int().nonnegative(),
  chats: z.number().int().nonnegative(),
  transactions: z.number().int().nonnegative(),
  purchases: z.number().int().nonnegative(),
  // 相邻步的转化率；分母为 0 时为 null（不是 0：0 会被读成「转化极差」）
  //
  // **刻意不设 `.max(1)`**（实现期由 429 端到端用例撞出来的修正）：这些步骤是**各自独立上报的
  // 事件计数，不是嵌套集合**——`IMPRESSION` 有可见性门槛（visibleRatio ≥ 0.5、停留 ≥ 1000ms），
  // 而 `DETAIL_VIEW` 点进详情就上报；服务端确证事件（`CHAT_START` 等）由业务请求直接落库，
  // 完全可以没有对应的 `DETAIL_VIEW`。所以 `impressionToDetailRate > 1` 是**真实可能**的读数，
  // 加了上界会让整个端点 500（实测 `detailViews=9 / impressions=6` → ZodError）。
  // 要严格嵌套必须按身份做会话级漏斗，与 D4「纯回放已落库数据」冲突（§11 第 14 条）。
  impressionToDetailRate: z.number().nonnegative().nullable(),
  detailToFavoriteRate: z.number().nonnegative().nullable(),
  detailToChatRate: z.number().nonnegative().nullable(),
  chatToTransactionRate: z.number().nonnegative().nullable(),
  transactionToPurchaseRate: z.number().nonnegative().nullable(),
})

export const RecommendationGuardrailsSchema = z.object({
  // 这五个 share 来自同一个 CTE（分子是分母的子集），结构上有界 ⇒ 保留 [0,1]。
  emptyRankedFeedRate: z.number().min(0).max(1).nullable(),
  repeatedExposureRate: z.number().min(0).max(1).nullable(),
  topSellerExposureShare: z.number().min(0).max(1).nullable(),
  top10SellerExposureShare: z.number().min(0).max(1).nullable(),
  staleListingExposureRate: z.number().min(0).max(1).nullable(),
  /** 进程内计数（D5/N2）：自本进程启动以来，不是窗口值。 */
  eventWriteFailureRate: z.number().min(0).max(1).nullable(),
  rateLimitedRequests: z.number().int().nonnegative(),
  eventRejectionReasons: z.object({
    attributionNotFound: z.number().int().nonnegative(),
    identityMismatch: z.number().int().nonnegative(),
    listingNotFound: z.number().int().nonnegative(),
    occurredAtOutOfRange: z.number().int().nonnegative(),
    // 第 5 桶：客户端伪报服务端确证行为（成交/开聊/评论）。少了它，「客户端伪造成交」
    // 在指标上就是隐形的——而这正是本设计最想让人看见的一类脏数据（§6.3）。
    serverConfirmedEventType: z.number().int().nonnegative(),
  }),
})

export const RecommendationLatencySchema = z.object({
  metric: z.enum(['feed', 'events', 'pgvector']),
  count: z.number().int().nonnegative(),
  p50Ms: z.number().nonnegative().nullable(),
  p95Ms: z.number().nonnegative().nullable(),
  p99Ms: z.number().nonnegative().nullable(),
  maxMs: z.number().nonnegative().nullable(),
})

export const RecommendationMetricsSchema = z.object({
  window: RecommendationMetricsWindowSchema,
  generatedAt: z.string(), // ISO
  /** 口径提醒：latency 与 eventWriteFailureRate 是**单进程**值，字段注释里也要写。 */
  processStartedAt: z.string(),
  funnel: RecommendationFunnelSchema,
  guardrails: RecommendationGuardrailsSchema,
  latency: z.array(RecommendationLatencySchema),
})
```

### 3.4 改动既有契约

- `packages/contracts/src/admin/routes.ts`：`ADMIN_ROUTES` 增一项
  `recommendationMetrics: '/admin/recommendations/metrics'`（注释写明「只读、窗口参数、口径见契约」）。
- `packages/contracts/src/recommendation/schema.ts`：新增一个**字符串常量**
  `export const RECOMMENDATION_RATE_LIMITED = 'RECOMMENDATION_RATE_LIMITED'`
  （形态照 `RECOMMENDATION_STRATEGY_VERSION_NONE`；`errorBody` 的 `code` 是普通字符串，
  `packages/contracts/src/system/error.ts:48`，不为此新增 zod 枚举）。
  **不复用 auth 的 `RATE_LIMITED`**：`apps/api/src/modules/ai/service.ts:125` 已写下这条纪律
  ——「429 不复用 `RATE_LIMITED`：语义不同的拒绝共用一个码，客户端就给不出正确文案与倒计时」，
  既有先例是 `VISUAL_SEARCH_RATE_LIMITED` / `LISTING_LOOKUP_RATE_LIMITED`。
- **429 不走 `RecommendationServiceError`**：该类被硬类型化成 `status: 422` + `code: 'VALIDATION_FAILED'`
  （`apps/api/src/modules/recommendation/service.ts:57-67`）。R6 新增独立的
  `RecommendationRateLimitError`（`status: 429`、`code = RECOMMENDATION_RATE_LIMITED`、
  `retryAfterSeconds`），由 router 的 `instanceof` 分支处理（放在现有
  `RecommendationServiceError` 分支之后，`apps/api/src/modules/recommendation/router.ts:67`），
  形态照 `apps/api/src/modules/visual-search/router.ts:50-66`。这样 service 层不必知道限流的存在，
  也不把「只能 422」的类扩成多状态。
- `packages/contracts/src/recommendation/schema.ts` 的 `RecommendationEventIngestResponseSchema`
  **不改**：该契约的注释明确「逐条拒绝原因写服务端日志，不占响应体」，R6 把原因变成**进程内计数**
  （从日志升级为可读指标），仍然不进响应体（§6.3）。

---

## 4 数据来源与口径

### 4.1 用到的表与索引（零新增）

| 表 | 用到的列 | 现有索引（R6 依赖的） |
|---|---|---|
| `recommendation_requests` | `id`, `user_id`, `anonymous_session_id`, `strategy_version`, `requested_at` | `recommendation_requests_user_id_requested_at_idx`、`_session_id_requested_at_idx` |
| `recommendation_request_items` | `request_id`, `position`, `listing_id`, `primary_source`, `sources`, `rank_score`, `rank_breakdown` | `recommendation_request_items_position_uq`（`(request_id, position)`）、`_request_id_idx` |
| `recommendation_events` | `event_type`, `user_id`, `anonymous_session_id`, `request_id`, `listing_id`, `position`, `source`, `occurred_at` | `_occurred_at_idx`、`_listing_id_occurred_at_idx`、`_user_id_occurred_at_idx`、`_session_id_occurred_at_idx`、`_request_id_idx` |
| `listings` | `id`, `seller_id`, `category`, `status`, `moderation_status`, `governance_delisted_at`, `created_at` | 既有索引；`coverage` 类分母只做一次可见性过滤（`status='ACTIVE' AND moderation_status='APPROVED' AND governance_delisted_at IS NULL`） |

**身份谓词只有一份实现**：`packages/db/src/recall-store.ts` 的
`identity.kind === 'user' ? eq(recommendationEvents.userId, identity.id) : and(eq(recommendationEvents.anonymousSessionId, identity.id), isNull(recommendationEvents.userId))`。
R6 的所有「同一身份」聚合（重复曝光率、漏斗按身份切片）必须复用它，不另写一份谓词。

### 4.2 两个时间轴，不能混用

- **请求轴**：`recommendation_requests.requested_at`（决定请求属于哪个评估/统计窗口）；
- **事件轴**：`recommendation_events.occurred_at`（客户端发生时刻，离线补发时保留真实时刻）。

离线评估用「请求轴切窗 + 事件轴做归因」（§5.3）；线上漏斗与 guardrail 用「事件轴切窗」（§6.2）。
两者不能互换：按 `created_at`（写入时刻）切窗会让离线补发把旧行为算进今天。

**对 §4.1 表格的一处修正（实现期补充，审查 P3-2）**：覆盖率分母的可见性谓词除
`status='ACTIVE' AND moderation_status='APPROVED' AND governance_delisted_at IS NULL` 外，
还多一条 `listings.created_at < until`（`apps/worker/src/jobs/recommendation/store.ts:175`）。
理由：窗口末端之后才上架的商品在窗口内不可能被任何请求召回，放进分母会人为压低覆盖率。
字面口径（只按状态过滤）会把「未来的供给」算成「没覆盖到」，属于口径错误而非严格性问题；
`created_at` 无时区歧义（`timestamptz`），且该列已在表上。

### 4.3 首次曝光归因（D7 的形式化定义）

对一条**正向**事件 `e`（身份 `I`、商品 `l`、`occurred_at = t`、等级 `g`）：

1. 候选请求集 `C = { r : r 属于身份 I, snapshot(r) 含 l, requested_at(r) ≤ t ≤ requested_at(r) + W }`；
2. 归因请求 `a(e) = argmin_{r ∈ C} (requested_at(r), r.id)`；
3. 若 `C = ∅`，这条事件**不计入任何请求**（它来自非推荐入口或窗口外的曝光）。

`grade(r, l) = max{ g(e) : a(e) = r }`；命中 `RANK_EVAL_NEGATIVE_EVENT_TYPES` 的事件把 `(r, l)` 从
相关集里剔除。**注意这里刻意不使用事件自带的 `request_id`**：它是「当时客户端带着哪个推荐头」，
与「哪次曝光真正促成了这次行为」不是一回事（同一商品可在多次快照里出现）。

**`W = 30 分钟`**（`RANK_EVAL_ATTRIBUTION_WINDOW_MS`，`packages/contracts/src/recommendation/eval.ts`）。
它是**契约常量，不是 CLI 旗标**：一次 Feed 页产生的曝光，后续行为绝大多数发生在同一个会话内，而
会话以分钟计；窗太长会把「第二天想起来又搜到同一个商品」记到昨天的推荐上。改 `W` 会让历史数据
不可比（同一段数据算出不同 recall），所以只允许改代码 + 在变更说明里注明「此前指标作废」，不提供
`--attribution-window` 之类的运行时开关。`apps/worker/src/jobs/recommendation/store.test.ts` 的 e3
用例（`R2` 在 10:20、事件在 13:20 ⇒ 不归任何请求）就是这条取值的回归护栏。

### 4.4 保留期与评估窗的相互作用

事件 180 天、请求上下文 + 快照 90 天（§3.2）。因此：

- **评估/回放窗**（CLI `--window`，默认 7 天）与「回放起点」必须满足 `回放起点 ≥ now - 90 天`
  （否则请求侧已删）；它与 §4.3 的**归因窗 `W`** 是两个不同的量，本文档不再用同一个字母称呼它们；
- 观察窗末端最多到 `now`，但请求行若已被清理，其后续正向事件会因 §4.3 的 `C = ∅` 而静默丢失 ⇒
  CLI 必须打印实际回放区间与「窗口末端被保留期截断」的提示（§5.1）。

---

## 5 离线评估（PR-1）

### 5.1 入口与运行模式

新增 `apps/worker/scripts/rank-eval.ts`，根脚本 `rank:eval` = `bun run apps/worker/scripts/rank-eval.ts`。

```
bun run rank:eval -- --window=7d [--since=ISO] [--until=ISO] [--k=5,10,20] [--json] [--limit-requests=N]
bun run rank:eval -- --fixture            # 不需要 DATABASE_URL，确定性样本，进 CI
```

- 默认模式：`--env-file=../../.env` 读 `DATABASE_URL`（与 `apps/api/scripts/core-smoke.ts` 同族的做法，
  脚本自己连库，不起 API 进程）；
- `--fixture`：读 `apps/worker/src/jobs/recommendation/eval-fixture.ts` 的确定性样本（若干请求 +
  快照 + 事件，含人工给定的期望指标），**不出网、不连库**，因此可以进 CI（N3）。fixture 同时是
  单测数据源：`rank-eval.test.ts` 直接断言 `computeMetrics(fixture) === expected`；
- 输出前打印回放区间、窗口、K、样本量（请求数 / 有信号请求数 / 快照行数 / 事件数），
  以及 §4.4 的保留期截断提示。

**`--limit-requests=N` 的确切语义（审查不确定项 5，已核实）**：它只限制**被评分的请求样本**
（`apps/worker/src/jobs/recommendation/store.ts:92-99` 的 `windowed` CTE 取 `ORDER BY requested_at DESC LIMIT N`），
**不限制归因候选集**（`:113-119` 的 `candidates` CTE 覆盖整个窗口）。后果：某商品同时出现在被抽中的请求 `P`
与未被抽中的更早请求 `Q` 的快照里时，事件归因给 `Q` ⇒ 样本里 `P` 的这条商品拿不到等级，`Recall@K` 偏低。
因此抽样只适合「快速巡检口径是否正常」，**不适合出结论**；出结论必须跑全窗口（不传该旗标）。

### 5.2 输出

默认 Markdown（人读）：逐 K 的质量表 + 覆盖/多样性/曝光分布表 + 商品侧生命周期表；`--json` 输出同一份
数据的 JSON（供脚本/归档）。两处都必须带**分母**（请求数、相关集大小），只有比率没有分母的指标在
小样本下没有意义。

实现落点（审查 P3-A 修正）：质量表增 `Σ|R(r)|` 一列（`RankEvalQualityRow.relevantListings`，
与 K 无关——相关集是请求的属性，不是截断位的属性）；覆盖表的两列改成「分子 / Σ」与「分母 / 样本数」，
四行全部有数：比率行的分子分母都是计数，均值行（`categoryDiversity`、`categoriesPerRequest`）的
「分子」是 Σ、「分母」是样本数（`RankEvalMetrics.coverageDetail`，样本数为 0 时 Σ 为 `null`）。
`Recall@K = 1.0` 在「1 个请求、1 个相关商品」和「50 个请求、200 个相关商品」上长得一模一样，
而这两件事的可信度完全不同——这正是要两列都填数的理由。

### 5.3 排序质量（请求级，D7）

评估集 = 窗口内、`strategy_version <> 'rec-v1-none'`、且至少 1 行快照的请求（降级请求没有排序结果，
评估它没有意义；数量单独报 `degradedRequests`）。

对每个请求 `r`：

- 相关集 `R(r) = { l : grade(r,l) > 0 }`，`rank(r,l)` = `l` 在 `snapshot(r)` 中的 `position + 1`；
- `Recall@K(r) = |{ l ∈ R(r) : rank(r,l) ≤ K }| / |R(r)|`；
- `MRR@K(r) = 1 / rank(r, 首个相关项)`（无相关项进 top-K 时为 0）；
- `NDCG@K(r) = DCG@K / IDCG@K`，`gain = 2^grade - 1`、`discount = 1 / log2(rank + 1)`，
  `IDCG@K` 取 `R(r)` 按 grade 降序的理想排序。

**0/0 的口径（对 D7 措辞的一处细化，**已确认**，见 §2.4）**：`R(r) = ∅` 的请求（用户在这条请求上没有产生
任何正向信号）**不进** Recall/MRR/NDCG 的分母，单独报 `requestsWithoutPositiveSignal`。
把无信号请求算成 0 会让指标随「没人点」的比例变化，而不是随排序质量变化；D7 里「不把无点击请求剔除」
指的是**有相关集但 top-K 没命中**的请求记 0（这些请求保留在分母里）。

输出形状（`quality[]`）：`{ k, requests, relevantListings, recall, mrr, ndcg }`，其中
`relevantListings = Σ_r |R(r)|` 只对**进分母**的那批请求求和（`requests` 与它同分母，
比率为 `null` 当且仅当 `requests === 0`）。

### 5.4 覆盖与曝光分布

- `coverage` = 窗口内被推荐过的去重商品数 / 窗口末可见商品数（分母见 §4.1 的可见性过滤）；
- `categoryDiversity` = 每个请求的 `1 - Σ_c (count_c / n)²`（Gini–Simpson）的均值，另报
  「每请求平均去重类目数」；
- `sellerCoverage` = 有过至少 1 个推荐位次的卖家数 / 可见商品所属卖家数；
- `freshItemExposure` = 落在 `created_at ≥ requested_at - RANK_EVAL_FRESH_ITEM_DAYS` 的位次占比；
- `repeatedExposureRate` = `1 - count(distinct (身份, listing_id)) / count(*)`（身份级；与 R4/R5 排序特征
  `repeatedExposure` 同源，可交叉验证）；
- 以上每一项都在 `coverageDetail` 里同时报出**分子与分母**（审查 P3-A 修正）：`categoryDiversity` /
  `categoriesPerRequest` 报 `{ sum, samples }`，`freshItemExposure` 报 `{ fresh, samples }`，
  `repeatedExposure` 报 `{ extras, samples }`；`samples === 0` 时 Σ 为 `null`（"无法判定"≠ 0）；
- 特征分布（D4 的红利，不需要任何新落库）：从 `rank_breakdown` 直接取 `normalized`，
  报每个 `RANK_FEATURE_KEYS` 的均值 / p50 / p95，以及 `missing` 数组里各键出现次数
  （`missing` 里长期出现 `repeatedExposure` 说明曝光计数查询在降级）。

### 5.5 商品侧生命周期（M8 的三项，N5）

- `newListingTimeToFirstExposure`：窗口内新建商品，从 `listings.created_at` 到**首次被归因曝光**
  （`IMPRESSION`，`request_id IS NOT NULL`）的小时数中位数与 p90；
  「首次被归因曝光」比字面口径更严：R4/R5 之后排序模式的曝光位置/来源以**快照**为准，一条
  `request_id` 有值但**不在该请求快照里**的曝光行是客户端伪造的、已被 `ingest` 拒收，
  因此实现按「归因命中快照」过滤（审查不确定项 4，已接受）。
- `firstPublishToFirstIntent`：从 `created_at` 到首次「有效意向」（grade ≥ 2 的归因事件）的小时数；
- `exposuresBeforeSale`：窗口内 `PURCHASE` 事件对应商品，在成交之前被归因曝光的次数分布（中位数 / p90）。

这三项要对 `listings` 做分组连接，属离线调查工具，不进端点（N5）。

### 5.6 不做什么

- 不算「召回层自身的 recall@K」（D4：没有候选集落库，通道级只能做分账，见下）；
- 通道分账只做**可归因部分**：按 `primary_source` 统计位次与后续正向事件（`sources` 用于
  「多路共同召回」的交叉表），并显式标注「未被任何通道召回的商品无从统计」；
- 不引入随机性、不做置信区间（样本量与分布一起报出来，让人自己判断）。

---

## 6 线上漏斗与 guardrail（PR-1）

### 6.1 端点

```
GET /admin/recommendations/metrics?window=24h|7d|30d
```

- 契约：`RecommendationMetricsSchema`（§3.3）；路由常量 `ADMIN_ROUTES.recommendationMetrics`；
- 鉴权：沿用 `apps/api/src/modules/admin/router.ts` 的 `router.use('*')` 两道守卫
  （`requireAuth` 401 → `requireAdmin` 403，`createRequireAdmin`），**不新增鉴权路径**；
- 实现落点：`apps/api/src/modules/admin/{router,service,store}.ts` 各加一处
  （`router.get('/recommendations/metrics')` → `service.getRecommendationMetrics({window})` →
  `store.getRecommendationMetrics({since, until})`，service 用 `RecommendationMetricsSchema.parse` 兜形状，
  与 `getOverview()` 的写法一致）；
- 仓库内无任何客户端消费 admin API ⇒ 本端点只面向 curl / 外部面板，无需前端改动；
- 失败语义：窗口参数非法 → 422（契约校验）；DB 错误 → 交给 `app.onError`（500），不吞。

### 6.2 `funnel` 块的口径

窗口按**事件轴** `occurred_at`（§4.2）切；每一步的计数条件是「事件类型 + 有推荐归因」
（`request_id IS NOT NULL`）：

| 步 | 条件 |
|---|---|
| `feedRequests` | `recommendation_requests.requested_at ∈ 窗口` |
| `degradedFeedRequests` | 同上且 `strategy_version = 'rec-v1-none'`（R4/R5 的降级透传；没有排序快照） |
| `impressions` | `IMPRESSION` + `request_id IS NOT NULL` |
| `detailViews` | `DETAIL_VIEW` + `request_id IS NOT NULL` |
| `favorites` | `FAVORITE` + `request_id IS NOT NULL` |
| `chats` | `CHAT_START` + `request_id IS NOT NULL` |
| `transactions` | `TRANSACTION_START` + `request_id IS NOT NULL` |
| `purchases` | `PURCHASE` + `request_id IS NOT NULL` |

转化率 = 相邻两步之比，分母 0 → `null`。**已知失真**（写进 §11）：服务端确证事件
（`CHAT_START` / `COMMENT` / `TRANSACTION_START` / `PURCHASE`）只有客户端在业务请求上带了推荐头才有
`request_id`，没带就是 `null` 归因；因此「detail→chat」这类跨端转化率是**下界**。

**比率可以 > 1，契约刻意不设上界**（实现期修正，§3.3 已写明理由）：这些步是各自独立上报的事件计数，
不是嵌套集合。实测形状：`detailViews=9 > impressions=6` ⇒ `impressionToDetailRate = 1.5`。
加 `.max(1)` 会让整个端点 500（`[api] 未捕获异常 ZodError`），端到端用例
`apps/api/src/app.recommendation.test.ts` 的 `expect(metricsResponse.status).toBe(200)` 就是这条护栏。

### 6.3 `guardrails` 块的口径

| 字段 | 口径 | 备注 |
|---|---|---|
| `emptyRankedFeedRate` | 排序请求中快照行数为 0 的比例（分母 = `strategy_version <> 'rec-v1-none'` 的请求数） | 降级请求的「空 feed」无法从库里看出（它不写快照）⇒ 见 §11 |
| `repeatedExposureRate` | 窗口内 `1 - count(distinct (身份, listing_id)) / count(快照行)` | 与 §5.4 同口径，端点只做请求/身份级聚合 |
| `topSellerExposureShare` / `top10SellerExposureShare` | 归因 `IMPRESSION` 按 `listings.seller_id` 分组后最大卖家 / 前 10 卖家的占比 | M8 的 seller exposure concentration |
| `staleListingExposureRate` | 归因 `IMPRESSION` 中商品**当前** `status <> 'ACTIVE'`（SOLD/RESERVED/OFFLINE）的占比 | 「当前」而非「曝光时」，见 §11 |
| `eventWriteFailureRate` | 进程内 `写入失败次数 / (成功批数 + 失败次数)`（`service.recordDomainEvent` 与 `ingest` 的 catch 各计一次） | 单进程、自启动以来（N2） |
| `rateLimitedRequests` | 进程内被 429 拒绝的事件写入请求数 | 单进程（N2） |
| `eventRejectionReasons` | 进程内按原因计数，**5 桶**（见下） | 从「只写日志」升级为可读指标；**不进响应体**（§3.4） |

`eventRejectionReasons` 的 5 桶是 service 内部 7 个拒收原因的**合并**（实现落点
`apps/api/src/observability/recommendation-metrics.ts` 的 `RECOMMENDATION_REJECTION_REASONS`，
映射表 `REJECTION_REASON_METRIC` 在 `apps/api/src/modules/recommendation/service.ts` 用
`as const satisfies Record<RecommendationRejection, RecommendationRejectionReason>` 做编译期穷尽）：

| 内部原因（`service.ts`） | 桶 |
|---|---|
| `request_not_found` / `attribution_not_found` | `attributionNotFound` |
| `identity_mismatch` | `identityMismatch` |
| `listing_not_found` | `listingNotFound` |
| `occurred_at_in_future` / `occurred_at_too_old` | `occurredAtOutOfRange` |
| `server_confirmed_event_type` | `serverConfirmedEventType`（第 5 桶） |

**为什么是 5 桶而不是设计初稿的 4 桶**（审查 P3-B）：`RecommendationEventInputSchema` 接受全部 12 种
`eventType`，客户端可以伪报 `PURCHASE` / `CHAT_START`，service 会以 `server_confirmed_event_type`
拒收。少一列等于让「客户端伪造成交」在指标上隐形——而这正是本设计最想让人看见的一类脏数据。
5 个键**永远齐全**（没发生过是 0，不是缺字段：缺字段会让 `RecommendationMetricsSchema.parse` 抛错、
端点 500），单测 `apps/api/src/observability/recommendation-metrics.test.ts` 锁住这一点。

### 6.4 `latency` 块与进程内直方图（D5 / N2）

新增 `apps/api/src/observability/latency.ts`（新目录，无 barrel）：

```ts
export type LatencyMetric = 'feed' | 'events' | 'pgvector'
export function createLatencyRecorder(options: { capacity: number; clock?: () => Date }): {
  observe(metric: LatencyMetric, durationMs: number): void
  snapshot(): { metric: LatencyMetric; count: number; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null }[]
  startedAt: Date
}
```

- 存储：每个指标一个定长 `Float64Array(2048)` 环形缓冲 + 计数（O(1) 写入、无分配）；
- 读取：拷贝 + 排序后取分位（2048 个元素的排序只在 admin 读路径上发生，可接受）；
- 采样点：
  - `feed`：`GET /recommendations/feed` 的整段处理耗时（router 内 `performance.now()` 前后各取一次）；
  - `events`：`POST /recommendations/events` 的处理耗时；
  - `pgvector`：`apps/api/src/modules/recommendation/recall/service.ts:260` 附近
    `findSemanticRecallCandidates(deps.db, …)` 单次查询耗时（pgvector 检索的唯一入口）；
- 注入：`apps/api/src/app.ts` 创建**一个** recorder 实例，同时交给 recommendation router（写）
  与 admin service（读）。**不能让 admin 模块去 import recommendation 模块的内部对象**——同进程共享
  一个中立的小模块，依赖方向保持「两个 domain 都依赖 `observability`」；
- 契约字段必须写明「自本进程启动以来」，响应里同时给 `processStartedAt`。

---

## 7 保留期清理（PR-2，D9）

### 7.1 模块与调度

- 新增 `apps/worker/src/jobs/recommendation/cleanup.ts`：

```ts
export type RecommendationCleanupResult = {
  deletedRequestItems: number
  deletedRequests: number
  deletedEvents: number
  batches: number
}
export async function cleanupExpiredRecommendationData(input: {
  db: Db
  now: Date
  batchSize?: number
  dryRun?: boolean
}): Promise<RecommendationCleanupResult>
```

- 调度：`apps/worker/src/index.ts` 现有维护循环里加第二项。**把单个 `lastMaintenanceAt` 换成
  一张 `SCHEDULES = [{ intervalMs, lastRun: 0, run }]` 小表**（视觉维护 + 推荐清理；**已确认**，见 §2.4），
  理由：再来第三个定时任务时不必继续堆 `if`，且「首次循环立即跑一轮」的既有行为可以逐项保留；
  新增常量 `RECOMMENDATION_CLEANUP_INTERVAL_MS = 3_600_000`（1h：保留期以天计，1h 粒度足够，
  也不必每分钟打一次删除查询）。
- 失败语义：与 `runVisualMaintenance` 一致——一轮失败只记日志、不带走 worker 主循环，
  下一轮自然重试；部分成功的批次已经落库（删除是幂等的）。

### 7.2 删除顺序与批量

1. **快照行**：`DELETE FROM recommendation_request_items WHERE request_id IN (SELECT id FROM recommendation_requests WHERE requested_at < $contextCutoff ORDER BY requested_at LIMIT $batch) RETURNING id`；
2. **请求行**：`DELETE FROM recommendation_requests WHERE id IN (SELECT id FROM recommendation_requests WHERE requested_at < $contextCutoff ORDER BY requested_at LIMIT $batch) RETURNING id`
   （快照表对 `request_id` 有 `ON DELETE CASCADE`，显式先删是为了把单次级联规模压在 batch × ≤200 行，
   而不是让一条 `DELETE` 级联出十万行）；
3. **事件行**：`DELETE FROM recommendation_events WHERE id IN (SELECT id FROM recommendation_events WHERE occurred_at < $eventCutoff ORDER BY occurred_at LIMIT $batch) RETURNING id`
   （走 `recommendation_events_occurred_at_idx`）。

**第 2 步与初稿的差异（实现期修正）：请求行按自己的 `requested_at` 独立选批，不复用第 1 步取到的
request_id 集合。** 理由：降级 Feed（`rec-v1-none` 直通游标）与「快照写入失败」的请求**一行快照都没有**
（N10 的第一类），复用第 1 步的 id 集合会让这些请求行永远删不掉 ⇒ 90 天保留期的承诺直接失效。
两类各自 `ORDER BY requested_at LIMIT $batch`，跑在同一个循环里直到三类本轮合计为 0。
回归护栏：`apps/worker/src/jobs/recommendation/cleanup.test.ts` 专门造了一个「过期但没有快照行」的请求，
断言它会被删掉。

每一类循环到「本轮删除行数 = 0」为止，批间 `await Bun.sleep(50)` 让路（避免长事务占住连接），
每批打印一行计数。`dryRun` 时把 `DELETE` 换成同条件的 `SELECT count(*)`，不写任何行。

**顺序为什么不能反**：请求行一旦先删，快照行被级联带走，就再也无法按批控制规模；反过来
（先删快照再删请求）每一步都可中断、可重跑。

### 7.3 CLI 入口

新增 `apps/worker/scripts/recommendation-cleanup.ts`，根脚本 `recommendation:cleanup`：

```
bun run recommendation:cleanup -- [--once] [--dry-run] [--batch-size=1000]
```

- `--once`：跑一轮（三类各循环到空）后退出——这是 `core:smoke` 与手工验证用的入口；
- `--dry-run`：只统计待删行数；
- 输出：三类删除行数与批次数，`--json` 给脚本用（`core:smoke` 用 `runRootScriptJson` 解析它，
  断言 `mode === 'dry-run'`、三类行数是非负整数、`batches === 0`——`dry-run` 不进删除循环）；
- 参数非法（`--batch-size=0` / 非整数 / 未知旗标）必须报错退出，不能静默用默认值跑：
  一个"悄悄按 1000 行批删"的 CLI 是最容易被误用的形态。用例在
  `apps/worker/scripts/recommendation-cleanup.test.ts`（不连库，靠 `import.meta.main` 守卫 +
  把 `DATABASE_URL` 指向不可达地址来证明"校验发生在连库之前"）。

---

## 8 限流与 bot / 开发预览隔离（PR-2）

### 8.1 埋点限流（D10 + §2.3）

新增 `apps/api/src/modules/recommendation/rate-limit.ts`：

```ts
export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number }
export function createTokenBucketLimiter(options: {
  capacity: number
  refillPerSecond: number
  maxSubjects: number
  clock?: () => number
}): {
  take(subject: string): RateLimitDecision
  /** 同一请求的多个主体（匿名是 session + ip）必须**全部**通过；任一不过则整体拒绝，取最大等待秒数。 */
  takeAll(subjects: readonly string[]): RateLimitDecision
}
```

- 键：登录 `user:<userId>`；匿名 `session:<anonymousSessionId>` + `ip:<trustedClientIp>`；
  IP 无法归因时用共享 `unattributed` 桶（fail-closed，参照
  `apps/api/src/modules/visual-search/subject.ts` 的 `UNATTRIBUTED_IP_SUBJECT`）；
- IP 解析复用既有实现，不新写：`apps/api/src/modules/listings/trusted-ip.ts` 的
  `trustedClientIp(request, peerIp, trustedProxyIp)` / `normalizeIp`，由 `apps/api/src/app.ts` 已经注入的
  `resolveClientIp`（`:311` / `:385`）传进推荐 router；跨模块 import 有先例
  （`apps/api/src/modules/visual-search/subject.ts` 同样 import `../listings/trusted-ip`）；
- **IP 只在进程内 Map 里当键**，不落库、不进日志、不进响应；
- 应用点：`POST /recommendations/events` 在契约校验之后、`service.ingest` 之前
  （`apps/api/src/modules/recommendation/router.ts:88`）。按**批**扣 1 个令牌（不是按事件条数：
  批上限 50 条，按条扣会让一次翻页 20 条曝光吃掉 1/6 的容量）；
- 超限响应：抛 `RecommendationRateLimitError`（§3.4）→ router 的 `instanceof` 分支回 `429` +
  `errorBody(RECOMMENDATION_RATE_LIMITED, '埋点写入过于频繁', undefined, retryAfterSeconds)`
  + `Retry-After` 头（形态照 `apps/api/src/modules/visual-search/router.ts:50-66`）；
- 阈值可配：`RECOMMENDATION_EVENT_RATE_LIMIT` 为默认值，允许 env 覆盖（`packages/shared/src/env.ts`
  增 `loadRecommendationRateLimitEnv`，默认值与常量一致，未配置即用默认）；
- `GET /recommendations/feed` 同样加一份更宽的桶（`RECOMMENDATION_FEED_RATE_LIMIT`，容量 60 / 1·s⁻¹）：
  拿到 `requestId` 是写归因事件的前提，不限 Feed 等于给 bot 一条免费取号通道（D10 只问了埋点端点，
  这一条是 N1 意义上的配套默认，**已确认**，见 §2.4）。

### 8.2 bot / 开发预览隔离（N1）

R6 **不新增**任何 bot 判定存储（D5），而是把已有的三道硬约束显性化 + 补一层频率控制：

1. **归因硬约束（R4/R5 已实现，本轮只依赖）**：`IMPRESSION` / `QUICK_SKIP` 必须带
   `requestId` + `position`（契约 `superRefine` + 库级 CHECK
   `recommendation_events_impression_requires_attribution`），且服务端用快照真值覆盖客户端上报；
   `(request_id, listing_id)` 不在快照里的事件被拒（`attribution_not_found`）。
   ⇒ 「没真的调过 Feed、没被返回过这张卡」的曝光写不进来；
2. **身份归属**：`requestId` 必须属于当前身份（`identity_mismatch`），换身份刷同一批 requestId 无效；
3. **频率**：§8.1 的令牌桶（事件 + Feed 两份）；
4. **可见性**：上述拒绝原因与限流次数计进进程内计数器，经 `guardrails` 暴露（§6.3）——
   bot 流量从此在指标上可见，而不是只留在日志里；
5. **开发预览 / fixture**：R1 已定「客户端边界就不发 `IMPRESSION`/`QUICK_SKIP`」，真发到服务端也会被
   契约校验或 `listing_not_found` 拒收（`docs/design/issue-323-r1-event-tracking.md:136`）；
   R6 不新增结构性隔离（R1 不落 UA，服务端确实无法区分 bot 与普通用户），只把拒绝计数暴露出来。

---

## 9 两个 PR 的边界（D11）

### PR-1「R6 读面：离线评估 + admin 聚合端点」（零线上行为变化）

- 新增：`packages/contracts/src/recommendation/eval.ts`（+ `eval.test.ts`）、
  `packages/contracts/src/admin/recommendation-metrics.ts`、
  `apps/api/src/observability/latency.ts`（+ `latency.test.ts`）、
  `apps/api/src/observability/recommendation-metrics.ts`（+ `recommendation-metrics.test.ts`，
  审查 P3-D 补：进程内计数器的唯一实现，admin 读、推荐写，两边都依赖它）、
  `apps/api/src/modules/admin/store.recommendation-metrics.test.ts`、
  `apps/worker/src/jobs/recommendation/eval.ts`（纯函数指标层）、
  `apps/worker/src/jobs/recommendation/store.ts`（取数适配器：4 段 SQL 拼 `RankEvalDataset`）、
  `apps/worker/src/jobs/recommendation/eval-fixture.ts`（+ `eval.test.ts`、`store.test.ts`）、
  `apps/worker/scripts/rank-eval.ts`（+ `rank-eval.test.ts`）；
- 修改：`packages/contracts/src/admin/routes.ts`（+1 常量）、
  `apps/api/src/modules/admin/{router,service,store,module}.ts`（+1 只读端点）、
  `apps/api/src/modules/recommendation/router.ts`（+2 处 `observe` 调用）、
  `apps/api/src/modules/recommendation/recall/service.ts`（+1 处 `observe`）、
  `apps/api/src/app.ts`（创建并注入 latency recorder）、
  `apps/api/src/modules/admin/{service,router}.test.ts`（扩展）、
  `apps/api/scripts/core-smoke.ts`（R6 指标端点断言）、根 `package.json`（+`rank:eval`）；
- 纯函数层与取数层分开（`eval.ts` 只吃 `RankEvalDataset`、`store.ts` 只产它）的理由：
  指标口径可以拿手算 fixture 断言，SQL 则用 scratch 库做集成测试——两者混在一个文件里时
  任何一侧改动都会让另一侧的测试变成「测 SQL 顺带测算法」。
- 验收：契约单测、store SQL 集成测试（`apps/api/src/modules/admin/*.test.ts`）、
  `rank-eval --fixture` 的确定性指标断言、`/admin/recommendations/metrics` 的 401/403/200 与窗口校验、
  延迟分位数的单测（给定样本序列 → 已知分位）。

### PR-2「R6 写面：限流 + bot 可见性 + 保留期清理」（会拒绝请求、会删数据）

- 新增：`packages/contracts/src/recommendation/observability.ts`（保留期/批大小/调度间隔/两份限流阈值/
  采样容量的唯一出处；`RECOMMENDATION_LATENCY_SAMPLE_CAPACITY` 从 `admin/recommendation-metrics.ts`
  移到这里，避免「延迟模块依赖 admin 契约」的反向依赖）、
  `apps/api/src/modules/recommendation/rate-limit.ts`（+ `rate-limit.test.ts`）、
  `apps/worker/src/jobs/recommendation/cleanup.ts`（+ `cleanup.test.ts`）、
  `apps/worker/scripts/recommendation-cleanup.ts`（+ `recommendation-cleanup.test.ts`）；
- 修改：`packages/contracts/src/recommendation/schema.ts`（错误码）、
  `apps/api/src/modules/recommendation/router.ts`（限流 + 429）、
  `apps/api/src/modules/recommendation/service.ts`（进程内失败/拒绝计数）、
  `apps/api/src/app.ts`（注入 `resolveClientIp` 与计数器）、
  `packages/shared/src/env.ts`（限流阈值 env）、
  `apps/worker/src/index.ts`（调度表 + 清理任务）、根 `package.json`（+`recommendation:cleanup`）；
- 验收：令牌桶单测（补充速率、LRU 淘汰、多主体取最严）、429 契约与 `Retry-After`、
  清理 job 的集成测试（造 91/181 天的数据 → 删除；`--dry-run` 不删）、`core:smoke` 增加一轮
  `recommendation:cleanup --once --dry-run`。

两个 PR 都**不含**新依赖、不含迁移、不动客户端。

---

## 10 验证计划

### 10.1 单测 / 集成测试（必须新写）

| 用例 | 位置 | 断言要点 |
|---|---|---|
| 相关性分级与负向剔除 | `packages/contracts/src/recommendation/eval.test.ts` | 分级常量、K 值、`DETAIL_VIEW` 与 `PURCHASE` 的增益差、负向事件把商品移出相关集 |
| 指标计算（确定性 fixture） | `apps/worker/src/jobs/recommendation/eval.test.ts` | 手算 Recall@5/10/20、MRR、NDCG、coverage、diversity、repeated exposure；**0/0 请求被排除且计入 `requestsWithoutPositiveSignal`** |
| 首次曝光归因 | 同上 | 同一商品出现在请求 A、B 的快照里、事件发生在 B 之后 → 只归因给 A；窗口外事件不归因 |
| CLI 参数与输出 | `apps/worker/scripts/rank-eval.test.ts`（或同目录测试） | `--window` 解析、`--json` 形状、`--fixture` 不需要 `DATABASE_URL` |
| 清理批量与顺序 | `apps/worker/src/jobs/recommendation/cleanup.test.ts` | 90 天边界（89 天不删、91 天删）、先删快照再删请求、180 天事件、`dryRun` 零删除、批大小生效 |
| 令牌桶 | `apps/api/src/modules/recommendation/rate-limit.test.ts` | 容量耗尽 → 拒绝且 `retryAfterSeconds` 随补充递减；LRU 淘汰后新主体有额度；多主体取最严 |
| 限流端到端 | `apps/api/src/app.recommendation.test.ts` | 连续写入到超限 → 429 + `RECOMMENDATION_RATE_LIMITED` + `Retry-After`；**修复前会失败**（未加限流时返回 202） |
| admin 端点 | `apps/api/src/modules/admin/router.test.ts` / `store.test.ts` | 未登录 401、非管理员 403、管理员 200；`window` 非法 422；空库时各比率为 `null` 而不是 0；窗口过滤正确（造窗口内外数据） |
| 延迟分位 | `apps/api/src/observability/latency.test.ts` | 给定样本序列 → p50/p95/p99 已知值；环形缓冲回绕后仍正确；`count` 与容量关系 |
| 拒绝原因计数 | `apps/api/src/modules/recommendation/service.test.ts` | 构造 `attribution_not_found` / `identity_mismatch` / `listing_not_found` 各一条 → 计数器各自 +1（7 个内部原因 → 5 个桶的映射） |
| 进程内计数器 | `apps/api/src/observability/recommendation-metrics.test.ts` | 5 个原因键**恒齐全**（没发生过是 0，不是缺字段）；`snapshot()` 是副本（改返回值不影响计数器）；两个实例不共享（审查 P3-D 补） |
| `rank_breakdown` 的 7 键路径 | `apps/worker/src/jobs/recommendation/store.test.ts` | 真库写一行合法 7 键 + `missing` → 7 个键都出现、`missing` 里的键 `samples=0`/`missingCount=1`、形状不符的行只进 `skippedBreakdownRows`（审查 P3-D 补） |
| 清理 CLI 参数 | `apps/worker/scripts/recommendation-cleanup.test.ts` | 非法 `--batch-size`（0/负/小数/非数）与未知旗标报错退出、`--help` 退出 0、`--once`/`--dry-run`/`--json` 组合透传、`import.meta.main` 守卫（import 不跑清理） |

### 10.2 运行时实跑（`core:smoke` 扩展 + 手工）

`apps/api/scripts/core-smoke.ts` 现有推荐小节（Feed → 快照 → 翻页 → 归因真值）之后追加：

1. `GET /admin/recommendations/metrics?window=24h`（带管理员会话）→ 200，`funnel.feedRequests ≥ 1`、
   `funnel.impressions ≥ 1`（前面小节刚写过事件）、`latency` 里有 `feed` 样本、`guardrails` 字段齐全；
2. `window=bad` → 422；
3. 匿名连续写事件直到 429（实现落点：不带会话头 ⇒ 匿名主体只剩"未归因 IP"共享桶，用一条**不存在的
   商品公开 id** 反复 POST，能过契约、会被业务拒收、不往库里灌垃圾；最多 200 次）→ 断言 429 +
   `Retry-After` 非空 + `error.code === RECOMMENDATION_RATE_LIMITED` + 体的 `retryAfterSeconds` 与头一致，
   随后再读一次指标断言 `guardrails.rateLimitedRequests ≥ 1` 且 `eventRejectionReasons` 5 桶齐全。
   **不调小阈值**：smoke 里改 env 会连带把后面小节（MATCH_LISTING 等）一起限掉；
4. `bun run recommendation:cleanup -- --once --dry-run --json` → 退出码 0、`mode === 'dry-run'`、
   三类行数是非负整数、`batches === 0`（smoke 数据都在保留期内，也就必然删 0 行）；
5. 清理 job 的真实删除用集成测试覆盖（10.1），**不在 smoke 里造 91 天前的数据**。

手工验证（本机）：

- 起 API + worker（本机 `VISUAL_EMBEDDING_TRANSPORT=stub VISUAL_PARSE_TRANSPORT=off`），
  连续刷 Feed 若干次，观察 `/admin/recommendations/metrics` 的漏斗与延迟随流量变化；
- `rank:eval -- --window=7d` 在有真实流量的库上跑一次，确认回放区间、样本量、保留期提示都打印；
- 停 API 进程再起，确认 `latency` 与 `eventWriteFailureRate` 归零（N2 的可见证据）。

### 10.3 CI 门禁

沿用 `.github/workflows/ci.yml` 既有作业：`static`（lockfile 源 + `bun run lint` + `bun run typecheck`）、
`db-tests`（`bun run db:migrate` + media-smoke + 测试）、`unit-tests`、`core-smoke`。
R6 不新增 CI 作业。

**一处与初稿的差异（审查 P3-C 实测）**：`apps/worker/**` 只被 `db-tests` 收集
（`.github/workflows/ci.yml:287` 的 target 含 `apps/worker`），`unit-tests`（`:297`，target 列表
`:316-326`，`:321-325` 的注释明确 `apps/*/scripts` 用例归 `db-tests`）不含它。
所以 `apps/worker/scripts/rank-eval.test.ts`、`recommendation-cleanup.test.ts`、
`apps/worker/src/jobs/recommendation/{eval,store,cleanup}.test.ts` 实际都跑在 **`db-tests`** 里，
初稿写的「进 `unit-tests`」不成立。取舍：`store.test.ts` / `cleanup.test.ts` 本来就需要真库
（自建 scratch 库），放 `db-tests` 是正确归属；`rank-eval.test.ts` 的 fixture 断言不需要库，
跟着 apps/worker 走 `db-tests` 也不会漏跑（该作业在 CI 里总是执行）。
**已知后果**：只改 `packages/contracts`（不动 apps/worker）的 PR 不会触发这组断言——
`packages/contracts` 的用例在 `unit-tests`，而它覆盖不到 fixture 的端到端形状。

### 10.4 完成后

按仓库纪律：相关测试 → `bun run typecheck` → `bun run lint` → `bun test --isolate` → 运行时实跑
→ 用**全新子代理**做对抗性审查（只给改动范围与需求），审查记录回填 §12。

---

## 11 已知边界（本轮不修，必须知道）

1. **延迟与进程内计数是单进程口径**：`latency`、`eventWriteFailureRate`、`rateLimitedRequests`、
   `eventRejectionReasons` 都随进程重启清零；多实例部署时每个实例各看一份。要全局值就得引入指标后端
   或新表，与 D3/D5 冲突。
2. **`emptyRankedFeedRate` 看不到降级请求的空 feed**：降级请求（`rec-v1-none`）不写快照，其响应内容
   库里没有真值 ⇒ 只能分开看 `degradedFeedRequests` 与排序请求的空快照率。
3. **`staleListingExposureRate` 用的是「商品当前状态」**，不是曝光时刻的状态（没有状态历史表）：
   它会同时把「曝光时已售」和「曝光后才售出」算进去，因此是陈旧曝光的**上界**。
4. **漏斗的服务端确证步骤是下界**：`CHAT_START` / `COMMENT` / `TRANSACTION_START` / `PURCHASE` 只在
   业务请求带了推荐头时才有 `request_id`（§6.2）；没带头的服务端事件 `position`/`source` 为 `null`
   （R4/R5 §8 的刻意口径），因此不计入漏斗。
5. **没有候选集落库 ⇒ 没有真正的「召回层 recall@K」**：离线评估只能算「最终有序列表」的质量，
   通道侧只能按 `primary_source`/`sources` 做分账，不能算「某路召回了多少本可被召回的商品」。
6. **评估窗被保留期截断**：回放起点不能早于 `now - 90 天`（请求/快照保留期），且请求被清理后其后续
   正向事件会因归因候选集为空而静默丢失（§4.4）。CLI 必须打印实际区间与提示。
7. **匿名限流的键是客户端自述会话 + 可信 IP**：会话标识可轮换，因此真实防护来自 IP 维度；
   IP 无法归因（未配可信代理且带转发头）时所有这类流量共用一个兜底桶（fail-closed，会表现为
   大面积 429，逼部署方去配 `LISTING_LOOKUP_TRUSTED_PROXY_IP`）。
8. **限流是单实例的**：多实例部署时每个实例各有一份额度（与 §1 一致）。
9. **推荐指标不构成实验结论**：R1 起 `position`/`source` 就有「客户端自述 vs 服务端真值」的历史差异，
   R4/R5 之后新事件是真值，但库里仍混着 R1–R3 时代的历史行；按 `strategy_version` 切片可以区分，
   跨期对比时必须显式切片。
10. **R3 遗留的三项仍未做**：单路召回超时、`RecallDegradeReason` 的「空 vs 错」枚举、popular 通道的
    缓存/物化取舍（`docs/design/issue-323-r3-multi-channel-recall.md:146-150`）。R6 的 `missing` 分布
    能**间接**暴露前两项的症状（`repeatedExposure` 长期缺失 = 曝光计数降级），但不修。
11. **排序权重仍是初值**：`semantic 0.35` / `category 0.20` 等（R4/R5 §11 第 9 条）未经数据校准；
    R6 提供的是**度量手段**，不是调参结论。用 §5.4 的特征分布 + §5.3 的分 K 指标做对照实验时，
    样本量与窗口必须一起报。
12. **`rank_breakdown` 的读取依赖其 jsonb 形状**：库层不做运行时校验（`packages/db/src/schema/recommendation-request-items.ts` 的注释），
    形状由 API 排序层保证；CLI 读到形状不符的行时应跳过并计数，而不是抛错终止整次评估。
13. **商品侧生命周期指标只覆盖「窗口内有归因曝光/成交」的商品**：从未被推荐过的商品不在分母里，
    因此不能当作全站发布效率指标。
14. **清理 job 与在线写入竞争**：删除按批进行，删除期间新写入不受影响；若某批删除耗时超过 1h 的
    调度间隔，worker 的调度表会跳过下一次（不是并发跑两份）。
15. **限流主体表有 LRU 上限（`RECOMMENDATION_RATE_LIMIT_MAX_SUBJECTS = 10_000`）**：超限后淘汰最久
    未使用的主体，被淘汰者下一次请求会重新拿到满桶（这是"防内存被主体数撑爆"，不是"防换 IP 刷"）。
    兜底桶 `unattributed` 是 fail-closed 的共享桶：未配可信代理时所有匿名流量共用它，会表现为
    大面积 429——这是有意的（逼部署方去配 `LISTING_LOOKUP_TRUSTED_PROXY_IP`），不是 bug。
16. **`core:smoke` 的 429 断言会消耗同一进程的限流额度**：smoke 在**一个** API 进程里跑完全部小节，
    埋点桶被那 200 次匿名请求打空后，后续小节若再打 `POST /recommendations/events` 会拿到 429。
    因此该小节放在推荐相关小节的**最后**，且 `app.recommendation.test.ts` 的限流用例专门另起一个
    app 实例（不打空共享实例的桶）。将来往 smoke 里加推荐事件步骤时，必须加在这个小节**之前**。

---

## 12 对抗性审查记录

按 §10.4：**全新子代理**、只给「改动范围 + 需求」，不给思路/可疑点/结论；审查者只读、不改文件。
共两轮。

### 12.1 第一轮（PR-1 读面）

范围：PR-1 的读面文件（契约、离线评估、admin 端点、延迟直方图）。

| 结论 | 内容 | 处置 |
|---|---|---|
| P0/P1/P2 | **未发现** | — |
| P3-A | §5.2 点名的「相关集大小」分母两处都缺：`--json` 的 `quality[]` 无 `Σ|R(r)|`，Markdown 覆盖表四行硬编码 `—` | **已修**：`RankEvalQualityRow.relevantListings` + `coverageDetail`（§5.2/§5.4），`eval.test.ts` 增断言 |
| P3-B | 契约 `eventRejectionReasons` 比 §6.3 多第 5 桶，且 §9 文件清单漏 `observability/recommendation-metrics.ts` | **保桶 + 同步文档**（§3.3/§6.3/§9）；理由：`RecommendationEventInputSchema` 接受全部 12 种 `eventType`，少一列等于让「伪造成交」在指标上隐形 |
| P3-C | `rank-eval.test.ts` 落在 CI 的 `db-tests` 而非 §10.3 写的 `unit-tests` | **已修文档**（§10.3 改为事实归属 + 已知后果） |
| P3-D | `observability/recommendation-metrics.ts` 无单测（7→5 映射只有编译期保护） | **已修**：新增 `recommendation-metrics.test.ts`（计数器语义）+ `apps/api/src/modules/recommendation/service.test.ts`（9 例钉住 7→5 的每个分支） |
| 门禁 | 快照上 `bunx biome check` 有 8 个 `FIXABLE` 报错（import 排序/格式），会挂 `biome ci` | **已修**：`bunx biome check --write .`（Fixed 12 files） |
| 观察（非缺陷） | 工作区 `.env` 指向未迁移的库 ⇒ `rank:eval` 报 `42P01` | 用 `DATABASE_URL=…fish_323_r45` 跑；脚本本身无问题 |
| 观察（非缺陷） | DB 集成测试的 `insertItem` 只写形状不符的 `rank_breakdown`，真实 7 键路径未被自动测试覆盖 | **已修**：`apps/worker/src/jobs/recommendation/store.test.ts` 增 7 键用例（`missing` 里的键不进分布、形状不符只计数） |

### 12.2 第二轮（全分支：PR-1 + PR-2）

范围：整条分支（读面 + 写面），含运行时实跑。

| 结论 | 内容 | 处置 |
|---|---|---|
| P0/P1 | **未发现** | — |
| P2-1 | 归因窗 `W` 硬编码 30 分钟、无 CLI 旗标，与 D7 字面「请求后 7 天窗（CLI 可调）」矛盾；§4.3 从未给出 `W` 的数值，§4.4 又把评估窗也写作 `W` | **已裁决并同步**：`W = 30 分钟` 是**固化契约常量、不提供 CLI 开关**（改它历史数据不可比）；D7、§4.3、§4.4 三处改写，`eval.test.ts` 增断言钉住 30 分钟且 < 默认评估窗 |
| P2-2 | §10.1 必写用例「拒绝原因计数」缺失（`service.test.ts` 不存在，端到端只断言了 `serverConfirmedEventType`） | **已修**：新增 `apps/api/src/modules/recommendation/service.test.ts`（9 pass，覆盖 7 个内部原因 → 5 桶、降级请求不查快照、整批拒收不记 attempt、写入失败计数） |
| P2-3 | 契约注释与实现口径不一致：`repeatedExposureRate` 注释写分母「归因曝光数」而实现用**快照行数**；`rateLimitedRequests` 注释写「事件写入」而实现把 `GET /feed` 的 429 也计入 | **已修注释**（`packages/contracts/src/admin/recommendation-metrics.ts`），并写明为何分母刻意不是上报量、为何两类 429 合并成一个字段 |
| P2-4 | 同 P2-3 组（契约注释两处） | 同上 |
| P3-1 | `rank-eval.ts` 里 `REPLAY_HORIZON_DAYS = 90` 与 `RECOMMENDATION_CONTEXT_RETENTION_DAYS` 重复，注释自称「常量落地后改为引用」但常量已落地 | **已修**：删本地常量，改 import 契约常量（含提示文案） |
| P3-2 | 覆盖率分母的可见性谓词比 §4.1 字面多 `created_at < until`，文档未写 | **已修文档**（§4.2 末尾）：窗口末之后才上架的商品不该进分母，属口径修正 |
| P3-3 | `admin/store.ts` 的 `attributed` CTE 内联 `JOIN listings`，商品行被硬删会让 guardrail 分母与 `funnel.impressions` 不一致 | **判为假阳性**：`packages/db/src/schema/recommendation-events.ts:84-86` 的 `listingId` 是 `ON DELETE CASCADE` FK，商品硬删会连带删掉其事件 ⇒ inner join 不会丢行；软删（`OFFLINE`/`governance_delisted_at`）行仍在，join 也不丢 |
| P3-4 | §12 未回填 | 即本节 |
| 不确定项 1 | reviewer 未实跑 `core:smoke`（需完整栈） | 作者实跑：`[core-smoke] ok — 419 项断言`，exit 0；新增断言是真进程 + 真库（`runRootScriptJson` 真 spawn） |
| 不确定项 3 | 同进程跑多文件 DB 测试出现 hook 超时 / `ERR_POSTGRES_CONNECTION_CLOSED` | **判为环境**：单文件跑全绿；`apps/api/src/modules/auth/router.test.ts` 加 `--timeout 20000` 后 51 pass / 0 fail；CI 已 `ALTER SYSTEM SET max_connections = 200`（`.github/workflows/ci.yml:224-232`，`:249-253` 断言生效值确为 200） |
| 不确定项 4 | `newListingTimeToFirstExposure` 用「被归因的 `IMPRESSION`」，比 §5.5 字面（`request_id IS NOT NULL`）更严 | **接受**：R4/R5 之后新事件的位置/来源以快照为准，用「有归因」才算一次真实曝光；差异写进 §5.5 的口径说明 |
| 不确定项 5 | `--limit-requests` 未定义语义，且归因候选集不受它限制 | **已核实并写进 §5.1**：抽样只限被评分请求，不限制候选集 ⇒ 抽样会让 recall 偏低，只适合巡检 |

### 12.3 实现期自测发现（非审查提出）

- **契约把漏斗比率上限写成 `.max(1)`，导致 `GET /admin/recommendations/metrics` 在真实数据下 500**
  （`ZodError`，实测 `detailViews=9 > impressions=6`）。根因：这些步骤是**各自独立上报的事件计数，不是
  嵌套集合**（曝光有可见性门槛，而 `DETAIL_VIEW` 点进详情就上报；服务端确证事件可以完全没有对应曝光）。
  已去掉 5 个漏斗比率的 `.max(1)`（guardrails 的 5 个 share 保留上界），并在 §3.3/§6.2 写明理由；
  端到端用例里 `expect(metricsResponse.status).toBe(200)` 就是这条回归的护栏。
- **限流阈值与鉴权顺序**：429 必须发生在业务之前，否则「伪造事件」的流量仍会打到 DB。实现里令牌桶在
  契约校验之后、`service.ingest`/`startFeed` 之前扣（`apps/api/src/modules/recommendation/router.ts`），
  端到端用例与 `core:smoke` 都断言了这一点（撞 429 的批不再产生写入）。
