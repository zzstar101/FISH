# Issue #323 R4+R5 — 规则排序、重排与个性化 Feed 接线

> 状态：**已实现，待 zzstar101 审核**（Owner 已评审通过 §2 的决定；**两轮**对抗性审查结论见 §12，实测见 §10.5）
> 上游：R1 `docs/design/issue-323-r1-event-tracking.md`、R2 `docs/design/issue-323-r2-user-interest.md`、R3 `docs/design/issue-323-r3-multi-channel-recall.md`
> 下游：R6（评估与可观测）单独一个 PR

---

## 1. 范围

R3 交付了六路召回与候选合并，但**没有任何生产调用方**：`apps/api/src/app.ts` 没有装配召回，
`GET /recommendations/feed` 仍是 `listings.listFeed({sort:'newest'})` 的透传，`strategyVersion`
恒为 `rec-v1-none`。本 PR 把这条链路接上并补齐排序与重排：

**做**

1. **规则排序（M4）**：纯函数 deterministic ranker，把 `RecallCandidate` 上的现有特征打成一个
   `rankScore`，权重集中定义在契约里、带版本号、可离线复现。
2. **重排（M6）**：在排序结果上做**确定性**的打散与硬约束（同卖家不连续霸屏、同类目不刷屏、
   已隐藏的本次不返回、explore 保留配额），约束无法满足时按固定顺序松弛并计数。
3. **Feed 接线（M7）**：`startFeed` 改为「召回 → 排序 → 重排 → 取卡片」，`strategyVersion`
   写成复合版本串；`app.ts` 装配 `createRecommendationRecall`。
4. **分页真值**：新增服务端快照表 `recommendation_request_items`，一次推荐请求的商品序列
   （含位次、召回来源、排序得分与逐特征明细）落库；游标改为 `{requestId, offset}`。
5. **曝光归因真值**：`POST /recommendations/events` 的 `position` / `source` 一律以快照为准，
   忽略客户端上报；未命中快照时不再编造来源。
6. **收藏/取消收藏的服务端写入路径**：给 favorites router 挂上
   `RecommendationDomainRecorder`（M0 留下的待办，`favorites` 模块 #190 已上 main）。
   `FAVORITE` = +4 是权重表里最强的正信号，只靠客户端上报会整批丢。
7. **降级**：召回、画像、反馈任一步失败都不 500，退到 R1 的 `newest` 透传并如实写
   `strategyVersion = rec-v1-none`。

**不做（本轮明确排除）**

| 项 | 归属 |
| --- | --- |
| `priceAffinity` / `quality` 特征 | 推迟（§11 已知边界）；候选集里没有价格与质量列，加它们要动召回层 |
| 单路召回超时、Bot / 开发预览流量隔离 | R6 |
| 评估指标、离线 fixture 数据集、latency guardrail、快照保留期清理 job | R6 |
| 客户端改动（首页布局、曝光埋点阈值、隐藏名单） | **零改动**；实现中若发现必须改，只报告并另开 issue |
| 在线训练 / DNN / LLM 打分 / 独立向量库 / Redis / Kafka | #323 正文明确不做 |
| 用私有身份字段（邮箱 / 手机号 / 学号 / 微信标识）做推荐特征 | 明令禁止 |

---

## 2. 写进实现的决定

### 2.1 本轮开始前已与 Owner 逐条确认的决定

| # | 决定 | 结论 |
| --- | --- | --- |
| D1 | PR 切分 | R4 + R5 **合成一个 PR**；R6 单独 |
| D2 | 策略版本 | `recommendation_requests.strategy_version` 用**复合字符串单列**，形如 `rec-v1-rule+interest-v1+recall-v1+rank-v1`（41 字符 ≤ 64），不改表不加列；客户端当不透明串 |
| D3 | v1 排序特征 | 只用 `RecallCandidate` 上已有的特征，零新增 IO，ranker 保持纯函数可复现 |
| D4 | 负反馈数据源 | 已落库事件（HIDE / QUICK_SKIP / UNFAVORITE）+ favorites router 接 recorder |
| D5 | 重排机制 | 硬约束 + **固定松弛阶梯**，不引入随机 |
| D6 | 分页 | 服务端快照，游标 `{requestId, offset}`，后续页直接切片 |
| D7 | 归因真值 | 命中快照即取快照的 `position` / `source`，忽略客户端上报；响应不暴露 source / position |
| D8 | 冷启动与降级 | 分级降级、**永不 500**；降级时 `strategyVersion` 退回 `rec-v1-none` |
| D9 | 客户端范围 | 零客户端改动 |
| D10 | 归一化 | **固定饱和变换，与候选集无关**（不吃候选集 max/min） |
| D11 | 权重初值 | `semantic 0.35 / userCategoryAffinity 0.20 / wish 0.15 / freshness 0.15 / popularity 0.15`，正权重和 = 1.00；惩罚项见 D15 |
| D12 | 探索确定性 | 以 `requestId` 为种子的确定性哈希打散，不用 `Math.random()` |
| D13 | 快照列 | `position` + `listingId` + `primarySource` + `sources[]` + `rankScore` + 逐特征明细 |
| D14 | 明细形状 | JSONB 一列 `rank_breakdown`，形状由契约的 zod schema 锁死，写入前校验 |
| D15 | 负反馈口径 | listing 级**硬排除** + 类目 / 卖家级**软惩罚**（-0.30） |
| D16 | 推进节奏 | 先出本文档给 Owner 过一遍，确认后再实现 |

### 2.2 本轮新增、需要 Owner 在本文档里一并确认的细化

这些是上面 16 条落地时必须填的空白，我按「最小改动 + 不编造真值」取舍，**标注出来供评审**：

| # | 细化 | 取舍与理由 |
| --- | --- | --- |
| N1 | 快照总条数上限 `RECOMMENDATION_SNAPSHOT_MAX_ITEMS = 200` | 一个 `requestId` 可被反复翻页，不设上限时一次滚动能写出无界行；上限只为挡住异常长滚，正常单页 ≤ 50（契约上限）。超上限即 `nextCursor = null` |
| N2 | 请求行改为**服务端先生成 `requestId`**，排序全部完成后才写入 | 排序不需要请求行，但重排的探索种子需要 `requestId`；先建行等于先写一个还不知道版本的 `strategy_version`（要么写错、要么补一次 UPDATE） |
| N3 | 新增 `ListingService.listCardsByIds(viewerId, ids)` + `ListingStore.findCardsByIds` | 现有读路径只有 `listFeed` / `getDetail`，没有「按 id 批量取卡片」。复用同一个 `toListingCard`，封面 URL / 价格 / 卖家拼法与 feed / 详情必然一致；additive，不改任何现有调用方 |
| N4 | 降级路径的游标沿用 R1 形状 `{requestId, listingCursor}`，与快照游标**并存** | 降级时翻页要继续走 `listFeed`，只能带底层商品游标；把两种形状做成游标联合类型后，**上线瞬间在途会话的旧游标也自动落进这条分支**，不需要额外的兼容代码 |
| N5 | 排序路径候选不足 `limit` 时**不用 `newest` 补位**，如实返回较短的一页 | `fresh` 本来就是六路召回之一，池子已含它；再把 `listFeed` 的结果混进排序页，这些商品没有快照行、位次与来源都不可归因，直接破坏 D7 |
| N6 | 「未命中快照」分两种情形：请求行版本是 `rec-v1-none`（透传模式）→ 保留 R1 的 `position ?? null` / `source ?? 'fresh'`；否则 → `position = null` + `source = null` | D7 字面写的是"未命中回退 `source='fresh'`"。但在排序模式下把一件不在本页的商品记成 `fresh` 是**编造**归因，而 `null` 在表里本来就表示"这条行为没有推荐上下文" |
| N7 | 逐特征明细里**不存原始输入值**，改为顶层 `missing: RankFeatureKey[]` | D14 锁的形状是每键 `{normalized, weight, contribution}`；`missing` 数组比给每个特征加一个 `input` 字段小得多，又保住了"未知"与"0"的区别（R3 §9 待办①：`alreadySeenCount` 查询失败时静默变 0） |
| N8 | 负反馈的时间窗与半衰期**复用 R2 口径**（`interestLookbackStart(now)` 180 天 + `INTEREST_HALF_LIFE_MS.longTerm`）；三项权重取 `|INTEREST_ACTION_WEIGHTS|` | 语义相同（个体负向态度）就不另立一张表；R3 的 Popular 之所以独立成表是因为它的语义（全站热度）不同 |
| N9 | `resolveIdentity` 从 `recall/service.ts` 提到 `recommendation/identity.ts`，排序侧复用同一个 | 反馈查询与召回必须用同一套身份口径，各写一份必然漂移 |
| N10 | 快照写入失败 → 记日志 + `nextCursor = null`，首页正常返回 | 与"埋点是旁路"同一取舍：已经取到的卡片不该因为写不成快照而变成错误页；代价是这次会话不能翻页 |
| N11 | `createRecommendationService` 增加可选 `clock?: () => Date` | 反馈衰减与 `freshness` 都依赖"现在"，不注入就无法写可复现的单测 |

