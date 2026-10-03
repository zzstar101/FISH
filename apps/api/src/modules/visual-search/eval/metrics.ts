import type { VisualEvalRelevance } from './fixture'

/**
 * 拍照识图搜索（#324 M9）的离线检索度量：全部是纯函数，输入只有"排序结果 + 人工相关性"。
 *
 * ## 约定
 *
 * - `ranked` 是**已经排好序**的 `listingId` 列表（下标 0 = 第 1 名）。
 * - `relevance` 是 `listingId → 分级相关性`。分级含义见 `./fixture.ts`：
 *   `0` = 不相关，`1` = 部分相关，`2` = 同款。**没有出现在字典里的 id 一律按 0 处理**——
 *   候选池里没标注的项就是"人工判断为不相关"，这样 fixture 的 `relevance` 只需要写相关项。
 * - 所有函数在退化输入（空列表、`k ≤ 0`、没有任何相关项）上都有明确定义并返回有限值，
 *   不会返回 `NaN`。原因很实际：`NaN` 会**静默**污染整张指标表（`sum` 一旦吃到 `NaN`
 *   之后全是 `NaN`），而且比抛错更难在报告里看出来。
 *
 * ## 为什么不在这里定义"召回率"的分母为 Top-K
 *
 * `recallAtK` 的分母是**标注出来的相关项总数**（不是 `k`）。fixture 的候选池是采样过的
 * （见 fixture 头注释），所以这个分母是"本次采样池里的相关项"，而不是"库里全部同款"。
 * 它衡量的是**排序器把已知相关项捞进 Top-K 的能力**——这正是离线腿要回答的问题；
 * 绝对召回率（分母 = 全库同款）只有真实数据能算，归 `visual:eval:db` 与 live 考核。
 */

/** 相关性默认值：字典里没有的 id 视为不相关。 */
const IRRELEVANT: VisualEvalRelevance = 0

function relevanceOf(
  relevance: Readonly<Record<string, 0 | 1 | 2>>,
): (listingId: string) => VisualEvalRelevance {
  return (listingId: string): VisualEvalRelevance => relevance[listingId] ?? IRRELEVANT
}

/** 分级增益 `2^rel - 1`：rel = 0 恰好贡献 0，所以不相关项不占 DCG 分子。 */
function gain(relevance: number): number {
  return 2 ** relevance - 1
}

/** 位置折扣 `log2(rank + 1)`；`rank` 是 1-based 名次。 */
function discount(rank: number): number {
  return Math.log2(rank + 1)
}

/**
 * Recall@K = |{ 相关项 } ∩ { Top-K }| / |{ 相关项 }|。
 *
 * 相关 = `relevance ≥ 1`（同款与部分相关都算"捞到了"）。
 *
 * 边界：
 * - 没有任何相关项 → `0`（分母为 0 时返回 0，而不是 `NaN`）。
 * - `k ≤ 0` → `0`。
 * - `k > ranked.length` → 相当于对整个 `ranked` 求召回，不会越界也不补零。
 * - `ranked` 里有重复 id：只算一次（用集合去重），重复排名不能刷高召回。
 */
export function recallAtK(
  ranked: readonly string[],
  relevance: Readonly<Record<string, 0 | 1 | 2>>,
  k: number,
): number {
  const relevantIds = Object.entries(relevance)
    .filter(([, value]) => value >= 1)
    .map(([listingId]) => listingId)
  if (relevantIds.length === 0) return 0
  if (!Number.isFinite(k) || k <= 0) return 0

  const topK = new Set(ranked.slice(0, Math.floor(k)))
  let hit = 0
  for (const listingId of relevantIds) {
    if (topK.has(listingId)) hit += 1
  }
  return hit / relevantIds.length
}

/**
 * MRR（Mean Reciprocal Rank 的**单查询**版本，脚本里再对样本取平均）。
 *
 * 取第一个相关项（`relevance ≥ 1`）的 1-based 名次 `r`，返回 `1 / r`；没有相关项 → `0`。
 *
 * 边界：`ranked` 为空 → `0`；`relevance` 里没有任何 `≥ 1` 的项 → `0`（哪怕 `ranked` 非空）。
 * 这里**不做 Top-K 截断**：MRR 的定义就是"第一个相关项排多靠前"，截断会把它变成另一个指标。
 */
export function mrr(
  ranked: readonly string[],
  relevance: Readonly<Record<string, 0 | 1 | 2>>,
): number {
  const relevant = relevanceOf(relevance)
  for (let index = 0; index < ranked.length; index++) {
    if (relevant(ranked[index] ?? '') >= 1) return 1 / (index + 1)
  }
  return 0
}

/**
 * NDCG@K = DCG@K / IDCG@K，其中
 *
 *   DCG@K  = Σ_{i=1..K} (2^rel_i - 1) / log2(i + 1)
 *   IDCG@K = Σ_{i=1..min(K, |R|)} (2^rel_(i) - 1) / log2(i + 1)   （rel_(i) 为降序排列）
 *
 * 也就是"按模型排序拿到的分级增益"除以"按人工相关性排序能达到的上限"。
 *
 * 边界：
 * - `ranked` 为空 / `k ≤ 0` → `0`（无增益）。
 * - 没有任何相关项 → 分子分母都是 0 → 定义返回 `0`（而不是 `0/0`）。
 * - `k > ranked.length` → 只累加真实存在的项；**IDCG 仍然只排 `min(k, |R|)` 个相关项**，
 *   所以"候选池比 k 小"不会让指标虚高（分母不会因为缺少位置而缩小）。
 * - 没有出现在 `relevance` 里的 id 按 rel = 0 处理，`2^0 - 1 = 0`，对分子无贡献。
 */
