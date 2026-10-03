// Owner 冻结的 24 条独立样本：真实 provider + pgvector + 两方向引擎。
// 只允许本地临时库。质量失败 exit 1、保留 scratch；绝不据结果调参。
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import { MATCH_SCORE_THRESHOLD } from '@fish/contracts/matching/schema'
import { createDb } from '@fish/db/client'
import { saveEmbedding } from '@fish/db/embedding-store'
import { newId } from '@fish/db/ids'
import { embeddings } from '@fish/db/schema/embeddings'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadEmbeddingEnv } from '@fish/shared/env'
import { and, eq, sql } from 'drizzle-orm'
import { createEmbeddingProvider } from '../src/jobs/embedding/providers'
import { createEmbeddingRequestGate } from '../src/jobs/embedding/providers/request-gate'
import { scoreConstrainedMatch } from '../src/jobs/matching/constraints'
import { createMatchEngine } from '../src/jobs/matching/engine'
import { HOLDOUT_SAMPLES } from '../src/jobs/matching/holdout-fixture'
import { INDEPENDENT_HOLDOUT_SAMPLES } from '../src/jobs/matching/independent-holdout-fixture'
import {
  INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES,
  INDEPENDENT_HOLDOUT_O_SAMPLES,
} from '../src/jobs/matching/independent-holdout-o-fixture'
import { normalizeSimilarity, scoreMatch } from '../src/jobs/matching/scoring'
import { errorMessage, logErrorEvent, logEvent } from '../src/log'

async function probeHardRules(
  db: ReturnType<typeof createDb>,
  engine: ReturnType<typeof createMatchEngine>,
  pair: { listing: typeof listings.$inferSelect; wish: typeof wishes.$inferSelect },
  mode: 'v1' | 'hybrid',
) {
  const target = and(eq(matches.listingId, pair.listing.id), eq(matches.wishId, pair.wish.id))
  const matched = async () => {
    const [row] = await db.select({ score: matches.score }).from(matches).where(target)
    return row !== undefined && row.score >= MATCH_SCORE_THRESHOLD
  }
  // 仅在人工 scratch 中改非文本字段，保留 embedding freshness；不是生产实体编辑流程。
  const scenarios = [
    {
      name: 'listing-status',
      apply: sql`UPDATE listings SET status = 'SOLD' WHERE id = ${pair.listing.id}`,
      restore: sql`UPDATE listings SET status = ${pair.listing.status} WHERE id = ${pair.listing.id}`,
    },
    {
      name: 'listing-moderation',
      apply: sql`UPDATE listings SET moderation_status = 'BLOCKED' WHERE id = ${pair.listing.id}`,
      restore: sql`UPDATE listings SET moderation_status = ${pair.listing.moderationStatus} WHERE id = ${pair.listing.id}`,
    },
    {
      name: 'wish-status',
      apply: sql`UPDATE wishes SET status = 'CLOSED' WHERE id = ${pair.wish.id}`,
      restore: sql`UPDATE wishes SET status = ${pair.wish.status} WHERE id = ${pair.wish.id}`,
    },
    {
      name: 'self-owned',
      apply: sql`UPDATE wishes SET user_id = ${pair.listing.sellerId} WHERE id = ${pair.wish.id}`,
      restore: sql`UPDATE wishes SET user_id = ${pair.wish.userId} WHERE id = ${pair.wish.id}`,
    },
  ]
  const results = []
  for (const scenario of scenarios) {
    await db.delete(matches).where(target)
    try {
      await db.execute(scenario.apply)
      await engine.matchWish(pair.wish.id)
      const wishMatch = await matched()
      await engine.matchListing(pair.listing.id)
      const listingMatch = await matched()
      results.push({
        mode,
        rule: scenario.name,
        wishMatch,
        listingMatch,
        passed: !wishMatch && !listingMatch,
      })
    } finally {
      await db.execute(scenario.restore)
      await db.delete(matches).where(target)
    }
  }
  return results
}

const args = Bun.argv.slice(2)
if (args.some((arg) => !['--reuse-baseline', '--independent', '--independent-o'].includes(arg)))
  throw new Error('仅支持 --reuse-baseline / --independent / --independent-o')