---

## 3. 契约与常量

新增 `packages/contracts/src/recommendation/rank.ts`（不得建 barrel，走 subpath export
`@fish/contracts/recommendation/rank`）。

### 3.1 版本串

```ts
/** M4 建议的对外总版本名：v1 的排序是规则排序。 */
export const RECOMMENDATION_STRATEGY_VERSION_RULE = 'rec-v1-rule'
export const RECOMMENDATION_STRATEGY_VERSION_SEPARATOR = '+'
/** 排序层的算法版本（权重表或归一化变了就必须 +1）。 */
export const RANK_STRATEGY_VERSION = 'rank-v1'

/**
 * 复合策略版本：`rec-v1-rule+interest-v1+recall-v1+rank-v1`。
 * 段顺序固定（rule → interest → recall → rank），长度上限 64（= 列宽）。
 */
export function composeRecommendationStrategyVersion(
  parts: readonly string[],
  // 实现里用 `[RULE, INTEREST_STRATEGY_VERSION, RECALL_STRATEGY_VERSION, RANK_STRATEGY_VERSION]` 调用
): string
```

**复合串里永远带全部四段**，即使本次是冷启动（无 session / 长期画像）：版本标识的是**流水线**，
不是"这次有没有数据"。冷启动是同一版本下的一条分支，用另一个版本串会让"同输入同版本可复现"
这条不变式失效。

降级时**不进复合串**，直接写 R1 的 `RECOMMENDATION_STRATEGY_VERSION_NONE = 'rec-v1-none'`
（沿用 R1 常量，不改语义）。

### 3.2 特征键与权重

```ts
export const RankFeatureKeySchema = z.enum([
  'semantic',          // M4: semanticAffinity
  'wish',              // M4: wishAffinity
  'category',          // M4: categoryAffinity
  'freshness',         // M4: freshness
  'popularity',        // M4: popularity
  'repeatedExposure',  // M4: repeatedExposurePenalty（负权）
  'negativeFeedback',  // M4: negativeFeedbackPenalty（负权）
])
export const RANK_FEATURE_KEYS = RankFeatureKeySchema.options

/** v1 初值，待 R6 用离线评估调；改这里必须同时改 `RANK_STRATEGY_VERSION`。 */
export const RANK_FEATURE_WEIGHTS: Record<RankFeatureKey, number> = {
  semantic: 0.35,
  category: 0.20,
  wish: 0.15,
  freshness: 0.15,
  popularity: 0.15,
  repeatedExposure: -0.20,
  negativeFeedback: -0.30,
}
```

正权重和 = 1.00，两个惩罚各占一格 `[0,1)` 的归一化值 ⇒ **得分域 `[-0.50, 1.00]`**。

### 3.3 归一化常数

```ts
/** popularity → p / (p + K)：14 天加权行为数的半饱和点。 */
export const RANK_POPULARITY_HALF_SATURATION = 5
/** 重复曝光 n / (n + K)：已曝过 2 次就吃掉一半惩罚。 */
export const RANK_REPEATED_EXPOSURE_HALF_SATURATION = 2
/** 负反馈衰减计数 c / (c + K)。 */
export const RANK_NEGATIVE_FEEDBACK_HALF_SATURATION = 2
```

三个都是**饱和变换**而非 min-max：饱和点与候选集无关，所以同一件商品在不同候选集里得分相同，
"同一 requestId 重放得到同一结果"才成立（D10）。

### 3.4 负反馈与隐藏

```ts
/** 触发类目 / 卖家级软惩罚的事件类型（权重取 `|INTEREST_ACTION_WEIGHTS[t]|` = HIDE 3 / UNFAVORITE 2 / QUICK_SKIP 0.5）。 */
export const RANK_NEGATIVE_FEEDBACK_EVENT_TYPES = ['HIDE', 'UNFAVORITE', 'QUICK_SKIP'] as const
/** 触发 listing 级硬排除的事件类型（M6：已划走 / 隐藏的内容不重复推荐）。 */
export const RANK_HIDDEN_EVENT_TYPES = ['HIDE'] as const
```

窗口与半衰期**不在这里定义**：用 `interestLookbackStart(now)` 与 `INTEREST_HALF_LIFE_MS.longTerm`（N8）。
选择 180 天窗是为了与客户端本地隐藏名单的 180 天 TTL
（`apps/miniapp/src/features/recommendation/hidden.ts`）对齐。

### 3.5 重排常数

```ts
/** 同一卖家两次出现之间至少隔 1 件别的商品（= 间隔 ≥2 位）。 */
export const RERANK_SELLER_MIN_GAP = 2
/** 同类目滑动窗口长度与窗口内上限：连续 3 位里同类目 ≤2 条。 */
export const RERANK_CATEGORY_WINDOW = 3
export const RERANK_CATEGORY_MAX_IN_WINDOW = 2
/** explore 配额：每 5 位至少 1 位来自 explore 通道 ⇒ 占比 ≥20%。 */
export const RERANK_EXPLORE_WINDOW = 5
export const RERANK_EXPLORE_MIN_PER_WINDOW = 1
/** 固定松弛顺序：先让探索配额，再让类目窗，最后才让卖家间隔。 */
export const RERANK_RELAXATION_ORDER = ['explore', 'category', 'seller'] as const
```

松弛顺序的理由：探索配额是**平台目标**（给新商品/新卖家曝光），让掉只是这一页少一点探索；
类目窗是**体验约束**，让掉会让同类目连出；卖家间隔最接近"霸屏"，最后才让。

### 3.6 明细形状（`rank_breakdown`）

```ts
export const RankFeatureContributionSchema = z.strictObject({
  /** 归一化后的特征值，恒在 [0,1]。 */
  normalized: z.number().min(0).max(1),
  weight: z.number(),
  /** `normalized * weight`，落库时按此值存（保留浮点原值，不做四舍五入）。 */
  contribution: z.number(),
})

export const RankScoreBreakdownSchema = z.strictObject({
  semantic: RankFeatureContributionSchema,
  wish: RankFeatureContributionSchema,
  category: RankFeatureContributionSchema,
  freshness: RankFeatureContributionSchema,
  popularity: RankFeatureContributionSchema,
  repeatedExposure: RankFeatureContributionSchema,
  negativeFeedback: RankFeatureContributionSchema,
  /** 特征缺失（不是 0）的键：冷启动无 semantic、`alreadySeenCount` 未知等。 */
  missing: z.array(RankFeatureKeySchema),
})
```

写入前用 `RankScoreBreakdownSchema.parse(...)` 校验（D14）。

### 3.7 快照上限

```ts
/** 一个推荐请求最多落多少行快照（N1）；超出即 nextCursor = null。 */
export const RECOMMENDATION_SNAPSHOT_MAX_ITEMS = 200
```

---

## 4. 数据层

### 4.1 新表 `recommendation_request_items`

`packages/db/src/schema/recommendation-request-items.ts`：

```ts
export const recommendationRequestItems = pgTable(
  'recommendation_request_items',
  {
    ...primaryKey(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => recommendationRequests.id, { onDelete: 'cascade' }),
    /** 0 起的全局位次，跨页连续；与事件的 `position` 同一口径。 */
    position: integer('position').notNull(),
    listingId: uuid('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    /** `recallSources[0]`：按 `RECALL_CHANNEL_PRIORITY` 排过的首要通道。 */
    primarySource: recommendationSourceEnum('primary_source').notNull(),
    /** 全部召回来源，顺序即优先级（≤ `RECALL_MAX_SOURCES_PER_CANDIDATE`）。 */
    sources: recommendationSourceEnum('sources').array().notNull(),
    rankScore: doublePrecision('rank_score').notNull(),
    rankBreakdown: jsonb('rank_breakdown').$type<RankScoreBreakdown>().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('recommendation_request_items_position_uq').on(table.requestId, table.position),
    index('recommendation_request_items_request_id_idx').on(table.requestId),
  ],
)
```

要点：

- **`request_id` 建外键**（与 `recommendation_events.request_id` 刻意不建外键相反）：快照行与请求行
  同生共死，请求上下文被清理时快照必须一起走，否则留下的位次没有任何可解释的主体。
- **`listing_id` 用 CASCADE**：与 `recommendation_events.listing_id` 一致 —— 商品物理删除
  （`deleteListingAtomic` 的「不过审可删，不保留痕迹」）后，推荐位次不该还能反查出商品。
- **不存卡片快照**（标题/价格/封面）：那是"商品内容"，内容变了就该看到新的；快照固定的是
  **序列与位次**，不是商品本身。
- `position` 唯一约束保证"同一请求内每个位次最多一件商品"。不额外约束 `listing_id` 唯一：
  理论上同一请求不会重复推同一件商品，但去重是排序层的职责，库层再加一条约束只会把
  排序层的 bug 变成 500。

### 4.2 快照读写（`apps/api/src/modules/recommendation/store.ts`）

`RecommendationStore` 增两个方法，`createSqlRecommendationStore` 实现：

