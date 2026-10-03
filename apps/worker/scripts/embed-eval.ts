// ---------------------------------------------------------------------------
// #322 M4 live 语义质量评估（Issue 的 "真实 provider 的语义质量" 验收项）。
//
// 四段（可用 `--sections=` 单独跑，避免一次跑完全部）：
//
//   1) `fixture`：把 M3 的 12 条人工标注样本喂给**真实模型**取 cosine，再代入 `scoreMatch()`
//      看"12/12 与人工判断一致"是否在真实语义尺度上仍然成立（M3 当时用人给定的 cosine）。
//      已知差异：`MatchWishFacts` 没有描述字段，所以愿望侧文本只能由
//      `keyword + category` 构造（生产路径会多一行 `描述:`）——差异写进结论。
//   2) `anchors`：~30 组人工构造的中文对照对（同义改写 / 品牌型号 / 只有描述命中 / 分类不符 /
//      部分相关 / 完全无关），取真实 cosine 看当前锚点 `SEMANTIC_SCORE_FLOOR` / `SEMANTIC_SCORE_CEILING`
//      （M4 重标定后为 0.42 / 0.70；M3 的 0.5 / 0.95 是人工估计值）在真实分布下是否可达、是否有区分度。
//   3) `recall`：合成 N 条中文商品文本 + 20 个"同义改写"查询，取真实 embedding 后在内存里做
//      exact cosine 扫描，报 recall@K（K ∈ 10/20/50/100/200），复核 `MATCH_SEMANTIC_TOP_K = 50`。
//      合成语料的描述行只有 6 种模板，可能让所有向量挤在同一锥里、拉高无关对的 cosine；
//      用 `--corpus-text=title-only` 去掉描述行重跑，即可分离这一混杂因素（每段 `perQuery.top3`
//      还会打出每个查询的前 3 名竞争者文本，用来判断"挤掉正例的是模板无关商品还是真同义商品"）。
//   4) `calibration`：M4 候选标注集（`../src/jobs/matching/calibration-pairs.ts`）逐对实测 cos，
//      同时给出 v1 分 / 现锚 v2 分 / 语义分，并标出"我方建议匹配但实测语义被 FLOOR 归零"的行——
//      这份输出渲染成 markdown 审核表交 Owner 审标签，标签定后才用来拟合新 anchor/权重。
//      表里的 `proposedExpectMatch` 已由 Owner 逐条审核（2026-09-29），是冻结标签。
//   5) `fit`：拿上表的冻结标签 + 实测 cos，网格搜索（floor / ceiling / 四路权重 / 阈值 /
//      不限分类口径），排序后给出候选表。调的是 `scoring.ts` 的生产函数（参数可注入），
//      不在这里另写一套打分公式。
//
// 运行（仓库根目录，需要 `EMBEDDING_*` 配好）：
//   bun run embed:eval
//   bun run embed:eval -- --sections=fixture,anchors
//   bun run apps/worker/scripts/embed-eval.ts -- --corpus=5000 --sections=recall
//   bun run embed:eval -- --sections=recall --corpus=500 --corpus-text=title-only
//   bun run embed:eval -- --sections=calibration
//   bun run embed:eval -- --sections=fit
//
// 批量上限：百炼 `text-embedding-v4` **每请求最多 10 行**，所以这里按 ≤10 条切块
// （生产的 handler 一次只发 1 条，因此不受这条限制影响）。
// 输出：每段一行 JSON 事件（`eval.*`），原始数字直接抄进 `docs/design/issue-322-matching-v2-m4.md`。
// ---------------------------------------------------------------------------

import type { EmbeddingProvider } from '@fish/contracts/embedding/provider'
import { buildListingEmbeddingText, buildWishEmbeddingText } from '@fish/contracts/embedding/text'
import {
  MATCH_SCORE_THRESHOLD,
  SEMANTIC_SCORE_CEILING,
  SEMANTIC_SCORE_FLOOR,
} from '@fish/contracts/matching/schema'
import { loadEmbeddingEnv } from '@fish/shared/env'
import { createEmbeddingProvider } from '../src/jobs/embedding/providers'
import { CALIBRATION_ROWS } from '../src/jobs/matching/calibration-pairs'
import { RANKING_FIXTURE } from '../src/jobs/matching/ranking-fixture'
import {
  DEFAULT_SCORING_PARAMS,
  type RankingWeights,
  type ScoringParams,
  scoreMatch,
  scoreMatchWithWeights,
  WEIGHTS_V2,
} from '../src/jobs/matching/scoring'
import { elapsedMs, errorMessage, logErrorEvent, logEvent } from '../src/log'

/** 上游批量上限（百炼 text-embedding-v4：10 行/请求）。 */
const MAX_TEXTS_PER_REQUEST = 10
/** 每块最多重试几次（provider 内部还有 3 次），长跑时不让一次抖动毁掉整轮评估。 */
const CHUNK_ATTEMPTS = 3
/** 默认合成的商品文本条数（Issue 建议 ~5000）。 */
const DEFAULT_CORPUS_SIZE = 5_000
const DEFAULT_SEED = 20_260_929

type Section = 'fixture' | 'anchors' | 'recall' | 'calibration' | 'fit'

/**
 * recall 段合成语料的文本口径：
 * - `full`：标题 + 描述 + 分类（贴近生产 listing 文本）；
 * - `title-only`：只有标题行（用来分离"模板化描述主导向量"这一混杂因素）。
 */
type CorpusTextMode = 'full' | 'title-only'

type Options = {
  sections: Section[]
  corpusSize: number
  seed: number
  topKs: number[]
  corpusText: CorpusTextMode
}

class UsageError extends Error {}

const ALL_SECTIONS: Section[] = ['fixture', 'anchors', 'recall', 'calibration', 'fit']

function parseArgs(argv: string[]): Options {
  const options: Options = {
    sections: ALL_SECTIONS,
    corpusSize: DEFAULT_CORPUS_SIZE,
    seed: DEFAULT_SEED,
    topKs: [10, 20, 50, 100, 200],
    corpusText: 'full',
  }

  for (const arg of argv) {
    if (arg.startsWith('--sections=')) {
      const raw = arg.slice('--sections='.length).split(',')
      const sections = raw.filter((value): value is Section =>
        (ALL_SECTIONS as string[]).includes(value),
      )
      if (sections.length !== raw.length || sections.length === 0) {
        throw new UsageError(`--sections 只接受 ${ALL_SECTIONS.join('|')} 的逗号列表`)
      }
      options.sections = sections
    } else if (arg.startsWith('--corpus=')) {
      const value = Number(arg.slice('--corpus='.length))
      if (!Number.isInteger(value) || value < 20 || value > 100_000) {
        throw new UsageError('--corpus 需要 20..100000 之间的整数')
      }
      options.corpusSize = value
    } else if (arg.startsWith('--seed=')) {
      const value = Number(arg.slice('--seed='.length))
      if (!Number.isInteger(value)) throw new UsageError('--seed 需要整数')
      options.seed = value
    } else if (arg.startsWith('--top-k=')) {
      const values = arg
        .slice('--top-k='.length)
        .split(',')
        .map((raw) => Number(raw))
      if (values.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new UsageError('--top-k 需要正整数列表')
      }
      options.topKs = [...new Set(values)].sort((a, b) => a - b)
    } else if (arg.startsWith('--corpus-text=')) {
      const value = arg.slice('--corpus-text='.length)
      if (value !== 'full' && value !== 'title-only') {
        throw new UsageError('--corpus-text 只接受 full|title-only')
      }
      options.corpusText = value
    } else {
      throw new UsageError(`未知参数 ${JSON.stringify(arg)}`)
    }
  }

  return options
}

