/**
 * #324 M9 拍照识图搜索 **DB 端到端腿**：真 Postgres + 真 MinIO + 真 `createVisualSearchService`。
 *
 * ## 为什么需要第二条腿
 *
 * `visual:eval`（离线腿）评的是 `ranking.ts` 的**排序层**：相似度是人工标注的，不出网、不连库。
 * 但 M9 要的另外两个指标——**empty-result rate 与 latency**——只有真跑才有意义：
 * - 空结果取决于可见性过滤与召回集的交互，标注 fixture 里没有这两个东西；
 * - 延迟取决于 S3 读字节、向量召回、卡片装配的真实耗时。
 *
 * ## 与 `visual:eval` 的分工（不要混用口径）
 *
 * 本腿**不评** Recall/NDCG/MRR：stub provider 的图片向量是"字节哈希铺开"的，同款不同图在它
 * 眼里彼此正交，拿它算排序质量只有随机数级的结论。这里只回答三个可被 stub 可靠回答的问题：
 * 1. 相同字节的查询图能不能命中目标商品（端到端链路通不通）；
 * 2. **可见性过滤是否生效**（下架 / 未过审的商品绝不出现在结果里）；
 * 3. 真实延迟分布与空结果率。
 *
 * `transport=live`（`--transport=live`）时向量来自真实上游，那时延迟分位才是"线上口径"；
 * 默认 `stub` 是为了让 CI / 本机能确定性重跑。
 *
 * ## 为什么要 scratch 库而不是直接用 dev 库
 *
 * 本腿要往 listings / listing_images 写真实行、往 MinIO 放真实对象。写 dev 库会污染并行开发的
 * 数据；所以照 `core-smoke.ts` 的做法建一个 `fish_visual_eval_<pid>_<ms>` 的 scratch 库，
 * 只对它 `db:migrate`（**不 seed**——seed 的种子封面指向 MinIO 里不存在的对象，见
 * `packages/db/src/seed.ts:103`，依赖它只会得到一个假失败）。跑完自动 drop；失败时保留现场
 * 并把库名 / 对象 key 打进报告，便于复查。
 *
 * ## 为什么放 apps/api/scripts
 *
 * 脚本要直接 import `@fish/db/*`、`drizzle-orm`、`@fish/visual-embedding/*`，而根 node_modules
 * 里没有这些依赖（Bun workspace 不提升），`apps/api` 同时具备它们且 tsconfig 把 `scripts`
 * 纳入 typecheck（与 `core-smoke.ts` 同一个理由）。
 *
 * 用法：`bun run visual:eval:db`（需先 `bun run db:up`）。
 */

import { VISUAL_EMBED_JOB_TYPES } from '@fish/contracts/visual/jobs'
import {
  VISUAL_RECALL_MIN_SIMILARITY,
  VISUAL_SEARCH_STRATEGY_VERSION,
} from '@fish/contracts/visual/ranking'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { listingVisualEmbeddings } from '@fish/db/schema/visual-embeddings'
import { visualSearchAttempts } from '@fish/db/schema/visual-search-attempts'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv, loadVisualEmbeddingEnv, type ServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { eq } from 'drizzle-orm'
import { enqueueVisualEmbedJob } from '../../worker/src/jobs/visual-embedding/enqueue'
import { createVisualEmbedJobHandlers } from '../../worker/src/jobs/visual-embedding/handlers'
import { createWorkerMediaStorage } from '../../worker/src/media-storage'
import { createBunS3MediaStorage } from '../src/modules/uploads/storage'
import { emptyResultRate, latencyPercentile } from '../src/modules/visual-search/eval/metrics'
import { createVisualParser } from '../src/modules/visual-search/parse'
import { VISUAL_RECALL_LIMIT, VISUAL_RESULT_LIMIT } from '../src/modules/visual-search/ranking'
import {
  createVisualSearchRateLimiter,
  type VisualSearchAttemptSubject,
} from '../src/modules/visual-search/rate-limit'
import {
  createVisualSearchService,
  type VisualSearchService,
  VisualSearchServiceError,
} from '../src/modules/visual-search/service'
import { createVisualSearchStore } from '../src/modules/visual-search/store'
import type { ResolvedVisualSearchSubject } from '../src/modules/visual-search/subject'

// ---------------------------------------------------------------------------
// 测试用图片字节（照 core-smoke：1×1 合法 JPEG 带 SOI/EOI 才是 sniffImageMime 认可的图）
// ---------------------------------------------------------------------------

/** 1×1 合法 JPEG（最小可用图，`sniffImageMime` 按魔术字节认可）。 */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)
/** 目标商品封面 + 查询图共用的字节：相同字节 ⇒ stub 下同向量 ⇒ 余弦距离 0。 */
const PRODUCT_BYTES = JPEG
/** 另一张合法但不同的图：用于验证"字节不同则向量不同"。 */
const OTHER_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKg//2Q==',
  'base64',
)
/**
 * **真正的无关查询图**：与 `PRODUCT_BYTES`、`OTHER_BYTES` 都不同的第三张 1×1 合法 JPEG。
 *
 * 为什么必须单独有一份：这一腿的"无关图片查询"原先用的是 `OTHER_BYTES`，而 `OTHER_BYTES`
 * 恰好就是 `decoy` 的封面字节（见下方 `visual.write(decoyKey, OTHER_BYTES)`）——也就是说那条
 * "无关图片查询"其实是 decoy 的**同字节查询**，它命中 decoy 是设计使然，证明不了任何事。
 *
 * 这份字节是在只改 `PRODUCT_BYTES` 最后几个扫描数据字节的候选里挑出来的：stub provider
 * （`sha256(mime + bytes)` 的 4 位十六进制分块）下它与 `PRODUCT_BYTES`、`OTHER_BYTES`
 * 的余弦相似度**都恰好是 0**，所以"无关"这件事在 stub 空间里是可判定的、不是碰巧。
 */