```ts
/** D6/N2：显式带 id 建请求行（版本串此时已知）。 */
createRequest(input: {
  id: string                     // 新增：服务端先生成（`newId()`），排序完成后才写行
  userId: string | null
  anonymousSessionId: string | null
  strategyVersion: string
}): Promise<RecommendationRequestRow>

/** 写一页快照。`position` 由调用方给出，本层不重编号。 */
insertRequestItems(records: RecommendationRequestItemRecord[]): Promise<void>

/** 按位次升序取**整份**快照（`requestId` 一条请求最多 200 行）。 */
findRequestItems(requestId: string): Promise<RecommendationRequestItemRow[]>
```

另有一个给归因用的批量查询（§8），也挂在同一层：

```ts
/** (requestId, listingId) → 位次与首要来源；两个条件都进 `WHERE`，返回两批输入的笛卡尔超集中的
 *  现有行（调用方按键取，多余行无害）。 */
findRequestItemAttribution(input: {
  requestIds: readonly string[]
  listingIds: readonly string[]
}): Promise<{ requestId: string; listingId: string; position: number; primarySource: RecommendationSource }[]>
```

**实现期细化**（与上面伪码的三处差异，见 §7.6）：`insertRequestItems` 返回 `void`（调用方不用
"实际写入行数"，写了就是全写，冲突直接抛）；`findRequestItems` 不收 `offset`/`limit`，由服务层在
内存里 `slice`（上界 200 行，不值得再加一个查询形状）；`findRequestItemAttribution` 的
`listingIds` 必须真下推 —— 否则最坏会把 50 个请求的整份快照（50 × 200 行）拉回来再在内存里挑。

行数上界与索引口径：`requestIds` 与 `listingIds` 都来自**一批 ≤50 条事件**，且请求行必须通过
`ownsRequest` 才会被查。两个条件都进 `WHERE`，键不可能落在输入之外；但只有 `request_id` 有索引
（`recommendation_request_items_request_id_idx`，同时也是唯一索引 `(request_id, position)` 的前缀），
**`listing_id` 不在任何索引键里** —— 商品条件是取回行之后的过滤，索引扫描仍覆盖这 ≤50 个请求的整份
快照（上界 50 × 200），被压下来的是**返回**行数（上界 50 请求 × 本批商品数 ≤ 事件条数）。要让商品
条件也走索引得补 `(request_id, listing_id)` 复合索引；当前规模（每请求 ≤200 行、`requestIds` ≤50）
不值得，留作已知边界（§11）。

### 4.3 召回侧新增两个查询（`packages/db/src/recall-store.ts`）

```ts
/** 负反馈原始事件：窗口内的 HIDE / UNFAVORITE / QUICK_SKIP，带商品类目与卖家。 */
export async function findNegativeFeedbackEvents(
  db: Db,
  input: { identity: InterestIdentity; since: Date },
): Promise<{ listingId: string; category: ListingCategory; sellerId: string; eventType: RecommendationEventType; occurredAt: Date }[]>
```

- 放在 `recall-store.ts` 而不是新文件：它和 `countListingImpressions` 是同一族
  （给召回/排序喂候选级统计），且 R3 已经把这类查询集中在这里。
- 身份谓词沿用 R2 的口径：`{kind:'user'}` 比 `user_id`，`{kind:'anonymous'}` 比
  `anonymous_session_id`，**不跨身份合并**。
- join `listings` 取 `category` / `seller_id`：`recommendation_events.listing_id` 是
  `ON DELETE CASCADE`，所以不会出现孤儿事件，join 不会丢行（商品被删时事件本身也没了）。
- 索引：`recommendation_events_session_id_occurred_at_idx` 与
  `recommendation_events_user_id_occurred_at_idx` 已经覆盖这个谓词，**本轮不加索引**。

### 4.4 `alreadySeenCount` 放宽为 `number | null`

R3 §9 待办①：`countListingImpressions` 失败时 `alreadySeenCount` 静默变 0，
把"未知"伪装成"一次都没看过"，直接少给惩罚。本轮：

- `apps/api/src/modules/recommendation/recall/types.ts` 的 `RecallCandidate.alreadySeenCount`
  改为 `number | null`；
- `recall/service.ts` 的捕获分支（`visibilityFailed` 同款的降级路径）写 `null` 而不是 0；
- 排序层 `null → normalized = 0` 且把 `repeatedExposure` 记进 `missing`。

`merge.ts` 只是透传该字段，若类型收窄处需要默认值，一律用 `null`。

---

## 5. 排序（M4）

`apps/api/src/modules/recommendation/rank/score.ts`，纯函数，无 IO：

```ts
export type RankedCandidate = {
  candidate: RecallCandidate
  rankScore: number
  breakdown: RankScoreBreakdown
}

export function scoreCandidates(input: {
  candidates: readonly RecallCandidate[]
  feedback: NegativeFeedbackSignals
  now: Date
}): RankedCandidate[]
```

`NegativeFeedbackSignals`（`rank/feedback.ts` 的产物，见 §5.3）：

```ts
export type NegativeFeedbackSignals = {
  /** listing 级硬排除（D15），由重排消费。 */
  hiddenListingIds: ReadonlySet<string>
  /** 类目 → 已归一化的软惩罚 [0,1)。 */
  categoryPenalty: ReadonlyMap<string, number>
  /** 卖家 → 已归一化的软惩罚 [0,1)。 */
  sellerPenalty: ReadonlyMap<string, number>
}
```

### 5.1 逐特征归一化

| 键 | 原始来源 | 归一化 |
| --- | --- | --- |
| `semantic` | `candidate.semanticScore`（`1 - 余弦距离`，约 `[-1,1]`） | `clamp01(x)`，`null → 0` + `missing` |
| `wish` | `candidate.wishScore`（`matches.score`，**0–100**） | `clamp01(x / 100)`，`null → 0` + `missing` |
| `category` | `candidate.userCategoryAffinity`（R3 已归一到 `[0,1]`） | 原值，`null → 0` + `missing` |
| `freshness` | `candidate.freshness`（R3 `0.5 ** (age/半衰期)`） | 原值（已在 `[0,1]`） |
| `popularity` | `candidate.popularity`（14 天加权行为数） | `p / (p + RANK_POPULARITY_HALF_SATURATION)`，`null → 0` + `missing` |
| `repeatedExposure` | `candidate.alreadySeenCount` | `n / (n + RANK_REPEATED_EXPOSURE_HALF_SATURATION)`，`null → 0` + `missing` |
| `negativeFeedback` | `max(categoryPenalty[category] ?? 0, sellerPenalty[sellerId] ?? 0)` | 信号本身已归一化 |

`clamp01` 是**负值截断**：`semanticScore` 可以是负数（余弦距离 >1），负相似度没有"负贡献"的语义，
直接截到 0，避免"semanticScore = -1 + 满分类目"这种无意义组合。

`contribution = normalized * weight`；`rankScore = Σ contribution`（浮点相加，顺序固定为
`RANK_FEATURE_KEYS` 的顺序）。

### 5.2 排序键

```
rankScore 降序 → listingId 升序
```

第二键必须是确定性的商品 id：`rankScore` 相等时（冷启动下大量候选同分）依赖 `Array.prototype.sort`
的稳定性等于依赖输入顺序，而输入顺序是六路召回各查各的拼接结果（R3 §合并已刻意用
`listingId` 做兜底键）。同键复用同一套兜底。

### 5.3 负反馈信号构造（`rank/feedback.ts`，纯函数）

```ts
export function buildNegativeFeedbackSignals(input: {
  events: readonly { listingId: string; category: string; sellerId: string; eventType: RecommendationEventType; occurredAt: Date }[]
  now: Date
}): NegativeFeedbackSignals
```

1. `hiddenListingIds` = `eventType ∈ RANK_HIDDEN_EVENT_TYPES` 的 `listingId` 去重集合。
2. 对三类负反馈事件按 `weight = |INTEREST_ACTION_WEIGHTS[eventType]| *
   Math.pow(0.5, ageMs / INTEREST_HALF_LIFE_MS.longTerm)`（`ageMs = max(now - occurredAt, 0)`）
   累加到 `byCategory[category]` 与 `bySeller[sellerId]`。
3. 归一化 `c / (c + RANK_NEGATIVE_FEEDBACK_HALF_SATURATION)`，同时截到 `[0, 1)`。
4. 取 `max(类目, 卖家)` 作为该候选的 `negativeFeedback` 特征（一件商品同时踩中两边时**不叠加**：
   软惩罚的口径是"这类内容我不想要"，叠加会让惩罚无界逼近 1）。

### 5.4 权重与得分的可解释性

- 全部数字集中在 `@fish/contracts/recommendation/rank`，实现里**不许出现字面量权重**（M4 要求 4）。
- `rankScore` 与 `breakdown` 一起落库（D13），线上任何一个位次都能回答"它为什么排这里"。
- 权重表改动必须同时改 `RANK_STRATEGY_VERSION`：复合版本串变了，历史请求行才能被区分开（M4 要求 2）。

---

## 6. 重排（M6）

`apps/api/src/modules/recommendation/rank/rerank.ts`，纯函数：