const reuseBaseline = args.includes('--reuse-baseline')
const independentO = args.includes('--independent-o')
const independentValidation = args.includes('--independent') || independentO
if (independentValidation && reuseBaseline)
  throw new Error('新独立集不能复用 H 组 baseline，未出网')
if (args.includes('--independent') && independentO) throw new Error('一次只能测一个独立集')
const samples = independentO
  ? INDEPENDENT_HOLDOUT_O_SAMPLES
  : independentValidation
    ? INDEPENDENT_HOLDOUT_SAMPLES
    : HOLDOUT_SAMPLES
const validationSet = independentO ? 'O01-O24' : independentValidation ? 'N01-N24' : 'H01-H24'
// 每组独立证据文件：N 的历史冻结与结果不能被 O 覆盖。
const freezePath = independentO
  ? '.m4-evidence/holdout-independent-o-freeze.json'
  : '.m4-evidence/holdout-independent-freeze.json'
const resultPath = independentO
  ? '.m4-evidence/holdout-independent-o-result.json'
  : independentValidation
    ? '.m4-evidence/holdout-independent-result.json'
    : reuseBaseline
      ? '.m4-evidence/holdout-regression.json'
      : '.m4-evidence/holdout-result.json'
const inputHash = contentHashOf(JSON.stringify(samples))
const BUDGET_PATH = '.m4-evidence/closeout-http-budget.json'
const HTTP_BUDGET = 200
const embeddingEnv = loadEmbeddingEnv()
if (embeddingEnv.transport !== 'live' || embeddingEnv.model !== 'text-embedding-v4') {
  throw new Error('本轮仅授权 live text-embedding-v4；配置不符，未出网')
}
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('需要本地 DATABASE_URL')
const baseUrl = new URL(databaseUrl)
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(baseUrl.hostname)) {
  throw new Error('独立验证仅允许本地 scratch DB，未出网')
}
const budgetFile = Bun.file(BUDGET_PATH)
const prior: unknown = (await budgetFile.exists()) ? await budgetFile.json() : { requests: 0 }
if (
  typeof prior !== 'object' ||
  prior === null ||
  !('requests' in prior) ||
  typeof prior.requests !== 'number' ||
  !Number.isSafeInteger(prior.requests) ||
  prior.requests < 0 ||
  prior.requests >= HTTP_BUDGET
) {
  throw new Error('本轮 HTTP 预算无效或已耗尽；先询问 Owner')
}
const usedBefore = prior.requests
const gate = createEmbeddingRequestGate({
  requestsPerSecond: 1,
  maxRequests: HTTP_BUDGET - usedBefore,
})
const provider = createEmbeddingProvider(embeddingEnv, {
  beforeRequest: async () => {
    await gate.beforeRequest()
    // 先持久化再出网：即使被中断，重跑也不重置本轮预算。
    await Bun.write(
      BUDGET_PATH,
      JSON.stringify({ requests: usedBefore + gate.requests, limit: HTTP_BUDGET }),
    )
  },
  onRequest: (event) =>
    logEvent({ event: 'holdout.embed.request', model: provider.model, ...event }),
})
if (provider.dimensions !== 1536) throw new Error('本轮仅授权1536维；配置不符，未出网')
const scratchName = `fish322_holdout_${Date.now()}_${process.pid}`
const scratchUrl = new URL(databaseUrl)
scratchUrl.pathname = `/${scratchName}`
const admin = createDb(databaseUrl)
let db: ReturnType<typeof createDb> | null = null
let created = false
let passed = false