const UNRELATED_BYTES = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKgH/2Q==',
  'base64',
)
/**
 * 随机字节：**不是图片**。服务端按对象真实内容判定（`sniffImageMime`），所以这一类查询必须
 * 被 422 `VISUAL_SEARCH_IMAGE_INVALID` 挡下——这本身就是要验证的防线。
 */
const RANDOM_BYTES = Buffer.from(Array.from({ length: 512 }, (_, index) => (index * 37 + 11) % 256))

// ---------------------------------------------------------------------------
// 输出与断言（照 core-smoke 的风格：中文标签 + 实得值）
// ---------------------------------------------------------------------------

let failures = 0
let step = '启动'

function section(title: string): void {
  console.log(`\n[visual-eval-db] ===== ${title} =====`)
}

function ok(label: string): void {
  console.log(`✓ ${label}`)
}

function assert(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    ok(label)
    return
  }
  failures += 1
  const suffix = detail === undefined ? '' : `｜实得：${JSON.stringify(detail)}`
  console.error(`✗ [${step}] ${label}${suffix}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(Object.is(actual, expected), label, { actual, expected })
}

function fixed(value: number, digits = 3): string {
  return value.toFixed(digits)
}

/** 毫秒保留 1 位，避免报告里出现 `12.345678901` 这种噪声。 */
function ms(value: number): string {
  return `${value.toFixed(1)}ms`
}

// ---------------------------------------------------------------------------
// scratch 库与 scratch 对象
// ---------------------------------------------------------------------------

/** 把连接串的库名换掉（只动 pathname 的最后一段，不动 query / 凭据）。 */
function scratchUrl(base: string, database: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  return url.toString()
}

/**
 * 建 scratch 库。上一次被硬杀（Ctrl-C / 超时）留下的同名库会让 `create database` 报 42P04，
 * 而那个错误与真实原因无关（core-smoke 同款处理：先无条件 drop）。
 */
async function createScratchDatabase(env: ServerEnv, database: string): Promise<string> {
  const adminUrl = scratchUrl(env.DATABASE_URL, 'postgres')
  const admin = createDb(adminUrl)
  try {
    await admin.$client.unsafe(`drop database if exists "${database}" with (force)`)
    await admin.$client.unsafe(`create database "${database}"`)
  } finally {
    await admin.$client.close()
  }
  return scratchUrl(env.DATABASE_URL, database)
}

/** 走 README 里那条文档化命令，不自己执行迁移文件（生成文件不可手改）。 */
async function runDbMigrate(dbUrl: string): Promise<void> {
  const repoRoot = new URL('../../../', import.meta.url).pathname
  const proc = Bun.spawn(['bun', 'run', 'db:migrate'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`db:migrate 失败（exit ${exitCode}）\n${stdout}\n${stderr}`)
  }
}

/**
 * 商品封面对象键必须落在**公开读白名单**的形状里：`listings/{usr_…}/{med_…}.{ext}`。
 *
 * 这不是"好看"的问题：`MediaStorage.publicUrl` 对不认识的命名空间是 fail-closed 抛错
 * （`旧媒体 URL 代理未配置`），而结果卡片要拼封面 URL。所以两段都用规范公开 ID 编码，
 * 而不是把裸 UUID 拼进路径。
 */
function listingObjectKey(ownerPublicId: string, tag: string): string {
  return `listings/${ownerPublicId}/${tag}.jpg`
}

// ---------------------------------------------------------------------------
// 造数据（走真实写入路径：真实商品行 + 真实图片对象 + 真实向量）
// ---------------------------------------------------------------------------

type FixtureListing = {
  id: string
  label: string
  /** 该商品写库时用的封面对象键。 */
  objectKey: string
  category: 'DIGITAL' | 'BOOKS'
  status: 'ACTIVE' | 'OFFLINE'
  moderationStatus: 'APPROVED' | 'BLOCKED'
  favoriteHint: string
  /**
   * 相对"现在"往前推多少天写 `listings.created_at`。
   *
   * 为什么必须可控：`scoreVisualCandidate` 里 freshness（权重 0.1）与 popularity（0.05）
   * 是**并列分数的裁决者**。stub 下"无关查询图"对两件可见商品的余弦相似度都是 0，
   * 名次完全由这两项决定；若 4 件商品都在同一毫秒插入，freshness 并列、收藏都是 0，
   * "第 1 名是谁"就变成实现细节而不是可断言的期望。把 decoy 写新一点，
   * 名次才有确定性依据（见下面"名次断言"一节）。
   */
  ageDays: number
}

type SeedListingInput = {
  db: Db
  sellerId: string
  visual: VisualMediaWriter
  spec: Omit<FixtureListing, 'id' | 'objectKey'>
}

/** 写入商品 + 封面行 + MinIO 对象，返回该商品的 fixture 描述。 */
async function seedListing(input: SeedListingInput): Promise<FixtureListing> {
  const { db, sellerId, visual, spec } = input
  const id = newId()
  const listingNo = await reserveTestListingNo(db, id)
  await db.insert(listings).values({
    id,
    listingNo,
    sellerId,
    title: spec.label,
    description: `${spec.label}（#324 M9 DB 端到端腿的测试数据）`,
    priceCents: 12_800,
    category: spec.category,
    condition: 'GOOD',
    status: spec.status,
    moderationStatus: spec.moderationStatus,
    createdAt: new Date(Date.now() - spec.ageDays * 86_400_000),
  })
  const objectKey = listingObjectKey(
    encodePublicId(PUBLIC_ID_PREFIX.user, sellerId),
    encodePublicId(PUBLIC_ID_PREFIX.media, newId()),
  )
  await visual.write(objectKey, PRODUCT_BYTES)
  await db.insert(listingImages).values({ id: newId(), listingId: id, objectKey, sortOrder: 0 })
  return { ...spec, id, objectKey }
}