/** 按上游批量上限切块 + 外层重试，返回与入参等长的向量数组。 */
async function embedAll(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  for (let start = 0; start < texts.length; start += MAX_TEXTS_PER_REQUEST) {
    const chunk = texts.slice(start, start + MAX_TEXTS_PER_REQUEST)
    let lastError: unknown = null
    for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt += 1) {
      try {
        vectors.push(...(await provider.embed(chunk)))
        lastError = null
        break
      } catch (error) {
        lastError = error
        if (attempt < CHUNK_ATTEMPTS) await Bun.sleep(500 * 2 ** (attempt - 1))
      }
    }
    if (lastError !== null) {
      throw new Error(
        `embedding 第 ${start}..${start + chunk.length - 1} 条失败：${errorMessage(lastError)}`,
      )
    }
  }
  return vectors
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / Math.sqrt(normA * normB)
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(Math.ceil(ratio * sorted.length) - 1, 0))
  return sorted[index] ?? 0
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function distribution(values: number[]): {
  count: number
  min: number
  p25: number
  p50: number
  p75: number
  max: number
} {
  return {
    count: values.length,
    min: round(percentile(values, 0)),
    p25: round(percentile(values, 0.25)),
    p50: round(percentile(values, 0.5)),
    p75: round(percentile(values, 0.75)),
    max: round(percentile(values, 1)),
  }
}

// ---------------------------------------------------------------------------
// 1) M3 fixture：真实 cosine 代入
// ---------------------------------------------------------------------------

async function evalFixture(provider: EmbeddingProvider): Promise<void> {
  const listingTexts = RANKING_FIXTURE.map((sample) => buildListingEmbeddingText(sample.listing))
  // 说明：愿望侧只有 keyword + category 可构造（fixture 的 MatchWishFacts 没有描述字段），
  // 生产路径的 `buildWishEmbeddingText` 会多一行 `描述:`；这是本段结论的已知差异。
  const wishTexts = RANKING_FIXTURE.map((sample) =>
    buildWishEmbeddingText({
      keyword: sample.wish.keyword,
      description: null,
      category: sample.wish.category,
    }),
  )

  const vectors = await embedAll(provider, [...listingTexts, ...wishTexts])
  const listingVectors = vectors.slice(0, RANKING_FIXTURE.length)
  const wishVectors = vectors.slice(RANKING_FIXTURE.length)

  let liveAgreements = 0
  let humanAgreements = 0
  let v1Agreements = 0
  const rows: Record<string, unknown>[] = []
  const liveSimilarities: number[] = []

  RANKING_FIXTURE.forEach((sample, index) => {
    const liveSimilarity = cosine(listingVectors[index] ?? [], wishVectors[index] ?? [])
    liveSimilarities.push(liveSimilarity)
    const liveScore = scoreMatch(sample.listing, sample.wish, { similarity: liveSimilarity })
    const humanScore = scoreMatch(sample.listing, sample.wish, { similarity: sample.similarity })
    // v1 基线（`semantic = null`）：回答"真实模型尺度下，v2 相对 v1 是变好还是变差"。
    const v1Score = scoreMatch(sample.listing, sample.wish, null)
    const liveMatch = liveScore.score >= MATCH_SCORE_THRESHOLD
    const humanMatch = humanScore.score >= MATCH_SCORE_THRESHOLD
    const v1Match = v1Score.score >= MATCH_SCORE_THRESHOLD
    if (liveMatch === sample.expectMatch) liveAgreements += 1
    if (humanMatch === sample.expectMatch) humanAgreements += 1
    if (v1Match === sample.expectMatch) v1Agreements += 1

    rows.push({
      id: sample.id,
      sampleClass: sample.sampleClass,
      humanSimilarity: sample.similarity,
      liveSimilarity: round(liveSimilarity),
      delta: round(liveSimilarity - sample.similarity),
      v1Score: v1Score.score,
      humanScore: humanScore.score,
      liveScore: liveScore.score,
      liveSemanticScore: liveScore.semanticScore,
      expectMatch: sample.expectMatch,
      v1Match,
      liveMatch,
      agrees: liveMatch === sample.expectMatch,
    })
  })

  logEvent({
    event: 'eval.fixture.samples',
    model: provider.model,
    threshold: MATCH_SCORE_THRESHOLD,
    rows,
  })
  logEvent({
    event: 'eval.fixture.summary',
    model: provider.model,
    samples: RANKING_FIXTURE.length,
    liveAgreements,
    humanAgreements,
    v1Agreements,
    liveAgreementRate: round(liveAgreements / RANKING_FIXTURE.length, 3),
    humanAgreementRate: round(humanAgreements / RANKING_FIXTURE.length, 3),
    v1AgreementRate: round(v1Agreements / RANKING_FIXTURE.length, 3),
    liveSimilarityDistribution: distribution(rows.map((row) => Number(row.liveSimilarity))),
    humanSimilarityDistribution: distribution(rows.map((row) => Number(row.humanSimilarity))),
    discrepancyNote:
      '愿望侧文本只由 keyword + category 构造（无描述行），与生产 buildWishEmbeddingText 的输入不完全一致',
  })

  // 锚点复估（#322 M4）：M3 的 FLOOR/CEILING 是用**人给定**的 cosine 冻的（0.86–0.93），
  // 真实模型的尺度低得多（见上面的 liveSimilarityDistribution）。这里用同一批 live cosine
  // 试算几组候选锚点：结构分 = `similarity = FLOOR` 时的总分（此刻 semanticScore = 0），
  // 语义权重由 `scoreMatch(CEILING) - scoreMatch(FLOOR)` 反推，不硬编码 WEIGHTS_V2。
  const anchorCandidates: Array<[number, number]> = [
    [SEMANTIC_SCORE_FLOOR, SEMANTIC_SCORE_CEILING],
    [0.5, 0.85],
    [0.5, 0.8],
    [0.45, 0.8],
    [0.45, 0.75],
    [0.4, 0.75],
    [0.4, 0.7],
  ]

  const reanchor = anchorCandidates.map(([floor, ceiling]) => {
    let agreements = 0
    const scores: number[] = []

    RANKING_FIXTURE.forEach((sample, index) => {
      // 结构分与语义权重都从**生产常量**的两个端点反推：`similarity = FLOOR` 时 semanticScore = 0，
      // `similarity = CEILING` 时 semanticScore = 100，因此权重 = (两端点分差) / 100。
      // （不能拿候选 ceiling 去调 `scoreMatch` 反推权重——那个调用走的是生产锚点，不是候选锚点。）
      const structural = scoreMatch(sample.listing, sample.wish, {
        similarity: SEMANTIC_SCORE_FLOOR,
      }).score
      const atCeiling = scoreMatch(sample.listing, sample.wish, {
        similarity: SEMANTIC_SCORE_CEILING,
      }).score
      const semanticWeight = (atCeiling - structural) / 100
      const similarity = liveSimilarities[index] ?? 0
      const semanticScore = Math.min(Math.max((similarity - floor) / (ceiling - floor), 0), 1) * 100
      const total = Math.round(structural + semanticWeight * semanticScore)
      scores.push(total)
      if (total >= MATCH_SCORE_THRESHOLD === sample.expectMatch) agreements += 1
    })

    return {
      floor,
      ceiling,
      agreements,
      agreementRate: round(agreements / RANKING_FIXTURE.length, 3),
      scores,
    }
  })

  logEvent({
    event: 'eval.fixture.reanchor',
    model: provider.model,
    samples: RANKING_FIXTURE.length,
    threshold: MATCH_SCORE_THRESHOLD,
    note: '用真实 cosine 重算候选锚点；结构分与语义权重由 scoreMatch 反推，未改生产常量',
    sampleIds: RANKING_FIXTURE.map((sample) => sample.id),
    expected: RANKING_FIXTURE.map((sample) => sample.expectMatch),
    liveSimilarities: liveSimilarities.map((value) => round(value, 3)),
    candidates: reanchor,
  })
}