```ts
export function rerankCandidates(input: {
  ranked: readonly RankedCandidate[]      // 已按 §5.2 排好序
  hiddenListingIds: ReadonlySet<string>
  seed: string                            // requestId
  limit: number                           // RECOMMENDATION_SNAPSHOT_MAX_ITEMS
}): {
  items: RankedCandidate[]
  /** 各约束被让掉的次数（观测用，R6 接指标）。 */
  relaxations: Record<'explore' | 'category' | 'seller', number>
  droppedHidden: number
}
```

### 6.1 主循环

```
pool  = ranked 过滤掉 hiddenListingIds
placed = []
while placed.length < limit 且 pool 非空:
  i = placed.length
  needExplore = explorePlaced(placed) < floor((i + 1) / RERANK_EXPLORE_WINDOW)
  pick = select(pool, placed, needExplore, relaxations)
  if pick === null: break        // 理论不可达：三条约束全让掉后任何候选都合格
  placed.push(pick); pool 移除 pick
```

`explorePlaced` = `primarySource === 'explore'` 的已放置条数。
配额判定在**第 5 位**（`i = 4`，`floor(5/5) = 1`）、第 10 位…… 处强制，正好是每 5 位 ≥1 位。

### 6.2 约束与松弛

`select(pool, placed, needExplore, relaxations)`：

- 三条约束：
  - **seller**：`placed` 最后 `RERANK_SELLER_MIN_GAP - 1` = 1 条的 `sellerId ≠ 候选.sellerId`
    （间隔 ≥2 位）；
  - **category**：`placed` 最后 2 条里同类目出现次数 `< RERANK_CATEGORY_MAX_IN_WINDOW`（=2）
    ⇒ 任意连续 3 位同类目 ≤2 条；
  - **explore**：`needExplore` 时要求 `primarySource === 'explore'`。
- 先在 `pool` 里按 **§5.2 的既有顺序**找第一条满足全部约束的候选；
- 找不到就按 `RERANK_RELAXATION_ORDER = ['explore', 'category', 'seller']` 逐个让掉重找，
  每让掉一条就把对应计数器 `+1`；
- 找到即返回（`pool` 中的下标），全部让掉后必然命中第一条 —— 保证循环不会空转。

**explore 候选的选择**：配额强制时，在合格候选里选
`fnv1a32(seed + ':' + listingId)` 最小的那条（`rank/rerank.ts` 内的纯函数，无依赖）。
用哈希而不是取 `rankScore` 最高的那条：取最高分等于每页都推同一批新商品，探索失去意义；
哈希以 `requestId` 为种子，**同一请求重放结果相同**、不同请求会轮换。

### 6.3 不引入随机

全流程无 `Math.random()`（D12）。`requestId` 是服务端 `uuidv7`，天然逐请求不同，
所以"确定性"与"逐请求变化"不矛盾。

---

## 7. Feed 编排、游标与降级

### 7.1 游标

`apps/api/src/modules/recommendation/cursor.ts` 改为判别联合：

```ts
type RecommendationCursor =
  | { kind: 'snapshot'; requestId: string; offset: number }        // 排序模式（D6）
  | { kind: 'passthrough'; requestId: string; listingCursor: string }  // 透传/降级模式（N4）
```

- 编码：`base64url(JSON.stringify(...))`，与 R1 一致（不透明串）。
- 解码：严格校验键集与类型 —— `offset` 为非负整数，`listingCursor` 为非空 string。
  恰好这两个键之一命中才返回，其余一律 `null` → 422。
- **上线兼容（免费）**：R1 发出的旧游标就是 `{listingCursor, requestId}`，正好落进
  `passthrough` 分支。部署瞬间在途会话的下一页继续走 `listFeed`，不会 422。
- `passthrough` 分支不是纯兼容残留：**降级模式下新开的请求也用它**翻页（§7.3）。

### 7.2 首页（无游标）

```
requestId = newId()                       // N2
now       = clock()
sessionId = anonymousSessionId ?? newId(); issued = ...

① recall:  try recall.recall({userId: viewerId, anonymousSessionId: sessionId}) catch → 降级
② feedback: try findNegativeFeedbackEvents + buildNegativeFeedbackSignals catch → 空信号（记日志）
③ ranked  = scoreCandidates({candidates, feedback, now})
④ ordered = rerankCandidates({ranked, hiddenListingIds, seed: requestId, limit: 200})
⑤ cards   = await listings.listCardsByIds(viewerId, ordered.map(c => c.listingId))
            按 ordered 顺序重排，取不到卡片的（此刻已不可见）跳过          // N3
⑥ slice   = ordered 前 min(cards.length, limit) 条                       // N5：不补位
⑦ request = store.createRequest({id: requestId, ..., strategyVersion: 复合串})
⑧ try store.insertRequestItems(slice 的快照行) catch → 记日志 + nextCursor = null   // N10
⑨ 响应：items = slice 的卡片；nextCursor = slice 长度 < limit 或已到上限
         ? null : encode({kind:'snapshot', requestId, offset: slice.length})
```

`strategyVersion` = `composeRecommendationStrategyVersion([RULE, INTEREST_STRATEGY_VERSION,
RECALL_STRATEGY_VERSION, RANK_STRATEGY_VERSION])`。

`position` 的口径与 R1 一致：**跨页连续的 0 起全局序号**，所以第二页首条的 `position` 等于
第一页条数（即 `offset`）——快照表的 `position` 直接落这个值，`offset` 与 `position` 同源。

### 7.3 降级（D8）

降级只在 ①② 两步发生，之后的路径完全不变：

```
recall 抛错 / RecallResult 不可用 → strategyVersion = rec-v1-none
   page = await listings.listFeed(viewerId, {sort:'newest', limit, cursor?})   // 现有 R1 代码
   request = store.createRequest({id: requestId, ..., strategyVersion: rec-v1-none})
   不写快照
   nextCursor = page.nextCursor === null ? null
              : encode({kind:'passthrough', requestId, listingCursor: page.nextCursor})
```

- `listFeed` 抛 `ListingServiceError(VALIDATION_FAILED)` → 转 422（R1 已实现，保留）。
- 反馈查询失败**不降级整条链**：只是这一页没有软惩罚（`hiddenListingIds` 为空）。
  理由：负反馈是增益项，召回已经成功，不该因为一个统计查询失败把个性化整页退掉。
- `listCardsByIds` 抛错 → 不降级：此时 `requestId` 还没落行、也没有任何可归因的真值，
  按 R1 的失败面处理（500）。这是本轮唯一保留的"硬失败"。

### 7.4 后续页（带游标）

```
decode(cursor)
  失败 → 422（`invalidCursor()`，与 R1 同一处置）
  findRequests([requestId]) → 不存在或 ownsRequest 不过 → 422
  **形状与请求行的策略必须一致**（见下），不一致 → 422
  passthrough → listFeed(sort:'newest', cursor: listingCursor, limit)
                响应 strategyVersion 取请求行的值；nextCursor 继续用 passthrough 形状
  snapshot    → rows = store.findRequestItems(requestId)
                取 offset 之前已跳过的可见性复核？—— 不做：见下
                slice = rows.slice(offset, offset + limit)
                cards = listings.listCardsByIds(viewerId, slice.map(r => r.listingId))
                逐条按 slice 顺序组装，取不到卡片的**跳过且不补位**（快照冻结）
                nextCursor = offset + slice.length < rows.length ? encode({offset: offset + slice.length}) : null
```

**形状必须与请求行当时实际走的策略匹配**（`service.startFeed`）：

- `passthrough` 只对 `rec-v1-none` 的请求行有效；
- `snapshot` 只对排序模式的请求行有效。

不匹配一律 422。理由是这条链路只有一个出口能保证"发出去的卡片都有快照行"：客户端只要自造一个
`{listingCursor, requestId}`（= R1 的旧形状，恰好两个键），就能把一次**排序**请求带去 newest 透传，
那一页的卡片没有快照行，它们随后的 `IMPRESSION` 会被归因层按 `attribution_not_found` 逐条拒收 ——
用户侧表现为自己的曝光数据丢失。反向的 `snapshot` 游标指向降级请求则只会翻出空页，同样按坏游标拒。

这条校验**不误伤在途游标**：R1–R3 期间写进 `recommendation_requests.strategy_version` 的值恒为
`rec-v1-none`（HEAD 版 `service.ts:148` 是唯一写入点），所以旧游标解码成 passthrough 后仍然匹配。

两个刻意的取舍：

1. **跳过不可见的不补位**：快照是"这次推荐请求曾经承诺过的序列"，翻页时商品可能被下架/卖出。
   补位就要从调度器里现算新候选，等于第二页换了一套排序，`position` 的连续性也就断了。
2. **`rows.length < limit` 即终止**：快照行数是有限的，最后一段自然短。

### 7.5 短路保护

- `limit > RECOMMENDATION_SNAPSHOT_MAX_ITEMS - offset` 时，只取到上限为止并给 `nextCursor = null`。
- 空快照（写了请求行但没写进快照行）：返回 `items: []` + `nextCursor: null` 的 200，而不是 422 ——
  游标形状与策略都合法，只是这次没有内容。注意**降级请求带 `snapshot` 游标是另一回事**：那不是
  空快照，而是形状与策略不匹配的伪造游标，按 §7.4 一律 422。