/**
 * 跑一次真实的向量化写入。走 Worker 的 handler（`createVisualEmbedJobHandlers`）而不是手插
 * `listing_visual_embeddings`：手插会绕过"读封面键 → 读字节 → 调 provider → 维度校验"整条
 * 生产路径，正是这条腿要想验证的东西。
 *
 * **不硬编码模型名**：先读整行、拿 `model` 再按 model 用（照 core-smoke 的 `visualEmbeddingRow`）。
 */
async function embedListing(
  db: Db,
  handlers: ReturnType<typeof createVisualEmbedJobHandlers>,
  listingId: string,
): Promise<void> {
  const payload = { listingId }
  const result = await handlers[VISUAL_EMBED_JOB_TYPES.listing](payload)
  assert(
    result.status === 'generated',
    `商品 ${listingId} 生成向量（handler status = generated）`,
    result,
  )
  const rows = await db
    .select()
    .from(listingVisualEmbeddings)
    .where(eq(listingVisualEmbeddings.listingId, listingId))
    .limit(1)
  const row = rows[0]
  assert(row !== undefined, `商品 ${listingId} 有向量行`)
  if (row !== undefined) {
    assertEqual(
      row.sourceObjectKey,
      result.sourceObjectKey,
      `向量行 source_object_key = 当前封面键`,
    )
    assert(row.embedding !== null, `向量行 embedding 非空（model = ${row.model}）`)
    assertEqual(row.dimensions, 1024, '向量维度 = 1024（迁移里的 vector(1024)）')
  }
}

/** 往 MinIO 写真实对象的窄接口（`S3MediaStorage.writeMediaBytes` 的必选投影）。 */
type VisualMediaWriter = { write(key: string, bytes: Uint8Array): Promise<void> }

// ---------------------------------------------------------------------------
// 度量
// ---------------------------------------------------------------------------

/**
 * 一次查询的**期望**。做成判别联合而不是第一版的 `expectedListingId: string | null`：
 * `null` 那个写法正是"恒真断言"的来源（负样本分支退化成 `!internalIds.includes('')`，
 * 见 `runQuery` 里的注释）。负样本必须显式给出"不能排第一"的那条商品，断言才有地方挂。
 *
 * - `must-hit`：目标商品必须出现在结果里（同字节查询，stub 与 live 都成立）。
 * - `must-not-be-first`：目标商品**不能是第 1 名**（无关查询）。
 */
type QueryExpectation =
  | { kind: 'must-hit'; listingId: string }
  | { kind: 'must-not-be-first'; listingId: string }

type SearchRun = {
  label: string
  latencyMs: number
  itemCount: number
  /** 这一条查询的期望；`printRunTable` 与断言都从这里读，避免两处口径漂移。 */
  expect: QueryExpectation
  hit: boolean
  empty: boolean
  /** 4xx / 503 这一类"没跑成"的结果：不计入延迟分位与空结果率，单独数。 */
  failed: boolean
  /** 失败时的错误码，用于断言"是哪一道防线挡下的"。 */
  failureCode: string | null
  topId: string | null
  /** 结果里的商品内部 id（已从公开 ID 解码），供可见性断言直接读。 */
  internalIds: string[]
}

/** 第 1 名的内部 id（结果为空时 `null`）。名次断言的唯一读法，避免各处写 `internalIds[0] ?? null`。 */
function topInternalIdOf(run: SearchRun): string | null {
  return run.internalIds[0] ?? null
}

function printRunTable(runs: SearchRun[]): void {
  console.log('| 样本 | 期望 | 实得条数 | 第 1 名 | 判定 | 延迟 |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const run of runs) {
    const expect = run.expect.kind === 'must-hit' ? '命中目标' : '目标不得第 1 名'
    const verdict = run.failed
      ? `✗ 请求失败（${run.failureCode ?? '未知'}）`
      : run.hit
        ? '✅ 符合预期'
        : '❌ 不符预期'
    console.log(
      `| \`${run.label}\` | ${expect} | ${run.itemCount} | \`${run.topId ?? '—'}\` | ${verdict} | ${ms(run.latencyMs)} |`,
    )
  }
}

