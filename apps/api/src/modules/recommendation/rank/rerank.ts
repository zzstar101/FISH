/**
 * 重排（#323 R4 / M6）。
 *
 * 排序分数回答的是"哪条更相关"，重排回答的是"一屏之内看起来像不像话"：同一个卖家的东西连着
 * 排三张、同一个类目占满整屏、整屏都是熟悉的内容没有新东西 —— 这些都是逐条打分看不见的问题。
 *
 * 三条硬约束 + **固定松弛阶梯**（不是随机打散、不是加权扰动）：
 *
 * 1. `seller`：同一卖家的商品之间至少隔 `RERANK_SELLER_MIN_GAP` 个位置；
 * 2. `category`：任意连续 `RERANK_CATEGORY_WINDOW` 位里同一类目不超过
 *    `RERANK_CATEGORY_MAX_IN_WINDOW` 条；
 * 3. `explore`：每 `RERANK_EXPLORE_WINDOW` 位至少 `RERANK_EXPLORE_MIN_PER_WINDOW` 条探索候选。
 *
 * 约束冲突时按 `RERANK_RELAXATION_ORDER`（explore → category → seller）逐个放弃，并**计数**。
 * 选择"固定顺序"而不是"按分数权衡"是为了可复现：同样的候选集永远得到同样的结果，出问题可以
 * 精确复盘是哪一条约束被让掉了多少次。`seller` 放在最后放弃 —— 相邻同卖家是最刺眼的一种。
 *
 * 另有一条**不属于松弛阶梯**的硬排除：重复曝光冷却（M6）。它不参与约束冲突谈判（不能让掉，一
 * 让就等于没做），被剔除的条数单独记在 `droppedCooldown`，与 `droppedHidden` 分开 —— 两者的
 * 归因完全不同（用户明确隐藏 vs 反复推了没点）。
 */

import {
  RANK_COOLDOWN_EXEMPT_RECALL_SOURCE,
  RERANK_CATEGORY_MAX_IN_WINDOW,
  RERANK_CATEGORY_WINDOW,
  RERANK_EXPLORE_MIN_PER_WINDOW,
  RERANK_EXPLORE_WINDOW,
  RERANK_RELAXATION_ORDER,
  RERANK_SELLER_MIN_GAP,
  type RerankConstraint,
} from '@fish/contracts/recommendation/rank'
import { compareScoredCandidates, type ScoredCandidate } from './score'

export type RerankSummary = {
  /** 进重排的候选条数（已按分数排好序）。 */
  inputCount: number
  /** 因 listing 级硬排除（`RANK_HIDDEN_EVENT_TYPES`）被剔除的条数。 */
  droppedHidden: number
  /** 因重复曝光冷却（M6）被剔除的条数（`wish` 召回豁免的不计在内）。 */
  droppedCooldown: number
  /** 因超出 `limit` 未入选的条数。 */
  droppedOverflow: number
  /** 各约束被让掉的次数（诊断用；非零说明候选池结构有偏）。 */
  relaxations: Record<RerankConstraint, number>
}

export type RerankResult = {
  items: ScoredCandidate[]
  summary: RerankSummary
}

const ALL_CONSTRAINTS: readonly RerankConstraint[] = ['seller', 'category', 'explore']

const EMPTY_LISTING_IDS: ReadonlySet<string> = new Set()

/**
 * 该候选是否因重复曝光冷却被剔除（M6）。
 *
 * 豁免只看**召回通道**而不是"用户是否主动搜索"：`wish` 通道本身就意味着用户明确表达过这个需求
 * （见 `RANK_COOLDOWN_EXEMPT_RECALL_SOURCE` 的注释），不需要重排层再判断别的信号。
 */
function isCooling(item: ScoredCandidate, cooldown: ReadonlySet<string>): boolean {
  if (!cooldown.has(item.candidate.listingId)) return false
  return !item.candidate.recallSources.includes(RANK_COOLDOWN_EXEMPT_RECALL_SOURCE)
}