---

### 7.6 实现期细化（与 §7.2 / §7.4 伪码的差异）

伪码只是决策的载体，落地时有六处口径需要收紧或改写，逐条记在这里（**已实测**，见 §10.5）：

1. **只查本页真正要发的卡片**。伪码 ⑤ 把 `ordered` 的全部（≤200）id 交给
   `listings.listCardsByIds`；实现改成只查 `ordered.slice(0, limit)`。原因是伪码 ⑥
   「`ordered` 前 `min(cards.length, limit)` 条」会把**取不到卡片的 id 也塞进 `items`**
   （`cards` 是个 Map，`cards.length` 数的是可见条数，与 `ordered` 的下标不是一回事）。
   实现按 N5 / §7.4 的既有口径统一为：**取到什么就发什么，不足 `limit` 不补位**。
   快照行 = `[本页真正取到的卡片（按 `ordered` 顺序）] ++ ordered.slice(limit)`，于是
   `position` 仍是"真正发出去的顺序"的 0 起连续序号（§7.2 的口径得以保持）。
   推论：本页 `ordered[0..limit-1]` 里取不到的候选**不进快照** —— 它既不占 `position`，
   也不会在后续页冒出来，这正是 N5「不补位」。
2. **`findRequestItems` 不带 `offset` / `limit`**：快照单请求 ≤ `RECOMMENDATION_SNAPSHOT_MAX_ITEMS`
   行，服务层在内存里 `slice(offset, offset + limit)`。少一个查询形状，也免掉 SQL 层
   `offset` 的边界口径。
3. **`createRequest` 必须自带 `id`**。DB 侧本来用 `default sql\`uuidv7()\`` 生成 id，但
   `requestId` 要在**排序之前**就作为重排的 `seed`（§6.3）用上，所以 N2 再往前挪一步：
   id 由服务端先生成 → 排序 → 才落请求行。
4. **`insertRequestItems` 失败 → 记日志 + `nextCursor = null`**（N10 落地）。表上的
   `recommendation_request_items_position_uq` 没有 upsert 语义（`insertRequestItems` 刻意
   不加 `onConflictDoNothing`），重复写会抛 unique violation；service 不重试、也不吞掉
   已发出的 `items` —— 首屏是有效的，只是这次不能翻页。
5. **`rerankCandidates` 的返回形状**：实现返回
   `{items, summary: {inputCount, droppedHidden, droppedOverflow, relaxations}}`（§6 只写了
   `{items, relaxations, droppedHidden}`）。`summary` 全部是**观测用的计数**，调用方只用 `items`；
   收紧成子对象是为了让"重排做了什么"在日志/排查时一眼可见，不影响任何排序决策。
6. **`recallSources[0]` 是快照构造的隐式前提**：`buildSnapshotRows` 在
   `candidate.recallSources[0] === undefined` 时 `continue`（跳过该行）。若这种候选恰好已在
   `servedIds` 里，就会出现"卡片发出去了但没有快照行 + 游标 offset 多跳一行"的错位。
   当前**不可达**：`recall/merge.ts` 的合并去重保证每条候选至少一个召回来源
   （`rank/rerank.ts` 也按此写注释）。这是一条需要保持的不变量，不是可选的优化。

---

## 8. 归因真值（D7）

`ingest` 在批量查询里增加一次 `findRequestItemAttribution({requestIds, listingIds})`（§4.2），
得到 `Map<'${requestId}:${listingId}', {position, primarySource}>`。逐条事件的 `position` / `source`：

| 情形 | `position` | `source` |
| --- | --- | --- |
| 有 `requestId`，命中快照行 | 快照的 `position`（**忽略客户端上报**） | 快照的 `primarySource` |
| 有 `requestId`，未命中，且请求行版本 = `rec-v1-none` | `event.position ?? null`（R1 行为） | `event.source ?? 'fresh'`（R1 行为） |
| 有 `requestId`，未命中，且请求行版本 ≠ `rec-v1-none` | `null` | `null`（N6：不编造来源） |
| 无 `requestId` | `null` | `null` |

> **实现偏离（已实测，见 §10.5）**：第三行只对**非曝光类**事件成立。`IMPRESSION` / `QUICK_SKIP`
> 被库里的 `recommendation_events_impression_requires_attribution` CHECK 约束要求"必须带
> `requestId` 且 `position` 非空"；排序模式下拿不到快照行就意味着服务端**无法证明这条曝光真的
> 发生过**，所以 `ingest` 直接**逐条拒收**（`rejected` + 日志原因 `attribution_not_found`），
> 而不是写一条会撞 CHECK 的记录 —— 撞 CHECK 会让**整批 INSERT 单条语句**一起失败，连带丢掉
> 同批其它合法事件。见 `apps/api/src/modules/recommendation/service.ts:513-521`。

- 命中即最高优先级，客户端上报的 `position` / `source` **完全作废**。这样"服务端曝光归因真值"
  才成立：客户端不再需要知道召回通道，也就无从伪造。
- `source = null` 的行不进任何通道统计（R6 的分路评估按 `source IS NOT NULL` 归集）。
- 响应形状不变：`RecommendationFeedResponseSchema` 仍不暴露 `source` / `position`。
- `recordDomainEvent` 路径（评论/会话/交易）的 `context.position` / `context.source`
  **同样以快照为准**：它读的 `RecommendationContext` 来自请求头，与客户端上报同源，
  没有理由比 ingest 更可信。
- 一处**刻意的口径差异**：`recordDomainEvent` 的 `rec-v1-none` 分支取 `source = context.source`，
  **不补** `?? 'fresh'`（客户端事件路径 `ingest` 才补，`service.ts` 的 `?? 'fresh'`）。原因是
  `fresh` 是"召回通道"的名字：服务端确证事件（收藏/评论/会话/交易）经常不带任何推荐头，此时
  补一个 `fresh` 会凭空造出一条通道归因，直接污染 R6 的分路统计；留 `null` 才是真值
  （"这次行为与推荐无关"）。R1 起就是这个口径，本轮没有改动它。

契约侧不变：`RecommendationEventInputSchema` 的可选 `position` / `source` 字段保留（老客户端
继续发），只是服务端不再采信。

---

## 9. 迁移

- 一条新迁移，只建 `recommendation_request_items` 与它的两条索引 + 两个外键，
  **不改任何现有表**（`strategy_version` 已是 `varchar(64)`，够放 41 字符的复合串）。
- 迁移文件由 `bun run --filter '@fish/db' generate` 生成，**不手改**
  （`packages/db/src/migrations/**` 是 AGENTS.md 明令的生成物）。
- 表名/列名与既有推荐域一致（`recommendation_` 前缀 + `timestamptz` + `createdAt()`）。

---

## 10. 验证计划

按 AGENTS.md 的顺序：相关测试 → `bun run typecheck` → `bun run lint` → `bun test --isolate` → 运行时实跑。

### 10.1 环境

- worktree：`/Users/zzstar/Developer/Programs/FISH-323-r45`（分支 `feat/323-r45-personalized-feed`）
- 验证库：`fish_323_r45`（`create database` + `bun run db:migrate` + `bun run db:seed`）
- `.env` 从其它 worktree 复制（gitignore 且缺它会有约 20 条无关失败）

### 10.2 必须新写的用例

| 层 | 用例 |
| --- | --- |
| contracts | 复合版本串拼装结果与长度上界；权重表正权重和 = 1.00；`RANK_FEATURE_KEYS` 与权重表键集一致；`RankScoreBreakdownSchema` 拒绝缺键 / 越界 `normalized` / 未知键 |
| score（纯） | 每个特征单独变化时 `rankScore` 单调；`semanticScore = -1` 被截断到 0；`wishScore = 100` → 1.0；`alreadySeenCount = null` → `missing` 含 `repeatedExposure` 且不加惩罚；同分时按 `listingId` 升序；同一输入两次调用结果完全相同 |
| feedback（纯） | HIDE 进 `hiddenListingIds`；HIDE/UNFAVORITE/QUICK_SKIP 进类目与卖家计数；权重相对大小 `HIDE > UNFAVORITE > QUICK_SKIP`；衰减随时间单调下降；类目与卖家取 `max` 不叠加 |
| rerank（纯） | 同卖家在间隔 2 位内不出现；任意连续 3 位同类目 ≤2；每 5 位至少 1 位 explore；全 explore 的候选集不因配额而重复；隐藏商品被丢弃且 `droppedHidden` 正确；约束不可满足时按 `explore → category → seller` 顺序松弛且计数正确；同一 `seed` 两次结果相同、不同 `seed` 的 explore 选择不同；`limit` 截断 |
| store | `createRequest` 显式 id；`insertRequestItems` 批次写入与 `position` 唯一约束冲突行为（重复写同 `(requestId, position)` 直接抛）；`findRequestItems` 按 `position` 升序回整份快照（切片在服务层）；`findRequestItemAttribution` 的 `listingIds` 真的下推（只问某商品时不会回别的行）且只回批次内组合。注：空入参两条断言是**契约级**的（drizzle 对空数组本身也会生成 `false`，故它们不保护早返回——见 §12.3） |
| listings store | `findCardsByIds` 复用公开可见性谓词（`ACTIVE` + `APPROVED` + 未治理下架 + 非本人），返回形状与 `listFeed` 一致 |
| service | **修复前会失败**的用例：① 排序成功时 `strategyVersion` 是复合串且 `rec-v1-none` 不再出现；② 召回抛错 → 200 + `rec-v1-none` + 走 `newest`；③ 第一页写快照、第二页从快照切且 `position` 连续；④ 快照里已不可见的商品在第二页被跳过且不补位；⑤ ingest 带伪造的 `position` / `source` → 落库值等于快照值；⑥ 排序模式下未命中快照 → `position`/`source` 为 `null`；⑦ 透传模式下 `source` 仍补 `fresh`；⑧ 旧形状游标（`{listingCursor, requestId}`）继续可用；⑨ 游标形状与请求行策略不匹配 → 422（排序请求 + passthrough、降级请求 + snapshot 各一条）；⑩ 降级透传路径的坏内层游标 → 422 而不是 500（**回归护栏**：HEAD 已有同一捕获，本轮只是把它搬进 `serveByNewest`，不计入新增覆盖）；⑪ 降级请求（`rec-v1-none`）的服务端确证事件按上下文头落 `position`/`source`；⑫ 排序请求的服务端确证事件取**快照真值**、忽略伪造的上下文头（`recordDomainEvent` 的归因分支） |
| favorites | 收藏 / 取消收藏后 `recommendation_events` 出现 `FAVORITE` / `UNFAVORITE` 且带归因上下文；埋点写失败不影响收藏接口 200 |