// 实现摘要：与冻结记录用同一份算法文件清单。非独立运行时也要算——单独看一个 result JSON
// 就能判断它是哪份实现跑出来的（复审 F6）。除打分/门禁算法外，还覆盖两段会被测量结果吃进去的代码：
// ① provider 装配与 live provider 本身（被测量的向量就是它产出的，model/dimensions 之外若加入
// 归一化/截断这类变换，冻结必须能发现）；② M4 的向量新鲜度路径（handler 的版本推进、愿望侧补投、
// 实体 `updated_at` 的时钟语义、embeddings 表的列定义）（第二轮复审 F2 + 本轮复审 F3）。
const algorithmFiles = [
  'apps/worker/src/jobs/matching/constraints.ts',
  'apps/worker/src/jobs/matching/scoring.ts',
  'apps/worker/src/jobs/matching/engine.ts',
  'apps/worker/src/jobs/embedding/handlers.ts',
  'apps/worker/src/jobs/embedding/providers/index.ts',
  'apps/worker/src/jobs/embedding/providers/live.ts',
  'apps/api/src/modules/wishes/match-queue.ts',
  'packages/contracts/src/embedding/text.ts',
  'packages/contracts/src/matching/schema.ts',
  'packages/db/src/embedding-store.ts',
  'packages/db/src/schema/common.ts',
  'packages/db/src/schema/embeddings.ts',
]
const algorithmHashes = Object.fromEntries(
  await Promise.all(
    algorithmFiles.map(async (path) => [path, contentHashOf(await Bun.file(path).text())]),
  ),
)