// ---------------------------------------------------------------------------
// 2) 锚点复估：~30 组人工对照对
// ---------------------------------------------------------------------------

type AnchorPair = {
  /** 分档：判断"这一档应该高还是低"。 */
  bucket: '强相关-同义' | '强相关-品牌型号' | '强相关-描述命中' | '部分相关' | '分类不符' | '无关'
  listing: { title: string; description: string | null; category: string | null }
  wish: { keyword: string; description: string | null; category: string | null }
}

/** 人工对照对：每档 4–6 组，覆盖 Issue 点名的语义场景。 */
const ANCHOR_PAIRS: AnchorPair[] = [
  {
    bucket: '强相关-同义',
    listing: {
      title: '罗技 K380 机械键盘',
      description: '自用一年，键帽无打油',
      category: 'DIGITAL',
    },
    wish: { keyword: '静音键盘', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '强相关-同义',
    listing: { title: '高等数学上册（同济第七版）', description: '有少量笔记', category: 'BOOKS' },
    wish: { keyword: '高数教材', description: null, category: 'BOOKS' },
  },
  {
    bucket: '强相关-同义',
    listing: {
      title: '苹果 AirPods Pro 2 降噪耳机',
      description: '主动降噪，通透模式',
      category: 'DIGITAL',
    },
    wish: { keyword: '听歌耳塞', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '强相关-同义',
    listing: { title: '迪卡侬 双人帐篷', description: '防雨，带地钉', category: 'SPORTS' },
    wish: { keyword: '露营帐篷', description: null, category: 'SPORTS' },
  },
  {
    bucket: '强相关-品牌型号',
    listing: { title: '小米 台灯 Pro', description: '无频闪，可调色温', category: 'DAILY' },
    wish: { keyword: '小米台灯Pro', description: null, category: 'DAILY' },
  },
  {
    bucket: '强相关-品牌型号',
    listing: { title: '索尼 WH-1000XM4 头戴耳机', description: '降噪旗舰', category: 'DIGITAL' },
    wish: { keyword: 'WH1000XM4', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '强相关-品牌型号',
    listing: {
      title: '美利达 勇士 500 山地车',
      description: '27.5 寸，油碟',
      category: 'TRANSPORT',
    },
    wish: { keyword: '勇士500', description: null, category: 'TRANSPORT' },
  },
  {
    bucket: '强相关-品牌型号',
    listing: { title: '罗技 G304 无线鼠标', description: '轻量，续航长', category: 'DIGITAL' },
    wish: { keyword: 'g304', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '强相关-描述命中',
    listing: { title: '台灯', description: '护眼款，三档色温，适合长时间阅读', category: 'DAILY' },
    wish: { keyword: '护眼台灯', description: null, category: 'DAILY' },
  },
  {
    bucket: '强相关-描述命中',
    listing: {
      title: '闲置物品',
      description: '考研数学全套资料，含真题与笔记',
      category: 'BOOKS',
    },
    wish: { keyword: '考研数学资料', description: null, category: 'BOOKS' },
  },
  {
    bucket: '强相关-描述命中',
    listing: {
      title: '二手显示器',
      description: '27 寸 2K 144Hz，适合打游戏与剪辑',
      category: 'DIGITAL',
    },
    wish: { keyword: '2K 高刷显示器', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '强相关-描述命中',
    listing: { title: '宿舍神器', description: '小型洗衣机，能洗 3 公斤衣物', category: 'DAILY' },
    wish: { keyword: '宿舍小洗衣机', description: null, category: 'DAILY' },
  },
  {
    bucket: '部分相关',
    listing: { title: '罗技 K380 机械键盘', description: '自用一年', category: 'DIGITAL' },
    wish: { keyword: '键盘', description: null, category: 'DAILY' },
  },
  {
    bucket: '部分相关',
    listing: { title: '耐克 跑步鞋 42 码', description: '穿过几次', category: 'SPORTS' },
    wish: { keyword: '鞋子', description: null, category: 'APPAREL' },
  },
  {
    bucket: '部分相关',
    listing: { title: '小学数学教辅', description: '全新', category: 'BOOKS' },
    wish: { keyword: '教材', description: null, category: 'BOOKS' },
  },
  {
    bucket: '部分相关',
    listing: { title: '国产安卓手机', description: '8+256G，成色好', category: 'DIGITAL' },
    wish: { keyword: '手机', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '部分相关',
    listing: { title: '保温杯 500ml', description: '不锈钢，保温 12 小时', category: 'DAILY' },
    wish: { keyword: '水杯', description: null, category: 'DAILY' },
  },
  {
    bucket: '分类不符',
    listing: { title: '高等数学上册（同济第七版）', description: '有少量笔记', category: 'BOOKS' },
    wish: { keyword: '高数教材', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '分类不符',
    listing: { title: '罗技 K380 机械键盘', description: '自用一年', category: 'DIGITAL' },
    wish: { keyword: '机械键盘', description: null, category: 'BOOKS' },
  },
  {
    bucket: '分类不符',
    listing: { title: '小米 台灯 Pro', description: '无频闪', category: 'DAILY' },
    wish: { keyword: '台灯', description: null, category: 'BOOKS' },
  },
  {
    bucket: '分类不符',
    listing: {
      title: '佳能 EOS 200D 单反',
      description: '入门机型，含套机镜头',
      category: 'DIGITAL',
    },
    wish: { keyword: '单反相机', description: null, category: 'OTHER' },
  },
  {
    bucket: '无关',
    listing: { title: '高等数学上册（同济第七版）', description: '有少量笔记', category: 'BOOKS' },
    wish: { keyword: '山地自行车', description: null, category: 'TRANSPORT' },
  },
  {
    bucket: '无关',
    listing: { title: '苹果 AirPods Pro 2 降噪耳机', description: '主动降噪', category: 'DIGITAL' },
    wish: { keyword: '口红', description: null, category: 'BEAUTY' },
  },
  {
    bucket: '无关',
    listing: { title: '美利达 勇士 500 山地车', description: '油碟刹', category: 'TRANSPORT' },
    wish: { keyword: '考研英语真题', description: null, category: 'BOOKS' },
  },
  {
    bucket: '无关',
    listing: { title: '迪卡侬 双人帐篷', description: '防雨', category: 'SPORTS' },
    wish: { keyword: '电饭煲', description: null, category: 'DAILY' },
  },
  {
    bucket: '无关',
    listing: { title: '罗技 G304 无线鼠标', description: '轻量', category: 'DIGITAL' },
    wish: { keyword: '瑜伽垫', description: null, category: 'SPORTS' },
  },
  {
    bucket: '无关',
    listing: { title: '小米 台灯 Pro', description: '可调色温', category: 'DAILY' },
    wish: { keyword: '机械键盘', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '无关',
    listing: { title: '索尼 WH-1000XM4 头戴耳机', description: '降噪旗舰', category: 'DIGITAL' },
    wish: { keyword: '羽绒服', description: null, category: 'APPAREL' },
  },
  {
    bucket: '无关',
    listing: { title: '保温杯 500ml', description: '不锈钢保温', category: 'DAILY' },
    wish: { keyword: '显卡', description: null, category: 'DIGITAL' },
  },
  {
    bucket: '无关',
    listing: { title: '耐克 跑步鞋 42 码', description: '穿过几次', category: 'SPORTS' },
    wish: { keyword: '考研政治资料', description: null, category: 'BOOKS' },
  },
]

async function evalAnchors(provider: EmbeddingProvider): Promise<void> {
  const listingTexts = ANCHOR_PAIRS.map((pair) => buildListingEmbeddingText(pair.listing))
  const wishTexts = ANCHOR_PAIRS.map((pair) =>
    buildWishEmbeddingText({
      keyword: pair.wish.keyword,
      description: pair.wish.description,
      category: pair.wish.category,
    }),
  )

  const vectors = await embedAll(provider, [...listingTexts, ...wishTexts])
  const listingVectors = vectors.slice(0, ANCHOR_PAIRS.length)
  const wishVectors = vectors.slice(ANCHOR_PAIRS.length)

  const rows = ANCHOR_PAIRS.map((pair, index) => {
    const similarity = cosine(listingVectors[index] ?? [], wishVectors[index] ?? [])
    return {
      bucket: pair.bucket,
      listing: pair.listing.title,
      wish: pair.wish.keyword,
      similarity: round(similarity),
      semanticScore: round(
        Math.min(
          Math.max(
            (similarity - SEMANTIC_SCORE_FLOOR) / (SEMANTIC_SCORE_CEILING - SEMANTIC_SCORE_FLOOR),
            0,
          ),
          1,
        ) * 100,
        2,
      ),
      aboveFloor: similarity >= SEMANTIC_SCORE_FLOOR,
      aboveCeiling: similarity >= SEMANTIC_SCORE_CEILING,
    }
  })

  const buckets = [...new Set(ANCHOR_PAIRS.map((pair) => pair.bucket))]
  const byBucket = buckets.map((bucket) => {
    const subset = rows.filter((row) => row.bucket === bucket)
    return {
      bucket,
      distribution: distribution(subset.map((row) => Number(row.similarity))),
      aboveFloor: subset.filter((row) => row.aboveFloor).length,
      aboveCeiling: subset.filter((row) => row.aboveCeiling).length,
    }
  })

  const strongBuckets = new Set(['强相关-同义', '强相关-品牌型号', '强相关-描述命中'])
  const strong = rows.filter((row) => strongBuckets.has(row.bucket))
  const unrelated = rows.filter((row) => row.bucket === '无关')

  logEvent({
    event: 'eval.anchors.samples',
    model: provider.model,
    floor: SEMANTIC_SCORE_FLOOR,
    ceiling: SEMANTIC_SCORE_CEILING,
    rows,
  })
  logEvent({
    event: 'eval.anchors.summary',
    model: provider.model,
    pairs: ANCHOR_PAIRS.length,
    floor: SEMANTIC_SCORE_FLOOR,
    ceiling: SEMANTIC_SCORE_CEILING,
    overall: distribution(rows.map((row) => Number(row.similarity))),
    byBucket,
    strongMin: distribution(strong.map((row) => Number(row.similarity))).min,
    unrelatedMax: distribution(unrelated.map((row) => Number(row.similarity))).max,
    // 锚点是否仍有区分度：强相关的最低分要明显高于无关的最高分，且 FLOOR 不该把无关对判成"有语义"。
    separation: round(
      distribution(strong.map((row) => Number(row.similarity))).min -
        distribution(unrelated.map((row) => Number(row.similarity))).max,
    ),
    floorMisfiresOnUnrelated: unrelated.filter((row) => row.aboveFloor).length,
    ceilingReachable: rows.filter((row) => row.aboveCeiling).length,
  })
}

// ---------------------------------------------------------------------------
// 3) recall@K：合成商品文本 + 同义改写查询
// ---------------------------------------------------------------------------

/** 确定性 PRNG（mulberry32）：同一 seed 必须复现同一份语料。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BRANDS = [
  '罗技',
  '小米',
  '苹果',
  '索尼',
  '宜家',
  '安踏',
  '李宁',
  '戴森',
  '华为',
  '联想',
  '雷蛇',
  '飞利浦',
]
const PRODUCTS: Array<{ name: string; category: string }> = [
  { name: '机械键盘', category: 'DIGITAL' },
  { name: '无线鼠标', category: 'DIGITAL' },
  { name: '台灯', category: 'DAILY' },
  { name: '降噪耳机', category: 'DIGITAL' },
  { name: '跑步鞋', category: 'SPORTS' },
  { name: '双肩背包', category: 'APPAREL' },
  { name: '保温杯', category: 'DAILY' },
  { name: '显示器', category: 'DIGITAL' },
  { name: '平板电脑', category: 'DIGITAL' },
  { name: '瑜伽垫', category: 'SPORTS' },
  { name: '蓝牙音箱', category: 'DIGITAL' },
  { name: '电风扇', category: 'DAILY' },
]
const MODELS = ['K380', 'K580', 'Pro 2', 'Air', '青春版', '2023 款', 'Pro', 'Max', 'Lite', 'SE']
const STATES = ['九成新', '八成新', '全新未拆封', '自用一年', '毕业出清', '寝室闲置']
const DESCRIPTIONS = [
  '功能正常，无磕碰',
  '附原装包装与配件',
  '可小刀，校内自取',
  '用了半年，成色不错',
  '有轻微使用痕迹',
  '支持当面验货',
]

type PlantedPair = {
  /** 语料里的正例商品（标题/描述/分类）。 */
  match: { title: string; description: string; category: string }
  /** 同义改写的需求文本（不含正例标题的完整字面）。 */
  query: { keyword: string; description: string | null; category: string | null }
}

/**
 * 20 个"植入正例"：每个正例的商品领域与合成语料的产品列表**不重叠**，因此语料里只有一个
 * 语义上真正相关的商品，ground truth 唯一，recall@K 才有意义。
 */
const PLANTED: PlantedPair[] = [
  {
    match: {
      title: '大疆 Osmo Pocket 3 口袋云台相机',
      description: '4K 拍摄，续航好',
      category: 'DIGITAL',
    },
    query: { keyword: '想拍 vlog 的小型云台相机', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '雅马哈 F310 民谣吉他', description: '41 寸，初学者够用', category: 'OTHER' },
    query: { keyword: '入门民谣木吉他', description: null, category: 'OTHER' },
  },
  {
    match: {
      title: '七彩虹 RTX 4060 显卡',
      description: '打游戏够用，8G 显存',
      category: 'DIGITAL',
    },
    query: { keyword: '能打游戏的 40 系显卡', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '卡西欧 CT-S300 电子琴', description: '61 键，含琴架', category: 'OTHER' },
    query: { keyword: '初学用电子琴', description: null, category: 'OTHER' },
  },
  {
    match: {
      title: '美利达 勇士 500 山地车',
      description: '27.5 寸，24 速',
      category: 'TRANSPORT',
    },
    query: { keyword: '骑去上课的山地自行车', description: null, category: 'TRANSPORT' },
  },
  {
    match: { title: '南极人 电热毯 双人款', description: '定时，三档温度', category: 'DAILY' },
    query: { keyword: '冬天用的双人电热毯', description: null, category: 'DAILY' },
  },
  {
    match: { title: '小熊 电煮锅 1.5L', description: '宿舍能用，煮面方便', category: 'DAILY' },
    query: { keyword: '宿舍煮面的小电锅', description: null, category: 'DAILY' },
  },
  {
    match: {
      title: '佳能 EOS 200D 单反相机',
      description: '含套机镜头，拍人像好看',
      category: 'DIGITAL',
    },
    query: { keyword: '入门单反拍人像', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '飞科 电动剃须刀', description: '可水洗，充电快', category: 'DAILY' },
    query: { keyword: '电动剃须刀', description: null, category: 'DAILY' },
  },
  {
    match: { title: '网易严选 乳胶枕', description: '护颈椎，回弹好', category: 'DAILY' },
    query: { keyword: '护颈椎的乳胶枕头', description: null, category: 'DAILY' },
  },
  {
    match: { title: '迪卡侬 双人帐篷', description: '防雨，带地钉', category: 'SPORTS' },
    query: { keyword: '两人露营帐篷', description: null, category: 'SPORTS' },
  },
  {
    match: {
      title: '富士 instax mini 11 拍立得',
      description: '含 20 张相纸',
      category: 'DIGITAL',
    },
    query: { keyword: '能立刻出照片的相机', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '任天堂 Switch OLED 主机', description: '含底座与手柄', category: 'DIGITAL' },
    query: { keyword: '收一台掌上游戏机', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '九阳 豆浆机', description: '可打豆浆米糊', category: 'DAILY' },
    query: { keyword: '能打豆浆的机器', description: null, category: 'DAILY' },
  },
  {
    match: { title: '华为 手环 8', description: '测心率与睡眠', category: 'DIGITAL' },
    query: { keyword: '能测心率的手环', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '苏泊尔 电饭煲 3L', description: '两三人份，不粘内胆', category: 'DAILY' },
    query: { keyword: '小电饭煲', description: null, category: 'DAILY' },
  },
  {
    match: { title: '折叠 床上书桌', description: '可调高度，放笔记本', category: 'DAILY' },
    query: { keyword: '床上小书桌', description: null, category: 'DAILY' },
  },
  {
    match: {
      title: '大疆 御 Mavic Mini 无人机',
      description: '入门航拍，重量轻',
      category: 'DIGITAL',
    },
    query: { keyword: '入门航拍无人机', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '惠威 书架音箱 2.0', description: '听歌人声好', category: 'DIGITAL' },
    query: { keyword: '听歌用的书架音箱', description: null, category: 'DIGITAL' },
  },
  {
    match: { title: '云南白药 电动牙刷', description: '含两个刷头', category: 'BEAUTY' },
    query: { keyword: '电动牙刷', description: null, category: 'BEAUTY' },
  },
]

function synthCorpusTexts(size: number, seed: number, mode: CorpusTextMode): string[] {
  const random = mulberry32(seed)
  const pick = <T>(values: T[]): T => values[Math.floor(random() * values.length)] as T
  const texts: string[] = []

  for (let i = 0; i < size; i += 1) {
    const product = pick(PRODUCTS)
    texts.push(
      buildListingEmbeddingText({
        title: `${pick(BRANDS)} ${product.name} ${pick(MODELS)}`,
        description: mode === 'title-only' ? null : `${pick(STATES)}，${pick(DESCRIPTIONS)}`,
        category: product.category,
      }),
    )
  }

  return texts
}

async function evalRecall(
  provider: EmbeddingProvider,
  corpusSize: number,
  seed: number,
  topKs: number[],
  corpusText: CorpusTextMode,
): Promise<void> {
  // 语料 = 合成文本 + 植入正例；正例插到伪随机位置，避免"正例都在开头"这种位置偏置。
  const generated = synthCorpusTexts(corpusSize - PLANTED.length, seed, corpusText)
  const corpus = [...generated]
  const random = mulberry32(seed + 1)
  // 注意：正例是逐条 splice 插入的，后插入的正例会把先前正例的下标挤后移。
  // 所以这里不能记录"插入那一刻的下标"，必须在**全部插入完成后**按文本反查真实下标
  // （正例标题与合成语料的产品列表不重叠，因此文本唯一、反查可靠）。
  const plantedTexts = PLANTED.map((pair) =>
    buildListingEmbeddingText({
      title: pair.match.title,
      description: corpusText === 'title-only' ? null : pair.match.description,
      category: pair.match.category,
    }),
  )
  plantedTexts.forEach((text) => {
    const position = Math.floor(random() * (corpus.length + 1))
    corpus.splice(position, 0, text)
  })
  const truthIndex = new Map<number, number>(
    plantedTexts.map((text, plantedIndex) => [plantedIndex, corpus.indexOf(text)]),
  )

  const queryTexts = PLANTED.map((pair) =>
    buildWishEmbeddingText({
      keyword: pair.query.keyword,
      description: pair.query.description,
      category: pair.query.category,
    }),
  )

  const startedAt = Bun.nanoseconds()
  const corpusVectors = await embedAll(provider, corpus)
  const queryVectors = await embedAll(provider, queryTexts)

  const ranks: number[] = []
  const truthSimilarities: number[] = []
  const perQuery: Record<string, unknown>[] = []

  PLANTED.forEach((pair, plantedIndex) => {
    const queryVector = queryVectors[plantedIndex] ?? []
    const truth = truthIndex.get(plantedIndex) ?? -1
    const scored = corpus.map((_, index) => ({
      index,
      similarity: cosine(queryVector, corpusVectors[index] ?? []),
    }))
    scored.sort((a, b) => b.similarity - a.similarity)
    const rank = scored.findIndex((row) => row.index === truth)
    const truthSimilarity = scored.find((row) => row.index === truth)?.similarity ?? 0

    ranks.push(rank)
    truthSimilarities.push(truthSimilarity)
    perQuery.push({
      query: pair.query.keyword,
      truth: pair.match.title,
      rank,
      top1: scored[0]?.similarity === undefined ? null : round(scored[0].similarity),
      truthSimilarity: round(truthSimilarity),
      // 诊断用：正例排名附近的实际竞争者是"模板化无关商品"还是"真同义商品"。
      top3: scored.slice(0, 3).map((row) => ({
        similarity: round(row.similarity),
        text: (corpus[row.index] ?? '').replaceAll('\n', ' / ').slice(0, 70),
      })),
    })
  })

  const recallAtK = Object.fromEntries(
    topKs.map((k) => [
      `recall@${k}`,
      round(ranks.filter((rank) => rank >= 0 && rank < k).length / ranks.length, 3),
    ]),
  )

  logEvent({
    event: 'eval.recall.summary',
    model: provider.model,
    corpusSize: corpus.length,
    corpusText,
    planted: PLANTED.length,
    seed,
    topKs,
    recallAtK,
    rankDistribution: distribution(ranks.map((rank) => rank + 1)),
    medianRank: percentile(
      ranks.map((rank) => rank + 1),
      0.5,
    ),
    truthSimilarity: distribution(truthSimilarities),
    truthAboveFloor: truthSimilarities.filter((value) => value >= SEMANTIC_SCORE_FLOOR).length,
    durationMs: elapsedMs(startedAt),
    perQuery,
  })
}

// ---------------------------------------------------------------------------
// 4) calibration：M4 候选标注集逐对实测 cos + v1/现锚 v2 三套打分对照
// ---------------------------------------------------------------------------

async function evalCalibration(provider: EmbeddingProvider): Promise<void> {
  const listingTexts = CALIBRATION_ROWS.map((row) => buildListingEmbeddingText(row.listing))
  // 同 fixture 段：`MatchWishFacts` 没有描述字段，愿望侧文本只有 `需求/分类` 两行。
  const wishTexts = CALIBRATION_ROWS.map((row) =>
    buildWishEmbeddingText({
      keyword: row.wish.keyword,
      description: null,
      category: row.wish.category,
    }),
  )

  const vectors = await embedAll(provider, [...listingTexts, ...wishTexts])
  const listingVectors = vectors.slice(0, CALIBRATION_ROWS.length)
  const wishVectors = vectors.slice(CALIBRATION_ROWS.length)

  let liveAgreements = 0
  let v1Agreements = 0
  let m3Agreements = 0
  let m3Rows = 0
  let floorMisfires = 0
  let floorLeaks = 0
  // 全部标签计入主分母；已知错误只作标注，不排除，也不称为标签矛盾。
  const falsePositiveIds: string[] = []
  const falseNegativeIds: string[] = []
  const rows: Record<string, unknown>[] = []
  const liveSimilarities: number[] = []
  const trueSimilarities: number[] = []
  const falseSimilarities: number[] = []

  CALIBRATION_ROWS.forEach((row, index) => {
    const liveSimilarity = cosine(listingVectors[index] ?? [], wishVectors[index] ?? [])
    const liveScore = scoreMatch(row.listing, row.wish, { similarity: liveSimilarity })
    // v1 基线（`semantic = null`）：换锚点/权重之前，先看这批对在 v1 结构打分下的表现。
    const v1Score = scoreMatch(row.listing, row.wish, null)
    const liveMatch = liveScore.score >= MATCH_SCORE_THRESHOLD
    const v1Match = v1Score.score >= MATCH_SCORE_THRESHOLD
    const agrees = liveMatch === row.proposedExpectMatch
    if (agrees) liveAgreements += 1
    if (v1Match === row.proposedExpectMatch) v1Agreements += 1
    if (liveMatch && !row.proposedExpectMatch) falsePositiveIds.push(row.id)
    if (!liveMatch && row.proposedExpectMatch) falseNegativeIds.push(row.id)

    liveSimilarities.push(liveSimilarity)
    if (row.proposedExpectMatch) {
      trueSimilarities.push(liveSimilarity)
    } else {
      falseSimilarities.push(liveSimilarity)
    }
    // FLOOR 归零诊断：建议匹配却拿不到语义分（漏召回）／建议不匹配却拿到语义分（噪声进闸）。
    if (row.proposedExpectMatch && liveSimilarity < SEMANTIC_SCORE_FLOOR) floorMisfires += 1
    if (!row.proposedExpectMatch && liveSimilarity >= SEMANTIC_SCORE_FLOOR) floorLeaks += 1

    // M3 行额外给出"用人估 cos 打分"的对照，看这批样本换尺度后差多少。
    const m3Score =
      row.m3Similarity === null
        ? null
        : scoreMatch(row.listing, row.wish, { similarity: row.m3Similarity })
    if (m3Score !== null) {
      m3Rows += 1
      if (m3Score.score >= MATCH_SCORE_THRESHOLD === row.proposedExpectMatch) m3Agreements += 1
    }

    rows.push({
      id: row.id,
      source: row.source,
      sampleClass: row.sampleClass,
      needsOwnerDecision: row.needsOwnerDecision ?? false,
      knownDivergence: row.knownDivergence ?? null,
      m3Similarity: row.m3Similarity,
      liveSimilarity: round(liveSimilarity),
      v1Score: v1Score.score,
      v1Match,
      liveScore: liveScore.score,
      liveSemanticScore: liveScore.semanticScore,
      liveMatch,
      proposedExpectMatch: row.proposedExpectMatch,
      agrees: liveMatch === row.proposedExpectMatch,
      listingTitle: row.listing.title,
      listingCategory: row.listing.category,
      listingPriceCents: row.listing.priceCents,
      wishKeyword: row.wish.keyword,
      wishCategory: row.wish.category,
      wishBudgetMaxCents: row.wish.budgetMaxCents,
      acceptSimilar: row.wish.acceptSimilar,
      rationale: row.rationale,
    })
  })

  logEvent({
    event: 'eval.calibration.samples',
    model: provider.model,
    threshold: MATCH_SCORE_THRESHOLD,
    floor: SEMANTIC_SCORE_FLOOR,
    ceiling: SEMANTIC_SCORE_CEILING,
    rows,
  })
  logEvent({
    event: 'eval.calibration.summary',
    model: provider.model,
    samples: CALIBRATION_ROWS.length,
    proposedMatches: trueSimilarities.length,
    proposedNonMatches: falseSimilarities.length,
    liveAgreements,
    v1Agreements,
    m3Agreements,
    m3Rows,
    liveAgreementRate: round(liveAgreements / CALIBRATION_ROWS.length, 3),
    v1AgreementRate: round(v1Agreements / CALIBRATION_ROWS.length, 3),
    m3AgreementRate: m3Rows === 0 ? null : round(m3Agreements / m3Rows, 3),
    falsePositives: falsePositiveIds.length,
    falseNegatives: falseNegativeIds.length,
    falsePositiveIds,
    falseNegativeIds,
    floorMisfires,
    floorLeaks,
    liveSimilarityDistribution: distribution(liveSimilarities),
    trueSimilarityDistribution: distribution(trueSimilarities),
    falseSimilarityDistribution: distribution(falseSimilarities),
    separation:
      trueSimilarities.length === 0 || falseSimilarities.length === 0
        ? null
        : round(Math.min(...trueSimilarities) - Math.max(...falseSimilarities), 4),
    needsOwnerDecisionIds: CALIBRATION_ROWS.filter((row) => row.needsOwnerDecision).map(
      (row) => row.id,
    ),
    note: 'proposedExpectMatch 是已冻结的 ground truth（Owner 已逐条审过 4 条 needsOwnerDecision）；实测 cos 不写进源码文件',
  })
}

// ---------------------------------------------------------------------------
// 5) fit：用冻结的 57 对标签 + 实测 cos 网格搜索（锚点 / 四路权重 / 阈值 / 不限分类口径）
// ---------------------------------------------------------------------------

type FitCandidate = {
  floor: number
  ceiling: number
  weights: RankingWeights
  threshold: number
  nullCategoryMode: ScoringParams['nullCategoryMode']
  acceptSimilarGate: ScoringParams['acceptSimilarGate']
}

/** 权重网格：0.05 步长、四项和为 1，并限定各项下界（避免搜索结果跑到离谱的极值上）。 */
function* weightGrid(): Generator<RankingWeights> {
  const steps = 20
  for (let semantic = 4; semantic <= 10; semantic += 1) {
    for (let category = 3; category <= 8; category += 1) {
      for (let keyword = 1; keyword <= 5; keyword += 1) {
        const price = steps - semantic - category - keyword
        if (price < 2 || price > 6) continue
        yield {
          semantic: semantic / steps,
          category: category / steps,
          keyword: keyword / steps,
          price: price / steps,
        }
      }
    }
  }
}

type FitScore = {
  agreements: number
  falsePositives: number
  falseNegatives: number
  residuals: string[]
  byClass: Record<string, { agree: number; total: number }>
  structuralSum: number
}

function evaluateCandidate(candidate: FitCandidate, cosines: Map<string, number>): FitScore {
  const params: ScoringParams = {
    semanticFloor: candidate.floor,
    semanticCeiling: candidate.ceiling,
    nullCategoryMode: candidate.nullCategoryMode,
    acceptSimilarGate: candidate.acceptSimilarGate,
  }
  let agreements = 0
  let falsePositives = 0
  let falseNegatives = 0
  const residuals: string[] = []
  const byClass: Record<string, { agree: number; total: number }> = {}

  for (const row of CALIBRATION_ROWS) {
    const similarity = cosines.get(row.id) ?? 0
    const { score } = scoreMatchWithWeights(
      row.listing,
      row.wish,
      { similarity },
      candidate.weights,
      params,
    )
    const matched = score >= candidate.threshold
    const agree = matched === row.proposedExpectMatch
    const bucket = byClass[row.sampleClass] ?? { agree: 0, total: 0 }
    byClass[row.sampleClass] = bucket
    bucket.total += 1
    if (agree) {
      agreements += 1
      bucket.agree += 1
    } else {
      residuals.push(`${row.id}(cos=${similarity.toFixed(3)},score=${score})`)
      if (matched) falsePositives += 1
      else falseNegatives += 1
    }
  }

  return {
    agreements,
    falsePositives,
    falseNegatives,
    residuals,
    byClass,
    structuralSum: candidate.weights.category + candidate.weights.keyword + candidate.weights.price,
  }
}

async function evalFit(provider: EmbeddingProvider): Promise<void> {
  const listingTexts = CALIBRATION_ROWS.map((row) => buildListingEmbeddingText(row.listing))
  const wishTexts = CALIBRATION_ROWS.map((row) =>
    buildWishEmbeddingText({
      keyword: row.wish.keyword,
      description: null,
      category: row.wish.category,
    }),
  )
  const vectors = await embedAll(provider, [...listingTexts, ...wishTexts])
  const cosines = new Map<string, number>()
  CALIBRATION_ROWS.forEach((row, index) => {
    const listingVector = vectors[index] ?? []
    const wishVector = vectors[CALIBRATION_ROWS.length + index] ?? []
    cosines.set(row.id, cosine(listingVector, wishVector))
  })

  const floorGrid = [0.25, 0.3, 0.35, 0.4, 0.42, 0.45, 0.48, 0.5]
  const ceilingGrid = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]
  const thresholdGrid = [60, 65, 70, 75]
  const modes: ScoringParams['nullCategoryMode'][] = ['renormalize', 'satisfied']
  const gates: ScoringParams['acceptSimilarGate'][] = ['keyword-or-category', 'keyword-only']

  const weightCandidates = [...weightGrid()]
  const scored: { candidate: FitCandidate; result: FitScore }[] = []
  let evaluated = 0

  for (const floor of floorGrid) {
    for (const ceiling of ceilingGrid) {
      if (ceiling <= floor) continue
      for (const weights of weightCandidates) {
        for (const threshold of thresholdGrid) {
          for (const nullCategoryMode of modes) {
            for (const acceptSimilarGate of gates) {
              const candidate: FitCandidate = {
                floor,
                ceiling,
                weights,
                threshold,
                nullCategoryMode,
                acceptSimilarGate,
              }
              scored.push({ candidate, result: evaluateCandidate(candidate, cosines) })
              evaluated += 1
            }
          }
        }
      }
    }
  }

  scored.sort((left, right) => {
    if (left.result.agreements !== right.result.agreements) {
      return right.result.agreements - left.result.agreements
    }
    if (left.result.falsePositives !== right.result.falsePositives) {
      return left.result.falsePositives - right.result.falsePositives
    }
    if (left.result.falseNegatives !== right.result.falseNegatives) {
      return left.result.falseNegatives - right.result.falseNegatives
    }
    return right.result.structuralSum - left.result.structuralSum
  })

  const describe = (entry: {
    candidate: FitCandidate
    result: FitScore
  }): Record<string, unknown> => ({
    floor: entry.candidate.floor,
    ceiling: entry.candidate.ceiling,
    weights: entry.candidate.weights,
    structuralSum: round(entry.result.structuralSum, 3),
    threshold: entry.candidate.threshold,
    nullCategoryMode: entry.candidate.nullCategoryMode,
    acceptSimilarGate: entry.candidate.acceptSimilarGate,
    agreements: entry.result.agreements,
    falsePositives: entry.result.falsePositives,
    falseNegatives: entry.result.falseNegatives,
    misses: entry.result.residuals,
  })

  // 生产冻结参数作为基线，确认搜索出的候选确实是"更好"而不是脚本口径漂移。
  const baseline = evaluateCandidate(
    {
      floor: DEFAULT_SCORING_PARAMS.semanticFloor,
      ceiling: DEFAULT_SCORING_PARAMS.semanticCeiling,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: DEFAULT_SCORING_PARAMS.nullCategoryMode,
      acceptSimilarGate: DEFAULT_SCORING_PARAMS.acceptSimilarGate,
    },
    cosines,
  )

  // 手挑的短名单：网格最优往往是"平顶"上的极端点，短名单给出更保守/更可解释的对照。
  const shortlist: FitCandidate[] = [
    {
      floor: 0.4,
      ceiling: 0.75,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.42,
      ceiling: 0.7,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.45,
      ceiling: 0.75,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.35,
      ceiling: 0.7,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.4,
      ceiling: 0.8,
      weights: { semantic: 0.25, category: 0.35, keyword: 0.2, price: 0.2 },
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.25,
      ceiling: 0.6,
      weights: { semantic: 0.2, category: 0.35, keyword: 0.15, price: 0.3 },
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.4,
      ceiling: 0.75,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'renormalize',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.4,
      ceiling: 0.75,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-or-category',
    },
    {
      floor: 0.45,
      ceiling: 0.8,
      weights: { semantic: 0.3, category: 0.3, keyword: 0.2, price: 0.2 },
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.42,
      ceiling: 0.75,
      weights: { semantic: 0.3, category: 0.3, keyword: 0.15, price: 0.25 },
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    // 只改口径、锚点保持 M3 冻结值：用于回答"最小改动能到多少一致度"。
    {
      floor: 0.5,
      ceiling: 0.95,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
    {
      floor: 0.42,
      ceiling: 0.7,
      weights: WEIGHTS_V2,
      threshold: 65,
      nullCategoryMode: 'satisfied',
      acceptSimilarGate: 'keyword-only',
    },
  ]

  logEvent({
    event: 'eval.fit.summary',
    model: provider.model,
    samples: CALIBRATION_ROWS.length,
    evaluated,
    weightCandidates: weightCandidates.length,
    baseline: {
      floor: DEFAULT_SCORING_PARAMS.semanticFloor,
      ceiling: DEFAULT_SCORING_PARAMS.semanticCeiling,
      weights: WEIGHTS_V2,
      threshold: MATCH_SCORE_THRESHOLD,
      nullCategoryMode: DEFAULT_SCORING_PARAMS.nullCategoryMode,
      ...baseline,
    },
    best: describe(scored[0] as { candidate: FitCandidate; result: FitScore }),
    shortlist: shortlist.map((candidate) =>
      describe({ candidate, result: evaluateCandidate(candidate, cosines) }),
    ),
    top: scored.slice(1, 20).map(describe),
  })
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2))
  const embeddingEnv = loadEmbeddingEnv()
  const provider = createEmbeddingProvider(embeddingEnv)

  logEvent({
    event: 'eval.started',
    transport: embeddingEnv.transport,
    model: provider.model,
    dimensions: provider.dimensions,
    sections: options.sections,
    corpus: options.corpusSize,
    corpusText: options.corpusText,
    seed: options.seed,
    topKs: options.topKs,
    floor: SEMANTIC_SCORE_FLOOR,
    ceiling: SEMANTIC_SCORE_CEILING,
    matchThreshold: MATCH_SCORE_THRESHOLD,
    batchLimit: MAX_TEXTS_PER_REQUEST,
  })

  if (options.sections.includes('fixture')) await evalFixture(provider)
  if (options.sections.includes('anchors')) await evalAnchors(provider)
  if (options.sections.includes('recall')) {
    await evalRecall(provider, options.corpusSize, options.seed, options.topKs, options.corpusText)
  }
  if (options.sections.includes('calibration')) await evalCalibration(provider)
  if (options.sections.includes('fit')) await evalFit(provider)

  logEvent({ event: 'eval.finished', model: provider.model, sections: options.sections })
}

try {
  await main()
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n`)
    console.error(
      '用法：bun run embed:eval -- [--sections=fixture,anchors,recall,calibration,fit] [--corpus=5000] [--corpus-text=full|title-only] [--seed=20260929] [--top-k=10,20,50,100,200]',
    )
    process.exit(2)
  }
  logErrorEvent({ event: 'eval.failed', error: errorMessage(error) })
  process.exitCode = 1
}
