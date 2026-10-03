/**
 * 推荐链路的可观测性常量（#323 R6）：保留期、清理参数、限流阈值。
 *
 * 这些值的共同点是"**实现与运维读的是同一份数字**"：
 * - 保留期：清理 job 按它删数据、admin 端点的 30d 窗口与离线 CLI 的回放区间按它解释"数据到哪儿为止"。
 *   写成两处的话，删得比读得早（指标悄悄少一截）或读得比留得久（CLI 报保留期截断）都不会有人发现。
 * - 限流阈值：进程内令牌桶按它建桶，`packages/shared` 的 env 加载器只负责"有没有覆盖值"，
 *   默认值仍然来自这里（见 `loadRecommendationRateLimitEnv`），避免默认值在 shared 里再抄一份。
 *
 * 契约包**不依赖** `@fish/shared`（方向是 shared ← contracts），所以常量只能落在这里。
 */

/**
 * 事件（`recommendation_events`）保留天数。
 *
 * 与 `docs/design/issue-323-r1-event-tracking.md:135` 的政策一致：事件是曝光/点击的原始事实，
 * 是离线评估与兴趣向量的唯一输入，留 180 天；R1 当时明确"不做自动删除，交给 R6"。
 */
export const RECOMMENDATION_EVENT_RETENTION_DAYS = 180

/**
 * 推荐请求上下文（`recommendation_requests` + `recommendation_request_items` 快照）保留天数。
 *
 * 比事件短一半：快照里有"给这个身份看过哪些商品、排在第几位"，是隐私敏感度更高的一份记录；
 * 而它对离线评估只提供 **90 天**以内的归因证据（更早的请求已经删了，事件就变成孤儿）。
 * 删请求会级联删快照行，所以两个数字必须一起看——见 `RECOMMENDATION_CLEANUP_BATCH_SIZE` 的删除顺序。
 */
export const RECOMMENDATION_CONTEXT_RETENTION_DAYS = 90

/**
 * 清理批大小：一批 1000 行，与 `VISUAL_QUERY_CLEANUP_BATCH_SIZE`（100）同一思路——
 * 后台杂务不该在一次运行里扫全表、也不该长时间占住连接。批间让路见 worker 侧清理 job。
 */
export const RECOMMENDATION_CLEANUP_BATCH_SIZE = 1_000

/**
 * 清理间隔（1 小时）。保留期以天计，1 小时粒度足够；再密就是每分钟打一次删除查询，
 * 除了多写几张空表不会让数据更早消失。
 */
export const RECOMMENDATION_CLEANUP_INTERVAL_MS = 3_600_000

/**
 * 埋点写入（`POST /recommendations/events`）的限流：容量 120 / 2 令牌每秒。
 *
 * 取值依据：一次 Feed 页（20 张卡）最多产生 20 条 `IMPRESSION`，快速滚动 3 页 ≈ 60–100 条；
 * 120 的容量对真实用户足够宽松，而 2·s⁻¹（≈120 条/分钟均值）把脚本刷量压到"与线上量级同阶"。
 *
 * **按批扣 1 个令牌**（不是按事件条数）：批上限 50 条（契约），按条扣会让一次翻页的 20 条曝光
 * 吃掉六分之一容量，正常用户滚动两下就被限。
 */
export const RECOMMENDATION_EVENT_RATE_LIMIT = { capacity: 120, refillPerSecond: 2 } as const

/**
 * Feed（`GET /recommendations/feed`）的限流：容量 60 / 1 令牌每秒。
 *
 * 为什么 Feed 也要限：`requestId` 是写归因事件的前提，不限 Feed 等于给脚本一条"免费取号"通道——
 * 它不必写事件就能拿到成千上万个 requestId，再用它们污染归因表。这一档比埋点宽（1·s⁻¹ vs 2·s⁻¹），
 * 因为 Feed 是重查询（多路召回 + 排序），但它本身也不该被脚本以每秒几十次的速度打。
 */
export const RECOMMENDATION_FEED_RATE_LIMIT = { capacity: 60, refillPerSecond: 1 } as const

/**
 * 进程内令牌桶的桶数上限（超过就按 LRU 淘汰最久未用的主体）。
 *
 * 桶表是 `Map<string, ...>`，键含匿名会话与出口 IP，**不落库**。没有上限的话，
 * 一个换会话标识（或换 IP）的脚本可以让 Map 一直长，把进程内存吃干净——
 * 那是"为了防刷量而制造新的打挂方式"。1 万主体的开销（每项几十字节）可忽略。
 */
export const RECOMMENDATION_RATE_LIMIT_MAX_SUBJECTS = 10_000

/**
 * 延迟直方图每个指标的样本数（环形缓冲：写 O(1)，读时排序取分位）。
 *
 * 2 048 个 `number` ≈ 48 KB/进程（三个指标共 ~144 KB），够算出稳定的 p99（≈20 个样本落在尾部），
 * 又不至于让"排序取分位"这件小事变慢。容器重启即归零——这是 D5（零新增存储）的已知代价。
 */
export const RECOMMENDATION_LATENCY_SAMPLE_CAPACITY = 2_048