### 10.3 运行时实跑

- 起本地 api，真实调 `GET /recommendations/feed`：种子库有商品的类目与行为时，
  返回顺序与 `sort=newest` **明显不同**（否则说明召回/排序没接上）；
- 连翻两页，核对第二页首条 `position` 与数据库 `recommendation_request_items` 一致；
- 传一个 `source` / `position` 全错的曝光事件，回查落库值；
- 把召回依赖（embedding provider）指向空值，确认降级到 200 + `rec-v1-none`。

### 10.4 独立复现

按 R1/R2/R3 惯例，另开一个全新子代理（只给改动范围与需求，不给思路、可疑点、结论）做对抗性
审查，结论记进 §12。

### 10.5 实测结果

**测试与静态检查**（worktree `/Users/zzstar/Developer/Programs/FISH-323-r45`，验证库 `fish_323_r45`）

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 9 个包全过 |
| `bun run lint`（`biome check .`） | 0 error / 4 warning，4 条都是既有的（`apps/api/src/modules/listings/service.test.ts:1762`、`:1769`、`:1924` 的 `noNonNullAssertion`，`apps/api/src/modules/moderation/store.test.ts:195` 的未用参数） |
| `bun test --isolate`（全量） | 3331 pass / 6 fail。其中 **5 个在 pristine HEAD 上同样失败**（`git stash push -u` 后实测 3241 pass / 5 fail）：`refreshEmbeddingSourceVersion`、`候选向量新鲜度 ×2`（`apps/worker/src/jobs/matching/engine.test.ts`）、`EMBED_LISTING > 编辑 title/description 后重算`、`EMBED_WISH > 编辑 keyword 后重算`。第 6 个 `packages/db/src/migrations.217.test.ts` 的「#217 旧数据无损补号、v4 愿望及引用迁到 v7」是 5 s 超时 flake（在本分支单跑 2 次都 1 pass / 0 fail） |
| 测试规模 | 基线 3246 tests / 310 files → 本分支 3337 tests / 316 files（+91 个新用例） |

**既有 flaky 的根因**（与 #323 无关，只报告不修）：`packages/db/src/embeddings.test.ts:706` 的
`refreshEmbeddingSourceVersion：只把"内容仍然对得上"的向量推进到实体当前版本` 连跑 3 次得
**2 fail / 1 pass**。`packages/db/src/embedding-store.ts:423-441` 用
`lt(embeddings.sourceUpdatedAt, input.sourceUpdatedAt)`，而 `sourceUpdatedAt` 取的是
`listings.updatedAt`（`currentListingVersion`，`packages/db/src/embedding-store.ts:539-547`）；
`packages/db/src/schema/common.ts:27-31` 的 `updatedAt()` 带 `.$onUpdate(() => new Date())`
—— 更新与"插入时记下的版本"落在**同一毫秒**时 `lt` 为假、函数返回 `false`。在该测试里插一个
额外 `db.select(...)`（多一次 round-trip）后**稳定通过**，实得
`source_updated_at = 05:23:47.392Z < updatedAt = 05:23:47.410Z`。

**`bun run core:smoke`**（`.github/workflows/ci.yml:452` 由 `needs.changes.outputs.smoke` 门禁）：
**`[core-smoke] ok — 1 轮全部通过，共 273 项断言（26346ms）`**，含改写后的 R4/R5 小节。
首跑失败在**更后面的**「Wish 与双向匹配」步骤（`EMBED_LISTING` 20 s 超时）：根因是本地 `.env`
（gitignored、从别的 worktree 复制）里的 `EMBEDDING_TRANSPORT=live` + `text-embedding-v4`
（DashScope 该模型返回 **1024** 维，仓库期望 `EMBEDDING_DIMENSIONS=1536`，worker 日志
`embedding 上游返回 1024 维，本服务期望 1536 维`）。按 `.env.example` 的本地口径把
`EMBEDDING_TRANSPORT` 改成 `stub` 后全绿。**`.env` 是本地文件，未提交。**

**手动起真 API 的运行时实跑**（库 `fish_323_manual` = create + migrate + seed，端口 4401）

| §10.3 项 | 实测 |
| --- | --- |
| Feed 顺序 ≠ `sort=newest` | `GET /recommendations/feed?limit=2` → `strategyVersion = rec-v1-rule+interest-v1+recall-v1+rank-v1`，首条 = 罗技 K380 机械键盘；`GET /listings?sort=newest` 首条 = 匡威 1970s 帆布鞋 ⇒ 顺序明显不同 |
| 翻页 `position` 与快照一致 | 首页 `requestId = 01a0fb13-01c9-7682-90f5-cda749816c54`；`recommendation_request_items` 4 行、`position` 0–3 连续、`primary_source` 全 `fresh`；首页两条 = 快照 0/1（`listing_no` 638294017526、709541826303），第二页 = 快照 2/3（872106953482、416829075631），两页 `requestId` 相同、无重复，第二页 `nextCursor = null` |
| 伪造 `source` / `position` | IMPRESSION 上报 `position: 7, source: 'semantic'` → 落库 `position = 2`、`source = 'fresh'`（= 快照真值）；请求发出**之后**新建的商品发 DETAIL_VIEW → 落库 `position = NULL`、`source = NULL`（响应 `202 {accepted:2,duplicates:0,rejected:0}`） |
| 降级 | 空库（`fish_323_empty`，只 migrate 不 seed，端口 4402）：`GET /recommendations/feed` → **200** + `strategyVersion = rec-v1-none` + `items: []` + `nextCursor: null`；请求行 `strategy_version = rec-v1-none`，快照 **0 行** |

- 手动起 API 的两个额外约束：`VISUAL_EMBEDDING_TRANSPORT` 必须显式给（`packages/shared/src/env.ts:436`
  抛 `环境变量校验失败：VISUAL_EMBEDDING_TRANSPORT 必须显式设置为 stub 或 live（无默认值，不允许静默回退）`），
  且 `VISUAL_PARSE_TRANSPORT` 只接受 `off` / `live`（`packages/shared/src/env.ts:477`）——
  本地用 `VISUAL_EMBEDDING_TRANSPORT=stub VISUAL_PARSE_TRANSPORT=off`。
- 「降级是因为召回抛错」这一支在运行时不好自然构造（六路通道各自 `try/catch`，**空候选**才是最接近的
  自然降级态，上表第 4 行验的就是它）；抛错支由 §10.2 的 service 用例②（桩：`recall.recall` 直接
  抛错）覆盖。

**对抗性审查指出 9 条 P3 之后的复验**（§12.2 里标「已修」的 4 条：P3-2 / P3-4 / P3-8 / P3-9）

| 检查 | 结果 |
| --- | --- |
| 相关测试（`modules/recommendation` + `app.recommendation.test.ts` + `modules/listings`） | **271 pass / 0 fail / 1060 expect / 15 files**（11.9s） |
| `apps/api/src/app.recommendation.test.ts` 单跑 | **36 pass / 0 fail / 233 expect**（原 33，新增 3 条：游标形状守卫、降级坏内层游标、`rec-v1-none` 域事件归因） |
| 修复前会失败 | 把守卫临时改成 `if (false) throw invalidCursor()` → 新用例报 `error: expect(received).toBe(expected) / Expected: 422 / Received: 200`（伪造 passthrough 被当成合法 newest 页放行）；随后已还原（`grep -c` 确认） |
| `bun run typecheck` | 9 个包全过（`Exited with code 0`） |
| `bun run lint` | `Checked 1044 files ... Found 4 warnings`（**0 error**；4 条与上表同源、均为既有） |
| `bun run core:smoke`（改动 `service.ts` 后重跑） | **`[core-smoke] ok — 1 轮全部通过，共 273 项断言（24077ms）`** |
| `bun test --isolate`（全量，改动后） | **3336 pass / 4 fail**（3340 tests / 316 files / 75s）；4 个失败全在「上表 5 个既有失败」的毫秒竞态家族内（同一批文件连跑 2 次得 **5 fail**，即该家族本身逐次漂移）⇒ 与本轮改动无关 |

