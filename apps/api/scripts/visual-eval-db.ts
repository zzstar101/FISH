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
import { VISUAL_SEARCH_STRATEGY_VERSION } from '@fish/contracts/visual/ranking'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { listingImages, listings } from '@fish/db/schema/listings'
import { users } from '@fish/db/schema/users'
import { listingVisualEmbeddings } from '@fish/db/schema/visual-embeddings'
import { reserveTestListingNo } from '@fish/db/testing/listing-no'
import { loadServerEnv, loadVisualEmbeddingEnv, type ServerEnv } from '@fish/shared/env'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { eq } from 'drizzle-orm'
import { enqueueVisualEmbedJob } from '../../worker/src/jobs/visual-embedding/enqueue'
import { createVisualEmbedJobHandlers } from '../../worker/src/jobs/visual-embedding/handlers'
import { createWorkerMediaStorage } from '../../worker/src/media-storage'
import { createBunS3MediaStorage } from '../src/modules/uploads/storage'
import { latencyPercentile } from '../src/modules/visual-search/eval/metrics'
import { createVisualParser } from '../src/modules/visual-search/parse'
import { VISUAL_RECALL_LIMIT, VISUAL_RESULT_LIMIT } from '../src/modules/visual-search/ranking'
import { createVisualSearchRateLimiter } from '../src/modules/visual-search/rate-limit'
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

type SearchRun = {
  label: string
  latencyMs: number
  itemCount: number
  /** 期望命中的商品 id；`null` = 这一条**本就该落空**（负样本）。 */
  expectedListingId: string | null
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

function printRunTable(runs: SearchRun[]): void {
  console.log('| 样本 | 期望 | 实得条数 | 第 1 名 | 判定 | 延迟 |')
  console.log('| --- | --- | --- | --- | --- | --- |')
  for (const run of runs) {
    const expect = run.expectedListingId === null ? '不命中目标' : '命中目标'
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
  const subject: ResolvedVisualSearchSubject = {
    key: { subjectType: 'session', subjectKey },
    attempts: [],
    issuedSessionId: null,
  }
  console.log(`- 匿名主体键：${subjectKey}（无点，满足 SUBJECT_PATTERN）`)

  /** 写查询图对象 → 注册进 visual_query_images → 调 search。**只传 objectKey**。 */
  async function runQuery(input: {
    label: string
    bytes: Uint8Array
    expectedListingId: string | null
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
      const hit =
        input.expectedListingId === null
          ? !internalIds.includes(input.expectedListingId ?? '')
          : internalIds.includes(input.expectedListingId)
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
      return {
        label: input.label,
        latencyMs,
        itemCount: items.length,
        expectedListingId: input.expectedListingId,
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
          expectedListingId: input.expectedListingId,
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
        expectedListingId: target.id,
      }),
    )
    runs.push(
      await runQuery({
        label: `无关图片查询 #${round + 1}`,
        bytes: OTHER_BYTES,
        expectedListingId: null,
      }),
    )
  }
  // 非图片字节必须被"按对象真实内容判定"那道防线挡下（422 VISUAL_SEARCH_IMAGE_INVALID）。
  const nonImageRun = await runQuery({
    label: '非图片字节查询',
    bytes: RANDOM_BYTES,
    expectedListingId: null,
  })

  printRunTable([...runs, nonImageRun])
  console.log('')

  const positive = runs.filter((run) => run.label.startsWith('同字节'))
  const unrelated = runs.filter((run) => run.label.startsWith('无关图片'))
  assert(
    positive.every((run) => run.hit && !run.failed),
    '同字节查询全部命中目标商品（stub 下确定性）',
    positive.map((run) => ({ label: run.label, hit: run.hit, items: run.itemCount })),
  )
  assert(
    unrelated.every((run) => run.hit && !run.failed && run.itemCount > 0),
    '无关图片查询按"未命中目标"口径通过（它仍会返回最近的 N 条，见下方 ⚠️）',
    unrelated.map((run) => ({ label: run.label, items: run.itemCount, top: run.topId })),
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
    expectedListingId: target.id,
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

  step = '汇总'
  section(`汇总（transport=${transport}，scratch 库 ${database}）`)
  const allRuns = [...runs, nonImageRun]
  const usable = searchableRuns(allRuns)
  const rejected = allRuns.filter((run) => run.failed)
  const emptyCount = usable.filter((run) => run.empty).length
  const latencies = usable.map((run) => run.latencyMs)
  const p50 = latencyPercentile(latencies, 0.5)
  const p95 = latencyPercentile(latencies, 0.95)
  const hitCount = allRuns.filter((run) => run.hit).length
  console.log(`| 指标 | 值 |`)
  console.log(`| --- | --- |`)
  console.log(`| transport | ${transport} |`)
  console.log(`| provider model | ${provider.model} |`)
  console.log(`| 请求数 | ${allRuns.length} |`)
  console.log(`| 符合预期数 | ${hitCount}/${allRuns.length} |`)
  console.log(`| 空结果数（2xx 但 items = 0） | ${emptyCount} |`)
  console.log(
    `| empty-result rate（只算成功返回的请求） | ${fixed(emptyCount / Math.max(usable.length, 1))} |`,
  )
  console.log(`| 被拒请求数（4xx/503，不计入延迟） | ${rejected.length} |`)
  console.log(`| p50 延迟 | ${ms(p50)} |`)
  console.log(`| p95 延迟 | ${ms(p95)} |`)
  console.log('')
  console.log(
    `- ⚠️ **empty-result rate = 0 是产品行为，不是采样不足**：召回没有相似度下限，` +
      `只要库里有向量，再无关的图也会返回最近的 ${VISUAL_RECALL_LIMIT} 条（上限 ${VISUAL_RESULT_LIMIT} 条）。` +
      `所以"空结果率"在这条链路上只能被"零向量 / 零可见商品"触发，` +
      `这本身是 #324 值得记一笔的产品问题（无关查询不会得到空列表，只会得到一堆低分结果）。`,
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