export function ndcgAtK(
  ranked: readonly string[],
  relevance: Readonly<Record<string, 0 | 1 | 2>>,
  k: number,
): number {
  if (!Number.isFinite(k) || k <= 0) return 0

  const relevant = relevanceOf(relevance)
  const cutoff = Math.floor(k)

  let dcg = 0
  for (let index = 0; index < Math.min(cutoff, ranked.length); index++) {
    dcg += gain(relevant(ranked[index] ?? '')) / discount(index + 1)
  }

  const idealGains = Object.values(relevance)
    .filter((value) => value >= 1)
    .sort((left, right) => right - left)
  let idcg = 0
  for (let index = 0; index < Math.min(cutoff, idealGains.length); index++) {
    idcg += gain(idealGains[index] ?? 0) / discount(index + 1)
  }

  if (idcg === 0) return 0
  return dcg / idcg
}

/**
 * Top-K 人工相关率 = |{ Top-K 中 relevance ≥ 1 }| / |{ Top-K }|。
 *
 * 与 `recallAtK` 的区别：分母是**返回的位置数**（不是相关项总数），所以它衡量的是
 * "用户翻到前 K 条，看到的东西里有多少是他想要的"——M9 要求的「Top-5 人工相关率」。
 * 两者一起看能区分两类退化：召回不足（Recall 低）与排序不准（Recall 高但相关率低）。
 *
 * 边界：
 * - `k ≤ 0` → `0`。
 * - `ranked` 为空 → `0`。
 * - `k > ranked.length` → 分母取 `ranked.length`（**不是 k**）。用 k 当分母会把
 *   "候选池本来就只有 3 条"算成 3/5 = 0.6 的惩罚，那是候选池大小的问题，不是排序质量的问题。
 */
export function topKRelevanceRate(
  ranked: readonly string[],
  relevance: Readonly<Record<string, 0 | 1 | 2>>,
  k: number,
): number {
  if (!Number.isFinite(k) || k <= 0) return 0
  const topK = ranked.slice(0, Math.floor(k))
  if (topK.length === 0) return 0

  const relevant = relevanceOf(relevance)
  let hit = 0
  for (const listingId of topK) {
    if (relevant(listingId) >= 1) hit += 1
  }
  return hit / topK.length
}

/**
 * 空结果率 = 返回 0 条商品的请求数 / 请求总数。
 *
 * 只吃 `itemCount`，不关心响应的其它字段——离线腿与 DB 腿都只需把每次请求的条数映射进来。
 *
 * 边界：`results` 为空 → `0`（没有请求就没有"空结果率"可言，返回 0 而不是 `NaN`，
 * 让"0 次请求"在报告里显示为 0 而不是炸掉整张表）。
 */
export function emptyResultRate(results: readonly { itemCount: number }[]): number {
  if (results.length === 0) return 0
  let empty = 0
  for (const result of results) {
    if (result.itemCount === 0) empty += 1
  }
  return empty / results.length
}

/**
 * 延迟分位（单位与输入一致，通常毫秒）。`p ∈ [0, 1]`。
 *
 * 用**线性插值**（与 `numpy.percentile` 默认的 `linear` 方法同定义）：
 * 排序后设 `pos = (n - 1) * p`，下取整 `lo`、`lo + 1` 上取整 `hi`，结果为
 * `samples[lo] + (samples[hi] - samples[lo]) * (pos - lo)`。
 *
 * 为什么不直接取 `samples[Math.floor(p * n)]`：那样 p50 在偶数个样本上会偏到上半区
 * （n = 4 时取第 2 个而不是 1、2 的中点），本仓库的样本数很小（DB 腿约 10 条），
 * 这个偏差足以让两次运行的 p50 差出几十毫秒。同时，**它不改输入数组**——原地排序是
 * 这类工具最常见的副作用 bug。
 *
 * 边界：
 * - `samples` 为空 → `0`（延迟 0 比 `NaN` 更能在报告里被一眼看出是"没数据"）。
 * - `p` 非有限 → `0`；`p ≤ 0` → 最小值；`p ≥ 1` → 最大值（钳制而不是外插）。
 * - 单个样本 → 该样本自身（无论 p）。
 * - 输入**不要求已排序**，内部复制后排序。
 */
export function latencyPercentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((left, right) => left - right)
  if (sorted.length === 0) return 0
  if (!Number.isFinite(p)) return 0
  if (p <= 0) return sorted[0] ?? 0
  if (p >= 1) return sorted[sorted.length - 1] ?? 0

  const position = (sorted.length - 1) * p
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.min(lowerIndex + 1, sorted.length - 1)
  const lower = sorted[lowerIndex] ?? 0
  const upper = sorted[upperIndex] ?? lower
  return lower + (upper - lower) * (position - lowerIndex)
}