> 上一节表格里的 3331 pass / 6 fail 是**修复前**的全量结果（当时多出的 1 个失败是
> `packages/db/src/migrations.217.test.ts` 的 5 s 超时 flake，本次全量未复现）。

**第二轮复审的 2 条 P3 之后的复验**（§12.3：补 `recordDomainEvent` 排序分支用例 + 修两处索引失实注释）

| 检查 | 结果 |
| --- | --- |
| 相关测试（`modules/recommendation` + `app.recommendation.test.ts` + `modules/listings`） | **272 pass / 0 fail / 1066 expect / 15 files**（12.0s） |
| `apps/api/src/app.recommendation.test.ts` 单跑 | **37 pass / 0 fail / 240 expect**（原 36，新增 1 条：排序请求的域事件归因取快照真值） |
| 修复前会失败 | 把 `service.ts:623` 的 `listingIds: [listingId]` 临时改成 `[]` → 新用例报 fail（**36 pass / 1 fail**，落库 `position`/`source` 变成 `null`）；随后已还原（`grep -c` 确认） |
| `bun run typecheck` | 9 个包全过 |
| `bun run lint` | `Checked 1044 files ... Found 4 warnings`（**0 error**，无自动修复项） |
| `bun test --isolate`（全量） | **3336 pass / 5 fail**（3341 tests / 316 files / 74.9s）；5 个失败全是既有毫秒竞态家族（`refreshEmbeddingSourceVersion`、`候选向量新鲜度 ×2`、`EMBED_LISTING`、`EMBED_WISH`），pristine HEAD 实测同样 5 fail ⇒ 与本轮改动无关 |
| `bun run core:smoke` | **未重跑**：最后一次全绿（273 项断言）之后的改动只有**注释 + 测试**（没有运行时行为变化），故沿用上一行的实测结果 |

---

## 11. 已知边界

1. **`priceAffinity` 与 `quality` 未实现**（Owner 已确认推迟）。M4 的公式里它们两项缺席，
   所以 `rankScore` 不能按 M4 字面公式复现；候选集里根本没有价格与质量列
   （`findVisibleListingRefs` 只回 `listingId/sellerId/category/createdAt`），
   加它们要动召回层与本轮范围无关。
2. **`quality` 的"审核状态"天然被召回层覆盖**：`findVisibleListingRefs` 只放行
   `moderation_status = 'APPROVED'` 的商品，所以"是否过审"不是排序特征而是准入条件。
3. **Popular 通道每次请求实时聚合 14 天事件、无缓存**（R3 §9 遗留）：本 PR 只增加"每次请求
   多一次负反馈查询"，量级变化后的取舍（物化 / 缓存 / 单路超时）归 R6。
4. **快照无保留期清理**：请求上下文保留 90 天，快照随 `request_id` 级联；清理 job 归 R6。
   行数上界：单请求 ≤200 行，`rank_breakdown` 一列约 500 B ⇒ 单请求最坏 ~100 KB 写入。
5. **探索哈希的分布未做统计检验**：只保证"确定性 + 逐请求变化"，是否真的均匀到能覆盖冷门
   商品要靠 R6 的评估。
6. **`passthrough` 游标分支长期存在**（不只上线瞬时）：它是降级模式的翻页机制。若将来降级
   策略改成"降级时不提供翻页"，这个分支才能删。
7. **Bot / 开发预览流量未隔离**（R3 §9 遗留）：它们会以真实身份写曝光与负反馈，污染探索
   与惩罚统计；归 R6。
8. **`alreadySeenCount` 未知时不给惩罚**（R3 §9 待办①的正确处置）：代价是一次查询失败会
   让"重复曝光"惩罚整体失效，但至少不会把未知错当成 0 之后又反过来把 0 当成已知。
9. **权重是拍的初值**（D11）：`semantic 0.35` 等数字没有任何线上数据支撑，必须靠 R6 的离线
   评估与 A/B 迭代；本 PR 只保证它们集中、有版本、可复现。
10. **多目标（M5）只体现在权重上**：`P(detail)` 等目标没有被独立建模，长期目标与 CTR 的
    权衡目前是隐式的权重比。
11. **重复收藏会多记一条 `FAVORITE`**：`favorites` 的唯一索引让**关系**写入幂等，但接口没有把
    "这次是否真的新建了关系"暴露出来（`apps/api/src/modules/favorites/router.ts:120-122`），
    而 `recommendation_events` 只对 `PURCHASE` 有唯一约束（幂等键 `eventId` 每次新生成）⇒
    连续两次 `POST /listings/:id/favorite` 会落两行 `FAVORITE`。收藏是用户主动动作、重复量有界，
    本轮不为此把 favorites store 的返回类型改宽；若将来 `FAVORITE` 进特征权重，要先补幂等。
12. **新增表必须手动登记进 `packages/db/src/seed.ts` 的 TRUNCATE 清单**：漏登记会让 `db:seed`
    直接失败（实测 `PostgresError 0A000`：`recommendation_request_items` 被 `listings` 外键引用，
    提示 `Truncate table "recommendation_request_items" at the same time`）。仓库里只有这一处
    清单，**没有**"schema 表集 vs 清单"的自动化审计。
13. **排序模式下 `IMPRESSION` / `QUICK_SKIP` 未命中快照会被拒收**（§8 的实现偏离）：代价是
    客户端若把曝光挂在错误的 `requestId` 上，事件直接丢失而不是"记为未知来源"；这是 CHECK
    约束下的唯一安全选择（见 §8 的说明）。
14. **归因查询的 `listing_id` 没有索引**：`recommendation_request_items` 只有唯一索引
    `(request_id, position)` 与单列索引 `(request_id)`，`listing_id` 不在任何索引键里 ⇒ 商品条件
    只能回表过滤，索引扫描仍覆盖这些请求的整份快照（上界 50 × 200 = 10 000 行），下推省下的是
    返回行数（§4.2）。当前规模不值得加 `(request_id, listing_id)` 复合索引；若归因查询成为热点，
    加一条即可（纯读路径，无列语义变更）。
15. **快照写失败后自造 `offset` 游标会拿到空页 200（不是 422）**：`createRankedFeed` 在
    `insertRequestItems` 抛错时只置 `nextCursor = null`，请求行的 `strategyVersion` 仍是复合串；
    客户端拿响应里的 `requestId` 自造 `{requestId, offset: 0}` 会通过形状守卫（版本确实是排序模式），
    但快照里没有行 ⇒ `serveFromSnapshot` 回空页 200。无数据损坏（没有快照就没有归因真值，事件也
    不会被误归因），但"服务端这次没能承诺序列"对客户端不可见；彻底修要给请求行加"快照是否写完"
    的标记位（本轮不做）。

---

## 12. 对抗性审查记录

按 §10.4 开了一个**全新子代理**做独立审查：只给改动范围与需求（不给思路、可疑点、结论），
只读、未修改任何仓库文件，且**未提交补丁**。它自己重跑了 5 条命令共 **293 pass / 0 fail**
（`packages/contracts/src/recommendation/rank.test.ts` + `cursor.test.ts` + `rank/` + `recall/merge.test.ts`
= 85 pass；`apps/api/src/modules/recommendation` + `app.recommendation.test.ts` + `modules/favorites`
= 155 pass；`modules/listings/store.test.ts` + `router.test.ts` = 53 pass；`bun run typecheck` 9 包全过；
`bun run lint` 4 warning / 0 error，且 4 条都是改动前就存在的）。

### 12.1 总体结论

**没有 P0 / P1 / P2 缺陷。** 逐攻击面结论：

| # | 攻击面 | 结论 |
| --- | --- | --- |
| 1 | 游标伪造 / 越权 / 旧形状 / 畸形输入 | 通过 |
| 2 | 快照一致性 | 通过（1 处与 §7.2 字面不符，需求歧义） |
| 3 | 归因真值 | 通过 |
| 4 | 降级路径 | 通过 |
| 5 | 排序 / 重排正确性 | 通过（0 缺陷；1 处返回形状偏离） |
| 6 | 数据层 | 有问题（全为契约 / 性能偏离，无数据正确性缺陷） |
| 7 | 身份与越权 | 通过 |
| 8 | 测试质量 | 通过（1 处覆盖空洞） |
| 9 | 范围与工程约束 | 通过 |