/** 服务不可用（无向量 / provider 挂了）不该混进延迟分位——它不是"一次成功的搜索"。 */
function searchableRuns(runs: SearchRun[]): SearchRun[] {
  return runs.filter((run) => !run.failed)
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const transport = ((): 'stub' | 'live' => {
  const override = process.argv.find((arg) => arg.startsWith('--transport='))?.split('=')[1]
  const raw = override ?? process.env.VISUAL_EMBEDDING_TRANSPORT ?? 'stub'
  if (raw !== 'stub' && raw !== 'live') {
    throw new Error(`VISUAL_EMBEDDING_TRANSPORT 只能是 stub | live，实得：${raw}`)
  }
  return raw
})()

const keepScratch = process.argv.includes('--keep')
const database = `fish_visual_eval_${process.pid}_${Date.now()}`
const uploadedObjectKeys: string[] = []

let db: Db | null = null
let dbUrl: string | null = null

section(`准备工作（transport=${transport}，scratch 库 ${database}）`)
const env = loadServerEnv()
const visualEnv = loadVisualEmbeddingEnv({ ...process.env, VISUAL_EMBEDDING_TRANSPORT: transport })
const provider = createVisualEmbeddingProvider(visualEnv)
console.log(
  `- provider：model=${provider.model} dimensions=${provider.dimensions} transport=${transport}`,
)
console.log(`- 目标接口：createVisualSearchService(...).search(subject, { objectKey })`)
console.log(`- 说明：本腿不评 Recall/NDCG（stub 的图片向量是字节哈希，同款不同图彼此正交）`)

let search: VisualSearchService | null = null
try {
  dbUrl = await createScratchDatabase(env, database)
  ok(`scratch 库已建：${database}`)

  step = '迁移'
  section('scratch 库迁移（不 seed：seed 封面指向不存在的对象）')
  await runDbMigrate(dbUrl)
  ok('bun run db:migrate 在空库成功')

  db = createDb(dbUrl)

  step = '造数据'
  section('造数据：卖家 + 4 件商品（真实对象 + 真实向量）')
  const sellerId = newId()
  await db.insert(users).values({ id: sellerId, nickname: 'visual-eval-db 卖家' })

  const s3 = new Bun.S3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
  })
  const mediaStorage = createBunS3MediaStorage({
    client: s3,
    publicUrlBase: env.S3_PUBLIC_URL,
  })
  const writeMediaBytes = mediaStorage.writeMediaBytes
  if (writeMediaBytes === undefined) {
    throw new Error('storage.writeMediaBytes 缺失：本腿需要往 MinIO 写真实对象')
  }
  const visual: VisualMediaWriter = {
    write: async (key, bytes) => {
      await writeMediaBytes(key, bytes, 'image/jpeg')
      uploadedObjectKeys.push(key)
    },
  }

  const target = await seedListing({
    db,
    sellerId,
    visual,
    spec: {
      label: '目标：九成新机械键盘',
      category: 'DIGITAL',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      favoriteHint: '与查询图字节相同的在售商品',
      ageDays: 30,
    },
  })
  const offlineTwin = await seedListing({
    db,
    sellerId,
    visual,
    spec: {
      label: '下架：同款机械键盘',
      category: 'DIGITAL',
      status: 'OFFLINE',
      moderationStatus: 'APPROVED',
      favoriteHint: '同字节但已下架，必须被可见性过滤掉',
      ageDays: 30,
    },
  })
  const blockedTwin = await seedListing({
    db,
    sellerId,
    visual,
    spec: {
      label: '未过审：同款机械键盘',
      category: 'DIGITAL',
      status: 'ACTIVE',
      moderationStatus: 'BLOCKED',
      favoriteHint: '同字节但在售未过审，必须被可见性过滤掉',
      ageDays: 30,
    },
  })
  const decoy = await seedListing({
    db,
    sellerId,
    visual,
    spec: {
      label: '干扰：一本二手教材',
      category: 'BOOKS',
      status: 'ACTIVE',
      moderationStatus: 'APPROVED',
      favoriteHint: '不同字节的无关在售商品',
      ageDays: 1,
    },
  })
  // `decoy` 的封面换成另一张图，确保它与查询图**不是**同一个对象键、字节也不同。
  const decoyKey = listingObjectKey(
    encodePublicId(PUBLIC_ID_PREFIX.user, sellerId),
    encodePublicId(PUBLIC_ID_PREFIX.media, newId()),
  )
  await visual.write(decoyKey, OTHER_BYTES)
  await db
    .update(listingImages)
    .set({ objectKey: decoyKey })
    .where(eq(listingImages.listingId, decoy.id))
  ok(`商品行已写：目标 1 件、下架 1 件、未过审 1 件、干扰 1 件`)

  const workerStorage = createWorkerMediaStorage(s3)
  const handlers = createVisualEmbedJobHandlers(db, provider, workerStorage)
  for (const item of [target, offlineTwin, blockedTwin, decoy]) {
    await enqueueVisualEmbedJob(db, item.id)
    await embedListing(db, handlers, item.id)
  }

  step = '装配服务'
  section('装配真实服务（in-process，直接调 service.search）')
  const store = createVisualSearchStore(db)
  const parser = createVisualParser({ transport: 'off' })
  const rateLimiter = createVisualSearchRateLimiter(db)
  const storageForSearch = mediaStorage
  const readMediaBytes = storageForSearch.readMediaBytes
  if (readMediaBytes === undefined) {
    throw new Error('storage.readMediaBytes 缺失：createVisualSearchService 会直接抛错')
  }
  search = createVisualSearchService({
    store,
    storage: storageForSearch,
    provider,
    parser,
    rateLimiter,
  })
  ok('createVisualSearchService 装配成功（storage 具备 readMediaBytes）')

  // 匿名主体键必须满足 `SUBJECT_PATTERN`（`/^[A-Za-z0-9_-]{1,64}$/`，**不含点**），
  // 因为 `search` 会核对 `visualQueryImageSubject(objectKey) === subject.key.subjectKey`。
  const subjectKey = newId().replaceAll('-', '')
  // `attempts` **不能是空数组**：`createVisualSearchRateLimiter().consume([])` 在第一行就
  // `return`（`rate-limit.ts` 的 `if (subjects.length === 0) return`），空数组等于限流根本没跑。
  // 这里给两个主体，与真实匿名请求一致（`subject.ts` 的解析器同时按 session 与 ip 计数）；
  // 本腿一共 8 次 search ⇒ 每个主体 8 行，远低于 `VISUAL_SEARCH_MAX_ATTEMPTS = 20`，不会误触。
  const attemptSubjects: VisualSearchAttemptSubject[] = [
    { subjectType: 'session', subjectKey },
    { subjectType: 'ip', subjectKey: `eval${subjectKey}` },
  ]
  const subject: ResolvedVisualSearchSubject = {
    key: { subjectType: 'session', subjectKey },
    attempts: attemptSubjects,
    issuedSessionId: null,
  }
  console.log(`- 匿名主体键：${subjectKey}（无点，满足 SUBJECT_PATTERN）`)
  console.log(
    `- 限流主体：${attemptSubjects.map((item) => item.subjectType).join(' + ')}（与真实匿名请求一致）`,
  )

  /** 写查询图对象 → 注册进 visual_query_images → 调 search。**只传 objectKey**。 */
  async function runQuery(input: {
    label: string
    bytes: Uint8Array
    expect: QueryExpectation
  }): Promise<SearchRun> {
    const objectKey = `visual-search/${subjectKey}/${newId().replaceAll('-', '')}.jpg`
    await visual.write(objectKey, input.bytes)
    const now = new Date()
    await store.registerQueryImage({
      objectKey,
      subjectType: subject.key.subjectType,
      subjectKey: subject.key.subjectKey,
      contentType: 'image/jpeg',
      sizeBytes: input.bytes.length,
      expiresAt: new Date(now.getTime() + 900_000),
    })
    const startedAt = performance.now()
    try {
      const response = await search?.search(subject, { objectKey })
      const latencyMs = performance.now() - startedAt
      const items = response?.items ?? []
      // 响应里是**公开 ID**（`lst_…`），库里是 UUIDv7；比较前必须解码，否则恒不相等。
      const internalIds = items.map((item) => decodePublicId(PUBLIC_ID_PREFIX.listing, item.id))
      const topId = items[0]?.id ?? null
      // **负样本分支不能恒真**。第一版写的是
      // `!internalIds.includes(input.expectedListingId ?? '')`：`expectedListingId` 为 null 时
      // 退化成 `!internalIds.includes('')`，而 `decodePublicId` 只返回规范 UUIDv7 或抛错、
      // 从不返回 `''`，所以那条断言**永远为 true**。
      // 现在的负样本判据是"目标不是第 1 名"（`must-not-be-first`），它是**能**为 false 的：
      // 把查询字节换成目标的封面字节就会 false——自证就是这么做的。
      // 为什么不用"目标不在结果里"：召回没有相似度下限，库里只要有可见向量，
      // target + decoy 两件必然全被带回，那种断言在当前数据下**不可能**失败，才是恒真的。
      const hit =
        input.expect.kind === 'must-not-be-first'
          ? internalIds[0] !== input.expect.listingId
          : internalIds.includes(input.expect.listingId)
      assertEqual(
        response?.strategyVersion,
        VISUAL_SEARCH_STRATEGY_VERSION,
        `${input.label}：strategyVersion = 生产版本`,
      )
      assertEqual(
        response?.embeddingModel,
        provider.model,
        `${input.label}：embeddingModel = 写库那个模型`,
      )
      // 结果条数必须同时受"召回上限"与"返回上限"约束。第一版完全没比对这两条，
      // 于是"某个改动让召回退化成不带 limit 的全表扫描"在报告里看不出来。
      assert(
        items.length <= VISUAL_RESULT_LIMIT,
        `${input.label}：结果条数 ≤ VISUAL_RESULT_LIMIT(${VISUAL_RESULT_LIMIT})`,
        { items: items.length },
      )
      assert(
        items.length <= VISUAL_RECALL_LIMIT,
        `${input.label}：结果条数 ≤ VISUAL_RECALL_LIMIT(${VISUAL_RECALL_LIMIT})`,
        { items: items.length },
      )
      return {
        label: input.label,
        latencyMs,
        itemCount: items.length,
        expect: input.expect,
        hit,
        empty: items.length === 0,
        failed: false,
        failureCode: null,
        topId,
        internalIds,
      }
    } catch (error) {
      const latencyMs = performance.now() - startedAt
      if (error instanceof VisualSearchServiceError) {
        // `VISUAL_SEARCH_NO_EMBEDDING` 是唯一"合理地空"的分支（库里一条向量都没有）。
        return {
          label: input.label,
          latencyMs,
          itemCount: 0,
          expect: input.expect,
          hit: false,
          empty: error.code === 'VISUAL_SEARCH_NO_EMBEDDING',
          failed: true,
          failureCode: error.code,
          topId: null,
          internalIds: [],
        }
      }
      throw error
    }
  }

  step = '主样本集'
  section('主样本集：确定性命中 / 相似度无关查询 / 非图片查询')
  const runs: SearchRun[] = []
  // 每条查询重复几次，让 p50/p95 有真实的样本量而不是单次抖动。查询图每次都是新对象键
  // （TTL 与"一图一用"的语义），所以重复不等于复用同一行。
  for (let round = 0; round < 3; round += 1) {
    runs.push(
      await runQuery({
        label: `同字节查询 #${round + 1}`,
        bytes: PRODUCT_BYTES,
        expect: { kind: 'must-hit', listingId: target.id },
      }),
    )
    runs.push(
      await runQuery({
        label: `无关图片查询 #${round + 1}`,
        // **不是** `OTHER_BYTES`：那份字节正是 decoy 的封面（见上面 `visual.write(decoyKey, …)`），
        // 用它当"无关查询"其实是在做 decoy 的同字节查询，命中 decoy 是设计使然。
        bytes: UNRELATED_BYTES,
        expect: { kind: 'must-not-be-first', listingId: target.id },
      }),
    )
  }
  // 非图片字节必须被"按对象真实内容判定"那道防线挡下（422 VISUAL_SEARCH_IMAGE_INVALID）。
  const nonImageRun = await runQuery({
    label: '非图片字节查询',
    bytes: RANDOM_BYTES,
    expect: { kind: 'must-not-be-first', listingId: target.id },
  })

  printRunTable([...runs, nonImageRun])
  console.log('')

  const positive = runs.filter((run) => run.label.startsWith('同字节'))
  const unrelated = runs.filter((run) => run.label.startsWith('无关图片'))

  // 前置守卫：无关查询图必须与**库内每一份封面字节**都不同。
  // 这条直接对应第一版的实测反证（"无关查询"用的就是 decoy 的封面字节）。
  // 它同时也是"这条断言能失败"的自证入口：把 `UNRELATED_BYTES` 换回 `OTHER_BYTES` 就会红。
  const coverBytes = [PRODUCT_BYTES, OTHER_BYTES]
  assert(
    coverBytes.every((cover) => !cover.equals(UNRELATED_BYTES)),
    '无关查询图的字节与库内任何封面都不同（不是某件商品的同字节查询）',
    { covers: coverBytes.length, bytes: UNRELATED_BYTES.length },
  )
  assert(
    !UNRELATED_BYTES.equals(RANDOM_BYTES),
    '无关查询图与非图片字节也不是同一份（否则会变成在验 422，而不是在验无关查询）',
  )

  assert(
    positive.every((run) => run.hit && !run.failed),
    '同字节查询全部命中目标商品（stub 与 live 都成立：同字节 ⇒ 同向量 ⇒ 距离 0）',
    positive.map((run) => ({ label: run.label, hit: run.hit, items: run.itemCount })),
  )
  // 无关图查询的"符合预期"判据**按 transport 分开**（#406 第 6 项）。两种口径都不能证明
  // 下限生效（那件事只能靠 live 语料重标，见本文件末尾），但必须各按各的事实判：
  // - stub：查询图与库内封面的余弦**恰好 0**（向量由字节决定）⇒ 相似度恰好 = 下限 0.5 ⇒
  //   判据 `>=` 取等号 ⇒ 一条都不剔 ⇒ 无关查询**必定非空**。所以这里保留严格的 `itemCount > 0`：
  //   放宽成 `hit` 会把"召回真的把候选剔空了"这类回归静默放过。
  // - live：余弦通常为正，空结果只在"两路都没有共同方向"时出现，是合法结局；
  //   这里允许空，否则一次合法剔空会被报成"名次回归"（与下面 stub 名次断言同一取舍）。
  assert(
    unrelated.every((run) => run.hit && !run.failed && (transport === 'live' || run.itemCount > 0)),
    transport === 'stub'
      ? 'stub：无关图片查询返回非空（stub 下余弦恰 0 ⇒ 相似度恰等于下限、取等号保留）且目标**不是第 1 名**'
      : 'live：无关图片查询目标**不是第 1 名**（空结果也算符合——理由见 runQuery 的注释）',
    unrelated.map((run) => ({
      label: run.label,
      items: run.itemCount,
      top: run.topId,
      topInternal: topInternalIdOf(run),
    })),
  )
  assertEqual(
    nonImageRun.failureCode,
    'VISUAL_SEARCH_IMAGE_INVALID',
    '非图片字节被 422 VISUAL_SEARCH_IMAGE_INVALID 挡下（服务端按对象真实内容判定）',
  )

  step = '可见性过滤'
  section('可见性过滤断言：同字节的下架 / 未过审商品绝不出现')
  const visibilityRun = await runQuery({
    label: '可见性查询（同字节）',
    bytes: PRODUCT_BYTES,
    expect: { kind: 'must-hit', listingId: target.id },
  })
  const visibleIds = new Set(visibilityRun.internalIds)
  assert(visibilityRun.hit, '可见性查询命中目标（同字节的同款在售商品）', {
    items: visibilityRun.itemCount,
  })
  assert(!visibleIds.has(offlineTwin.id), '下架商品（status=OFFLINE）不出现在结果里', {
    offlineTwin: offlineTwin.id,
  })
  assert(!visibleIds.has(blockedTwin.id), '未过审商品（moderationStatus=BLOCKED）不出现在结果里', {
    blockedTwin: blockedTwin.id,
  })
  assert(visibleIds.has(target.id), '目标在售商品出现在结果里（前两条不是"全军覆没"式的假通过）', {
    target: target.id,
  })
  assert(visibleIds.has(decoy.id), '不同字节但在售的干扰商品仍可被召回（过滤没有误伤在售商品）', {
    decoy: decoy.id,
  })

  // -------------------------------------------------------------------------
  // 名次断言（第一版完全缺失：`topId` 只打印、从不与期望比较）
  // -------------------------------------------------------------------------
  step = '名次断言'
  section('名次断言（只在 transport=stub 下判定）')
  console.log(
    `- 为什么只在 stub 下判：stub 的图片向量由字节决定，库内每一份封面字节都在本脚本手里，` +
      `所以"同字节查询第 1 名 = 目标""无关查询第 1 名 = 更'新鲜'的在售干扰项"都是**可判定**的。` +
      `live 下这两张 1×1 JPEG 在真实模型眼里几乎同向（实测 6 条查询的第 1 名全是 decoy，` +
      `连同字节查询也被 decoy 顶到第 2），名次由模型先验而不是排序逻辑决定——` +
      `把它写成断言只会让这条腿在换模型时随机变红。live 只打印实得名次。`,
  )
  if (transport === 'stub') {
    assert(
      positive.every((run) => topInternalIdOf(run) === target.id),
      'stub：同字节查询的第 1 名 = 目标商品',
      positive.map((run) => ({ label: run.label, top: topInternalIdOf(run), target: target.id })),
    )
    assert(
      unrelated.every((run) => run.hit && !run.failed && topInternalIdOf(run) === decoy.id),
      'stub：无关查询第 1 名 = 更新的在售干扰项（target 30 天前、decoy 1 天前，视觉分都是 0）。' +
        'stub 下余弦恰 0 ⇒ 相似度恰等于下限、`>=` 取等号保留 ⇒ 这里不会出现空结果，与上面那条 `itemCount > 0` 同源',
      unrelated.map((run) => ({ label: run.label, top: topInternalIdOf(run), decoy: decoy.id })),
    )
    assert(topInternalIdOf(visibilityRun) === target.id, 'stub：可见性查询的第 1 名 = 目标商品', {
      top: topInternalIdOf(visibilityRun),
      target: target.id,
    })
  } else {
    console.log(
      `- live 实测第 1 名（仅记录，不判定）：同字节 = ${positive
        .map((run) => run.topId)
        .join('、')}；无关 = ${unrelated.map((run) => run.topId).join('、')}；` +
        `可见性 = ${visibilityRun.topId}`,
    )
  }

  // -------------------------------------------------------------------------
  // 限流：证明 attempts 真的被 consume，而不是空数组空转
  // -------------------------------------------------------------------------
  step = '限流'
  section('限流确实执行了（不是 `consume([])` 的空转）')
  const issuedSearches = runs.length + 2 // 主样本集 + 非图片查询 + 可见性查询
  const attemptRows = await db
    .select({ id: visualSearchAttempts.id, subjectKey: visualSearchAttempts.subjectKey })
    .from(visualSearchAttempts)
  // scratch 库是本次现建的，除了这条腿没有别的写入者，所以全表行数就是本腿的行数。
  const sessionRows = attemptRows.filter((row) => row.subjectKey === subjectKey).length
  assert(
    sessionRows === issuedSearches &&
      attemptRows.length === issuedSearches * attemptSubjects.length,
    `限流插入行数 = 请求数 × 主体数（期望 session ${issuedSearches} 行 / 全表 ${issuedSearches * attemptSubjects.length} 行）`,
    {
      sessionRows,
      total: attemptRows.length,
      issuedSearches,
      subjects: attemptSubjects.length,
    },
  )

  step = '汇总'
  section(`汇总（transport=${transport}，scratch 库 ${database}）`)
  // `visibilityRun` 也真的发出了一次 search，必须计入请求数与延迟分位。
  const allRuns = [...runs, nonImageRun, visibilityRun]
  const usable = searchableRuns(allRuns)
  const rejected = allRuns.filter((run) => run.failed)
  const emptyCount = usable.filter((run) => run.empty).length
  const latencies = usable.map((run) => run.latencyMs)
  const p50 = latencyPercentile(latencies, 0.5)
  const p95 = latencyPercentile(latencies, 0.95)
  // "符合预期"要把**按预期被拒**也算进去：非图片查询的期望就是被 422 挡下，
  // 把它算成"不符合预期"会让这一行永远差 1（第一版打印 6/7 就是这么来的）。
  const expectedRejected = rejected.filter(
    (run) => run.failureCode === 'VISUAL_SEARCH_IMAGE_INVALID',
  ).length
  const hitCount = usable.filter((run) => run.hit).length
  console.log(`| 指标 | 值 |`)
  console.log(`| --- | --- |`)
  console.log(`| transport | ${transport} |`)
  console.log(`| provider model | ${provider.model} |`)
  console.log(`| 请求数 | ${allRuns.length} |`)
  console.log(`| 符合预期数 | ${hitCount + expectedRejected}/${allRuns.length} |`)
  console.log(`| 空结果数（2xx 但 items = 0） | ${emptyCount} |`)
  // 调被测函数，不复制公式：内联 `emptyCount / Math.max(usable.length, 1)` 会让
  // `metrics.emptyResultRate` 变成"只在单测里跑过的死代码"。
  console.log(`| empty-result rate（只算成功返回的请求） | ${fixed(emptyResultRate(usable))} |`)
  console.log(`| 被拒请求数（4xx/503，不计入延迟） | ${rejected.length} |`)
  console.log(`| p50 延迟 | ${ms(p50)} |`)
  console.log(`| p95 延迟 | ${ms(p95)} |`)
  console.log('')
  console.log(
    `- **这个数在 stub 下仍然是 0，但 0 的原因变了**（#406 第 6 项）：召回现在先按 ` +
      `\`VISUAL_RECALL_MIN_SIMILARITY = ${VISUAL_RECALL_MIN_SIMILARITY}\` 剔掉低于下限的候选` +
      `（两路取更强；相似度 = 1 - distance/2，0.5 即余弦正交）。` +
      `但 stub 的图片向量由字节决定，无关查询图与库内封面的余弦**恰好是 0**（见本文件顶部 stub 说明），` +
      `映射成相似度**恰好 0.5**，而判据是 \`>=\` ⇒ 取等号 ⇒ 一条都不剔。` +
      `⇒ **这条腿在 stub 下度量不了下限**：empty-result rate = 0 是"边界取等"的产物，不是"下限不存在"。` +
      `live 传输下无关图的余弦通常为正（相似度落在 0.6~0.8），同样过线——` +
      `下限真正的作用面是"两路都没有共同方向"（余弦 ≤ 0）的召回，那在真实语料上罕见，` +
      `所以下限够不够严必须用 live 语料重标（契约注释已写明这个前提）。` +
      `这条腿负责的是结构、可见性、错误码与延迟；无关查询的"符合预期"断言**按 transport 分开**：` +
      `stub 下仍要求非空（所以这个 0 不是"放宽断言"换来的），live 下允许空、下限若真的剔空这个数会如实变成非 0。` +
      `⇒ 无论哪种传输都**不能拿这个数证明下限生效**：这里落地的是机制（0.5 恰是余弦正交点），` +
      `效果待 live 语料复核。`,
  )
  console.log(
    `- 被拒的 ${rejected.length} 条是**非图片字节**（422 VISUAL_SEARCH_IMAGE_INVALID）：` +
      `服务端按对象真实内容判定，不信任客户端声明的 contentType。`,
  )
  console.log('')
  if (transport === 'live') {
    console.log(
      `- 这是**真实上游**的延迟分位（含 provider 网络往返）；stub 下 p50/p95 只反映 S3 读字节 + 召回 + 装配。`,
    )
  } else {
    console.log(
      `- stub 只覆盖 S3 读字节 + 向量召回 + 卡片装配；真实上游往返（provider + parser）不在其中，` +
        `线上口径请用 \`--transport=live\` 手跑。`,
    )
  }
} catch (error) {
  failures += 1
  console.error(`✗ [${step}] 未捕获失败：${error instanceof Error ? error.stack : String(error)}`)
} finally {
  if (db !== null) await db.$client.close()
  if (dbUrl === null) {
    console.error('（scratch 库未建成，无需清理）')
  } else if (failures > 0 || keepScratch) {
    console.error(
      `（保留现场：scratch 库 ${database}；对象键 ${uploadedObjectKeys.length} 个，未删除）`,
    )
  } else {
    const admin = createDb(scratchUrl(env.DATABASE_URL, 'postgres'))
    try {
      await admin.$client.unsafe(`drop database if exists "${database}" with (force)`)
      ok(`scratch 库已清理：${database}`)
    } finally {
      await admin.$client.close()
    }
    const s3 = new Bun.S3Client({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
    })
    for (const key of uploadedObjectKeys) {
      try {
        await s3.delete(key)
      } catch (error) {
        console.error(`✗ 清理对象失败 ${key}：${String(error)}`)
      }
    }
    ok(`MinIO 对象已清理：${uploadedObjectKeys.length} 个`)
  }
}

console.log('')
if (failures > 0) {
  console.error(`[visual-eval-db] 失败 ${failures} 项`)
  process.exitCode = 1
} else {
  console.log('[visual-eval-db] 全部断言通过')
}