/**
 * FNV-1a 32 位哈希。
 *
 * 探索候选的选择需要"看起来随机但可复现"：用 `Math.random()` 会让同一个请求重放得到不同结果
 * （无法复盘、无法写确定性测试），而按分数选又会让探索位永远固定给同几条。以 `requestId` 为
 * 种子做哈希打散，既避免"每次都是同几条"，又保证同一请求可重放。
 */
function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function exploreHash(item: ScoredCandidate, seed: string): number {
  return fnv1a32(`${seed}:${item.candidate.listingId}`)
}

/** `recallSources` 由 R3 保证按通道优先级有序，`[0]` 即 primarySource。 */
function isExploreCandidate(item: ScoredCandidate): boolean {
  return item.candidate.recallSources[0] === 'explore'
}

function countExplore(placed: readonly ScoredCandidate[]): number {
  let count = 0
  for (const item of placed) if (isExploreCandidate(item)) count += 1
  return count
}

function satisfiesSingle(
  item: ScoredCandidate,
  placed: readonly ScoredCandidate[],
  needExplore: boolean,
  constraint: RerankConstraint,
): boolean {
  if (constraint === 'seller') {
    const gap = Math.max(RERANK_SELLER_MIN_GAP - 1, 0)
    if (gap === 0) return true
    const window = placed.slice(Math.max(placed.length - gap, 0))
    return window.every((other) => other.candidate.sellerId !== item.candidate.sellerId)
  }
  if (constraint === 'category') {
    const span = Math.max(RERANK_CATEGORY_WINDOW - 1, 0)
    const window = placed.slice(Math.max(placed.length - span, 0))
    let sameCategory = 0
    for (const other of window) {
      if (other.candidate.category === item.candidate.category) sameCategory += 1
    }
    return sameCategory < RERANK_CATEGORY_MAX_IN_WINDOW
  }
  if (!needExplore) return true
  return isExploreCandidate(item)
}

function satisfiesAll(
  item: ScoredCandidate,
  placed: readonly ScoredCandidate[],
  needExplore: boolean,
  enforced: ReadonlySet<RerankConstraint>,
): boolean {
  for (const constraint of ALL_CONSTRAINTS) {
    if (!enforced.has(constraint)) continue
    if (!satisfiesSingle(item, placed, needExplore, constraint)) return false
  }
  return true
}