它明确写出「尝试过但没能证伪的点」，包括：游标越权（拿别人的 `requestId` 造
snapshot / passthrough 游标都只能拿 422，因为 `ownsRequest` 拦下；**理论上的「双 NULL 身份行」
洞被 `packages/db/src/schema/recommendation-requests.ts:52-56` 的 CHECK
`recommendation_requests_has_identity` 在 DB 层堵死**）、旧 R1 游标兼容（`{listingCursor, requestId}`
恰好 2 键 ⇒ 稳定落 passthrough；配合 §7.4 新增的形状守卫，旧游标只对 `rec-v1-none` 请求行有效，
而在途旧游标对应的行版本恒为 `rec-v1-none`）、`position` 连续性（`position = rows.length` 天然连续、
`nextOffset = offset + slice.length` 严格前进，构造了「首页全不可见」边界仍不死循环）、
快照无重复 `listingId`（`recall/merge.ts` 去重）、`offset > RECOMMENDATION_SNAPSHOT_MAX_ITEMS`
被拒**不误伤**合法游标（合法 offset ≤ 199）、`rank/` 内无 `Math.random`、无第二份权重字面量、
HIDE 在任何权重判断之前就进 `hiddenListingIds`（权重为 0 也仍硬排除）、`feedback === null` 不 NPE、
迁移与 schema 逐列逐约束一致且只有 `CREATE`（无 ALTER）、`jsonParam` 已用、seed TRUNCATE 已含新表、
`varchar(64)` 装得下 41 字符的复合版本串、无新依赖 / 无 `any` / 无 `@ts-ignore` / 无调试代码 /
无 barrel / 无密钥 / 未回退他人改动、`_journal.json` 只在末尾追加 idx 40。
它也**如实披露了自身的独立性限制**：早期一次批量 read 误把 §7.6 正文读入（任务书禁读），
此后未以其为依据，§10/§11/§12 未读。

### 12.2 逐条 P3 与处置

| # | 审查发现 | 处置 |
| --- | --- | --- |
| 1 | `findRequestItems(requestId)` 缺 `{offset, limit}` 下推（`apps/api/src/modules/recommendation/store.ts:231-244`），由 `service.ts:344-346` 内存切片补偿 | **不改代码**，属实现期细化，§4.2 与 §7.6 第 2 条已记录（快照 ≤200 行，内存切片可接受） |
| 2 | `findRequestItemAttribution(requestIds)` 忽略 `listingIds`（`store.ts:246-257`），最坏 50×200 = 10000 行；且无测试 | **已修**：端口与实现改为 `{requestIds, listingIds}` 双条件下推（`store.ts`），`service.ts` 的 `ingest` 传去重后的 `listingIds`、`recordDomainEvent` 传 `{requestIds:[row.id], listingIds:[listingId]}`；`store.test.ts` 补「按商品收窄」与「空入参」用例 |
| 3 | `insertRequestItems` 返回 `Promise<void>` 而 §4.2 写 `Promise<number>`（调用方不用返回值） | **只改文档**（§4.2 记录实际签名） |
| 4 | `packages/db/src/schema/recommendation-request-items.ts:82` 把 `rank_breakdown` 放宽成 `Record<string, unknown>`，同段注释声称「写入方在 API 侧先过 zod 再落库」**不实**（全仓无 `RankScoreBreakdownSchema.parse`） | **已修注释**（说明本包不 import contracts、唯一写入方是 API 排序层、库层只保证 jsonb 对象且必须过 `jsonParam`）；类型放宽本身**保留**并在 §4.2 记录 |
| 5 | `rank/rerank.ts:30-44` 返回 `{items, summary:{…}}` 而 §6 写 `{items, relaxations, droppedHidden}`（调用方只用 `items`） | **不改代码**，§7.6 第 5 条记录（`summary` 只用于观测） |
| 6 | 首页只对 `ordered.slice(0, limit)` 取卡（`service.ts:293-302`）vs §7.2 步骤⑤字面 | **需求歧义**；§7.2 步骤⑥自注「N5 不补位」+ §7.4 支持实现读法，§7.6 第 1 条已记录 |
| 7 | `service.ts:602-604` `recordDomainEvent` 的 `rec-v1-none` 分支不补 `?? 'fresh'`；**无测试** | **口径保留**（§8 已写清理由：凭空造 `fresh` 会污染 R6 通道统计），**补了测试**（`app.recommendation.test.ts`：降级请求 + 上下文头 → 落库 = 上下文的 `position`/`source`） |
| 8 | 自造 `{requestId, listingCursor}` 可让**排序模式**请求走 newest 透传，那页卡片没有快照行、后续曝光被 `attribution_not_found` 拒收 | **已修**：`service.ts` 的 `startFeed` 加形状守卫 `if (degraded !== (decoded.kind === 'passthrough')) throw invalidCursor()`，双向生效；§7.4 补该段与「旧游标行版本恒为 `rec-v1-none`」的兼容性论证；补集成用例（伪造 passthrough 必须是**合法**内层游标，否则断言证明不了守卫——实测去掉守卫后该用例报 `Expected: 422 / Received: 200`） |
| 9 | `packages/contracts/src/recommendation/rank.ts:45-47` 注释写「43 个字符」，实测 41 | **已修**（注释与 §9 都改成 41） |

另有一条**隐式不变量**（当前不可达）：若某条候选的 `recallSources[0]` 为 undefined，
`buildSnapshotRows` 会 `continue`，而它若已在 `servedIds` 里就会出现「发出的卡没有快照行 +
游标 offset 多跳一行」。`recall/merge.ts` 的去重保证 `recallSources` 非空，故不可达；
已作为「必须保持的不变量」写进 §7.6 第 6 条。

审查提出的「风格 / 口味」建议（`rank/score.ts:89` 的 `as` 断言、`rank/rerank.ts:129` 的
`relaxations` 初值字面量、`ingest` 拒收只写日志）**均不采纳**：前者符合 AGENTS.md（不是 `any`），
后两者与需求口径一致。

### 12.3 第二轮审查（P3 修复后的复审）

P3 处置完成并复验通过后，又开了一个**全新子代理**复审（同样只给改动范围与需求、不给思路与结论；
全程只读，所有 mutation 与 SQL 探针都在 APFS clone `/tmp/fishmut` 里做，仓库 `git status --short`
与开始时一致）。**结论：通过，无 P0 / P1 / P2**；4 处改动的语义被逐条证明正确，新发现 2 条 P3，
都属注释准确性与测试覆盖：

| # | 复审发现 | 处置 |
| --- | --- | --- |
| 1 | **排序模式下 `recordDomainEvent` 的归因分支零覆盖**（`service.ts:618-628`）：把 `listingIds: [listingId]` 改成 `[]` 后 `app.recommendation.test.ts` 仍 36 pass / 0 fail | **已补测试**：「排序请求（rank-v1）的服务端确证事件取快照真值，忽略上下文头」——直接建排序请求行 + 快照行（`position: 5`、`primarySource: 'popular'`），收藏时故意上报 `x-recommendation-position: 999` / `x-recommendation-source: fresh`，断言落库 = 快照值；实测把该参数改回 `[]` → 该用例红（36 pass / 1 fail），还原后绿（37 pass） |
| 2 | `store.ts:115-116` 注释称「两个条件都走 `_request_id_idx`（商品条件在索引内过滤）」**不成立**：`listing_id` 不在任何索引键里，商品条件只能回表过滤；`packages/db/src/schema/recommendation-request-items.ts:91-92` 有同样说法 | **已修两处注释**（改成"只有 `request_id` 有索引、商品条件回表过滤、被压下来的是返回行数而非扫描宽度"），索引缺口另写入 §4.2 与 §11 第 14 条 |
| 3 | 排序请求若快照写失败（`service.ts` 只置 `nextCursor = null`，版本仍是复合串），客户端自造 `{requestId, offset: 0}` 会得**空页 200**（不是 422）；非本次引入 | **只记文档**：§11 第 15 条 |
| 4 | `inArray(col, [])` 在 drizzle 0.45.2 下生成 `false`（实测 `where (false and …)` → 0 行）⇒ `store.ts` 的空数组早返回冗余，其两条断言不可证伪 | **保留早返回**（省一次空查询），实现处注明"防御性 + drizzle 本身也会生成 `false`"；`store.test.ts` 的两条断言在 §10.2 记为**契约级**（不保护早返回） |

复审同时**实证了改动的可证伪性**（都是 clone 内 mutation）：删形状守卫 → 新用例报
`Expected: 422 / Received: 200`；把该断言先改成 200 再删守卫 → 降级用例红；`service.ts` 的
`listingIds: [...new Set(listingIds)]` 换成 `[]` 或无关 uuid → 集成测试 **6 例红**；
`service.ts:615` 的 `rec-v1-none` 判定改成 `if (false)` → 只有降级归因用例红。另有两点澄清已采纳
进文档：伪造 passthrough 用例的内层游标**确实合法**（来自真 `GET /listings?sort=newest&limit=1`，
mutation 得到的 200 反证）；「降级透传路径的坏内层游标 → 422」测的是 **HEAD 已有行为**
（HEAD 版 `service.ts:166-178` 有逐字相同的 `ListingServiceError → invalidCursor()` 捕获，本次只是
搬进 `serveByNewest`），只算**回归护栏**、不计入新增覆盖（§10.2 的 ⑩ 已按此口径描述）。