try {
  if (independentValidation) {
    // 在任何测量之前固化输入/标签及实现摘要，结果不得反过来改变它们。
    const freeze = {
      validationSet,
      inputHash,
      algorithmHashes,
      model: provider.model,
      dimensions: provider.dimensions,
      samples,
    }
    if (await Bun.file(freezePath).exists()) {
      if (JSON.stringify(await Bun.file(freezePath).json()) !== JSON.stringify(freeze))
        throw new Error('独立集冻结记录不一致，未出网；需要新独立组')
    } else await Bun.write(freezePath, JSON.stringify(freeze, null, 2))
  }
  await admin.execute(sql.raw(`CREATE DATABASE "${scratchName}"`))
  created = true
  const migration = Bun.spawn(['bun', 'run', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: scratchUrl.toString() },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  if ((await migration.exited) !== 0) throw new Error('scratch migration 失败（未出网）')
  db = createDb(scratchUrl.toString())
  const engine = createMatchEngine(db, { embeddingModel: provider.model })
  const [seller, buyer] = await db
    .insert(users)
    .values([
      { studentNo: 'holdout-seller', passwordHash: 'test-not-real', nickname: '独立验证卖家' },
      { studentNo: 'holdout-buyer', passwordHash: 'test-not-real', nickname: '独立验证买家' },
    ])
    .returning({ id: users.id })
  if (!seller || !buyer) throw new Error('scratch 用户创建失败')

  const pairs = []
  for (const sample of samples) {
    const listingId = newId()
    const [listing] = await db
      .insert(listings)
      .values({
        id: listingId,
        listingNo: await reserveTestListingNo(db, listingId),
        sellerId: seller.id,
        ...sample.listing,
        condition: 'GOOD',
      })
      .returning()
    const [wish] = await db
      .insert(wishes)
      .values({ userId: buyer.id, ...sample.wish })
      .returning()
    if (!listing || !wish) throw new Error(`scratch 实体创建失败 ${sample.id}`)
    pairs.push({ sample, listing, wish })
  }

  // 真正执行 v1 fallback，并以目标 pair 的落库结果判断（不是仅比较 raw score）。
  const v1Results = new Map<string, boolean>()
  for (const pair of pairs) {
    await engine.matchWish(pair.wish.id)
    const [row] = await db
      .select()
      .from(matches)
      .where(and(eq(matches.listingId, pair.listing.id), eq(matches.wishId, pair.wish.id)))
    v1Results.set(pair.sample.id, row !== undefined && row.score >= MATCH_SCORE_THRESHOLD)
  }

  const positivePair = pairs[0]
  if (!positivePair?.sample.expectMatch) throw new Error('硬规则探针对照不是有效词法匹配')
  const hardRuleProbes = await probeHardRules(db, engine, positivePair, 'v1')

  // 文本构造走生产唯一入口，愿望 description 不省略。每批最多十条，含重试统一预算。
  const texts = pairs.flatMap(({ sample }) => [
    buildListingEmbeddingText(sample.listing),
    buildWishEmbeddingText(sample.wish),
  ])
  const vectors: number[][] = []
  if (reuseBaseline) {
    // 算法回归只需旧实测向量，不重复付费；这种结果不是新独立验证。
    const baseline: unknown = await Bun.file('.m4-evidence/holdout-baseline.json').json()
    if (
      typeof baseline !== 'object' ||
      baseline === null ||
      !('scratchName' in baseline) ||
      typeof baseline.scratchName !== 'string' ||
      !/^fish322_holdout_\d+_\d+$/.test(baseline.scratchName)
    ) {
      throw new Error('缺少合法 baseline scratch，未出网')
    }
    const cachedUrl = new URL(databaseUrl)
    cachedUrl.pathname = `/${baseline.scratchName}`
    const cachedDb = createDb(cachedUrl.toString())
    try {
      const rows = await cachedDb
        .select({ hash: embeddings.contentHash, vector: embeddings.embedding })
        .from(embeddings)
        .where(eq(embeddings.model, provider.model))
      const cache = new Map(rows.map((row) => [row.hash, row.vector]))
      for (const text of texts) {
        const vector = cache.get(contentHashOf(text))
        if (!vector || vector.length !== provider.dimensions)
          throw new Error('baseline 向量缺失或维度不符，未出网')
        vectors.push(vector)
      }
    } finally {
      await cachedDb.$client.close()
    }
  } else {
    for (let start = 0; start < texts.length; start += 10) {
      vectors.push(...(await provider.embed(texts.slice(start, start + 10))))
    }
  }
  for (const [index, pair] of pairs.entries()) {
    const listingVector = vectors[index * 2]
    const wishVector = vectors[index * 2 + 1]
    if (!listingVector || !wishVector) throw new Error('provider 向量条数不符')
    for (const input of [
      {
        entity: { kind: 'listing' as const, id: pair.listing.id },
        embedding: listingVector,
        sourceUpdatedAt: pair.listing.updatedAt,
        text: texts[index * 2],
      },
      {
        entity: { kind: 'wish' as const, id: pair.wish.id },
        embedding: wishVector,
        sourceUpdatedAt: pair.wish.updatedAt,
        text: texts[index * 2 + 1],
      },
    ]) {
      if (!input.text) throw new Error('缺少 embedding 文本')
      const saved = await saveEmbedding(db, {
        ...input,
        model: provider.model,
        dimensions: provider.dimensions,
        contentHash: contentHashOf(input.text),
      })
      if (!saved) throw new Error('scratch 向量 CAS 写入失败')
    }
  }

  const results = []
  for (const pair of pairs) {
    const distances = await db.execute(sql`
      SELECT 1 - (l.embedding <=> w.embedding) AS similarity FROM embeddings l, embeddings w
      WHERE l.listing_id = ${pair.listing.id} AND w.wish_id = ${pair.wish.id}
        AND l.model = ${provider.model} AND w.model = ${provider.model}
    `)
    const distance: unknown = Array.isArray(distances) ? distances[0] : null
    if (
      typeof distance !== 'object' ||
      distance === null ||
      !('similarity' in distance) ||
      typeof distance.similarity !== 'number' ||
      !Number.isFinite(distance.similarity)
    ) {
      throw new Error('pgvector cosine 不可用')
    }
    const similarity = distance.similarity
    const breakdown = scoreConstrainedMatch(pair.sample.listing, pair.sample.wish, { similarity })
    const wishRun = await engine.matchWish(pair.wish.id)
    const [wishRow] = await db
      .select()
      .from(matches)
      .where(and(eq(matches.listingId, pair.listing.id), eq(matches.wishId, pair.wish.id)))
    const wishMatch = wishRow !== undefined && wishRow.score >= MATCH_SCORE_THRESHOLD
    const listingRun = await engine.matchListing(pair.listing.id)
    const [listingRow] = await db
      .select()
      .from(matches)
      .where(and(eq(matches.listingId, pair.listing.id), eq(matches.wishId, pair.wish.id)))
    const hybridMatch = listingRow !== undefined && listingRow.score >= MATCH_SCORE_THRESHOLD
    const eligible =
      (pair.wish.category === null || pair.wish.category === pair.listing.category) &&
      (pair.wish.budgetMaxCents === null || pair.listing.priceCents <= 2 * pair.wish.budgetMaxCents)
    results.push({
      id: pair.sample.id,
      expected: pair.sample.expectMatch,
      similarity,
      ...breakdown,
      eligible,
      v1Score: scoreMatch(pair.sample.listing, pair.sample.wish, null).score,
      v1Match: v1Results.get(pair.sample.id) ?? false,
      semanticOnlyMatch: eligible && normalizeSimilarity(similarity) >= MATCH_SCORE_THRESHOLD,
      hybridMatch,
      wishMatch,
      directionsAgree: wishMatch === hybridMatch,
      vectorRecall: wishRun.recall === 'vector-topk' && listingRun.recall === 'vector-topk',
    })
  }
  const positiveResult = results[0]
  const hardRuleProbeControlValid =
    v1Results.get(positivePair.sample.id) === true && positiveResult?.hybridMatch === true
  hardRuleProbes.push(...(await probeHardRules(db, engine, positivePair, 'hybrid')))
  const summary = {
    samples: results.length,
    hardRuleProbeControlValid,
    hardRuleProbeViolations: hardRuleProbes.filter((probe) => !probe.passed).length,
    hybridAgreements: results.filter((row) => row.hybridMatch === row.expected).length,
    v1Agreements: results.filter((row) => row.v1Match === row.expected).length,
    semanticOnlyAgreements: results.filter((row) => row.semanticOnlyMatch === row.expected).length,
    // Owner 裁决显式披露的已知口径分歧：按标签判定不计入 `falsePositiveIds`，但必须可见，
    // 否则这个已知错配在唯一剩下的独立 live 门禁里会消失（复审 F3）。
    knownDivergenceIds: independentO ? [...INDEPENDENT_HOLDOUT_O_KNOWN_DIVERGENCES] : [],
    falsePositiveIds: results
      .filter((row) => row.hybridMatch && !row.expected)
      .map((row) => row.id),
    falseNegativeIds: results
      .filter((row) => !row.hybridMatch && row.expected)
      .map((row) => row.id),
    hardRuleViolationIds: results
      .filter((row) => !row.eligible && row.hybridMatch)
      .map((row) => row.id),
    directionMismatchIds: results.filter((row) => !row.directionsAgree).map((row) => row.id),
    allVectorRecall: results.every((row) => row.vectorRecall),
    httpRequests: gate.requests,
    cumulativeHttpRequests: usedBefore + gate.requests,
  }
  passed =
    summary.samples === 24 &&
    summary.hybridAgreements >= 22 &&
    summary.falsePositiveIds.length <= 1 &&
    summary.hybridAgreements > summary.v1Agreements &&
    summary.hardRuleViolationIds.length === 0 &&
    summary.hardRuleProbeControlValid &&
    summary.hardRuleProbeViolations === 0 &&
    summary.directionMismatchIds.length === 0 &&
    summary.allVectorRecall
  logEvent({
    event: 'holdout.samples',
    model: provider.model,
    dimensions: provider.dimensions,
    rows: results,
  })
  logEvent({
    event: 'holdout.summary',
    model: provider.model,
    ...summary,
    passed,
    independentValidation,
    validationSet,
    inputHash,
    scratchName,
  })
  await Bun.write(
    resultPath,
    JSON.stringify(
      {
        model: provider.model,
        dimensions: provider.dimensions,
        results,
        hardRuleProbes,
        summary,
        passed,
        independentValidation,
        validationSet,
        inputHash,
        algorithmHashes,
        scratchName,
      },
      null,
      2,
    ),
  )
  if (!passed) process.exitCode = 1
} catch (error) {
  logErrorEvent({ event: 'holdout.failed', error: errorMessage(error) })
  process.exitCode = 1
} finally {
  await db?.$client.close()
  if (created && passed) await admin.execute(sql.raw(`DROP DATABASE "${scratchName}"`))
  else if (created) logEvent({ event: 'holdout.scratch.retained', scratchName })
  await admin.$client.close()
}