export function rerankCandidates(input: {
  scored: readonly ScoredCandidate[]
  hiddenListingIds: ReadonlySet<string>
  /**
   * 处于重复曝光冷却（M6）的 listing。**先于三条约束**剔除，且命中
   * `RANK_COOLDOWN_EXEMPT_RECALL_SOURCE` 召回通道的不剔（M6「Wish 命中时允许重新进入」）。
   * 若剔除后一条不剩，则**本次整体不冷却**（见下方 `skipCooldown` 的取舍说明）。
   *
   * 缺省为空集：调用方读取曝光历史失败时按 fail-open 处理（宁可多曝光，也不因查询故障惩罚
   * 用户），所以这里不需要默认的"拒绝"语义。
   */
  cooldownListingIds?: ReadonlySet<string>
  /** 打散种子（用 `requestId`）：同一请求可重放，不同请求看到不同的探索位。 */
  seed: string
  limit: number
}): RerankResult {
  const hidden = new Set(input.hiddenListingIds)
  const cooldown = input.cooldownListingIds ?? EMPTY_LISTING_IDS
  // 输入理论上已排序，这里再排一次：重排的正确性依赖"按分数从高到低"这个前提，把它变成函数
  // 自己的保证，调用方漏排时不会静默产出一个顺序错误的 Feed。
  const ordered = [...input.scored].sort(compareScoredCandidates)
  const afterHidden = ordered.filter((item) => !hidden.has(item.candidate.listingId))
  const cooled = afterHidden.filter((item) => !isCooling(item, cooldown))
  // 兜底：冷却把整页清空时，本次不冷却。M6 是**单品**冷却，不是整页清空 —— 而 `service` 的
  // 降级判据（`scored.length === 0`）在冷却**之前**，这里若返回空 `items`，服务端仍会写一条
  // 0 快照行的 ranked 请求，admin 的 `emptyRankedFeedRate` 会把它记成一次线上故障。宁可多曝光。
  //
  // `afterHidden.length > 0` 只是**防御性写法**（避免"没有候选却声称跳过了冷却"）：`afterHidden`
  // 为空时两条分支等价（`pool` 都是 `[]`、`droppedCooldown` 都是 0）。另注意本兜底建在
  // `afterHidden` 之上 —— "全部候选同时被 HIDE 与冷却"仍会是空页，那是既有 all-hidden 行为的
  // 遗留，根治要挪到 `service` 层（页面为空则不写 ranked 请求），不在本次范围内。
  const skipCooldown = afterHidden.length > 0 && cooled.length === 0
  const pool = skipCooldown ? afterHidden : cooled
  const relaxations: Record<RerankConstraint, number> = { seller: 0, category: 0, explore: 0 }

  const target = Math.max(Math.min(input.limit, pool.length), 0)
  const remaining = [...pool]
  const placed: ScoredCandidate[] = []

  while (placed.length < target && remaining.length > 0) {
    // 已放 `n` 条时，前 `n + 1` 位里至少要有多少条探索候选。
    const neededExplore = Math.floor(
      ((placed.length + 1) * RERANK_EXPLORE_MIN_PER_WINDOW) / RERANK_EXPLORE_WINDOW,
    )
    const needExplore = countExplore(placed) < neededExplore

    const enforced = new Set<RerankConstraint>(ALL_CONSTRAINTS)
    let chosenIndex = -1

    for (;;) {
      if (needExplore && enforced.has('explore')) {
        // 配额强制时在合格候选里取哈希最小的一条：既满足配额，又不总是同几条。
        let bestHash = Number.POSITIVE_INFINITY
        for (let index = 0; index < remaining.length; index += 1) {
          const item = remaining[index]
          if (item === undefined || !satisfiesAll(item, placed, needExplore, enforced)) continue
          const hash = exploreHash(item, input.seed)
          if (hash < bestHash) {
            bestHash = hash
            chosenIndex = index
          }
        }
      } else {
        chosenIndex = remaining.findIndex((item) =>
          satisfiesAll(item, placed, needExplore, enforced),
        )
      }

      if (chosenIndex !== -1) break

      // 只让掉**当前确实卡住**的约束：不卡住却记一次松弛，计数就失去诊断意义。
      const blocking = RERANK_RELAXATION_ORDER.find(
        (constraint) =>
          enforced.has(constraint) &&
          remaining.some((item) => !satisfiesSingle(item, placed, needExplore, constraint)),
      )
      if (blocking !== undefined) {
        enforced.delete(blocking)
        relaxations[blocking] += 1
        continue
      }

      // 兜底：没有单条约束"卡住"，但合取无解（不同候选卡在不同约束上）。此时全让掉。
      for (const constraint of ALL_CONSTRAINTS) {
        if (enforced.delete(constraint)) relaxations[constraint] += 1
      }
      chosenIndex = remaining.findIndex((item) => satisfiesAll(item, placed, needExplore, enforced))
      if (chosenIndex === -1) chosenIndex = 0
      break
    }

    const [chosen] = remaining.splice(chosenIndex, 1)
    if (chosen === undefined) break
    placed.push(chosen)
  }

  return {
    items: placed,
    summary: {
      inputCount: input.scored.length,
      droppedHidden: ordered.length - afterHidden.length,
      droppedCooldown: skipCooldown ? 0 : afterHidden.length - cooled.length,
      droppedOverflow: pool.length - placed.length,
      relaxations,
    },
  }
}
