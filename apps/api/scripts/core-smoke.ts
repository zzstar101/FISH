/**
 * 核心主链端到端冒烟（Issue #43）。
 *
 * 用**真实进程**走完整条 P0 主链：自建 scratch 库 → migration + seed → 真实 API + 真实 Worker
 * + 真实 MinIO → 图片 presign(staging)/PUT/confirm(审核+固化)/公开读（#286）→ 发布 Listing → MATCH_LISTING → Worker → Match →
 * 创建 Wish → MATCH_WISH → 双方向 `/matches` → 编辑/上下架重算 → 崩溃重启恢复 → 坏 payload 失败 →
 * 交易与面交（交易↔会话三元组一致 / 取消与成交两个终态销毁凭证 / 一单一码 / 重取即解锁）。
 *
 * **为什么放在 `apps/api/scripts/`**：脚本要直接 import `@fish/db/*` 与 `drizzle-orm`
 * （编程式 migrate / seed，以及直接断言 `jobs` / `matches` / `notifications`），而根
 * `node_modules` 里没有这些依赖（Bun workspace 不做提升，`node_modules/@fish` 不存在）。
 * `apps/api` 同时具备 `@fish/db` 与 `drizzle-orm`，且它的 `tsconfig.json` 把 `scripts` 纳入
 * typecheck。放在根 `scripts/`（`ws-smoke.ts` 的位置）会因为解析不到依赖而无法直接 import。
 *
 * 用法：
 *
 * ```bash
 * bun run db:up                    # 前置：Postgres + MinIO
 * bun run core:smoke               # 跑 1 轮
 * bun run core:smoke -- --runs=5   # 连跑 5 轮，每轮独立 scratch 库与独立 API/Worker 进程
 * bun run core:smoke -- --clean    # 失败时也清理现场（默认保留现场，便于事后查证）
 * ```
 *
 * 不需要事先 migrate / seed：脚本自己建空库，并用文档化的 `bun run db:migrate` / `db:seed`
 * 把 schema 与基础数据建出来（因此它顺带验证了“干净环境按文档可启动”）。不碰开发库。
 *
 * 清理策略：**成功**时无条件 drop 本轮 scratch 库、删掉本轮上传的 MinIO 对象；**失败**时默认
 * **保留现场**（库与对象都不动），并在 stderr 打印轮次 / 步骤名 / 断言标签 / 实得值 / 完整
 * stack，以及 scratch 库名与对象 key，供 `psql` / MinIO 复查。失败现场会累积到下次复查，按输出
 * 里给出的命令清理（两条清理命令按本地 `bun run db:up` 栈给出：`fish-postgres-1` / `fish-minio-1`，
 * 非本地栈请自行换算）；要旧的“失败也清理”行为用 `--clean`。
 *
 * 错误优先级：清理阶段（停子进程 / 关 scratch 库连接 / 删对象 / drop 库）的失败**不会**覆盖原始
 * smoke 错误——每一步单独捕获，作为附加诊断打印，且不阻断现场报告或 `--clean` 清理的其余步骤。
 * 同理，建库 / 建 `Db` 句柄 / 建 S3 客户端这些早段步骤也在保护范围内：它们失败时同样输出本轮
 * 现场（轮次、scratch 库名、对象 key）并按 `--clean` 决定清理。
 *
 * 保真边界：
 * - migration / seed 走文档化 CLI（覆盖 drizzle-kit、`--env-file` 路径与 `seed.ts` 的 `import.meta.main` 守卫）；
 * - API / Worker **直接 spawn 各自入口**并显式覆盖 `DATABASE_URL` / `API_PORT`——重启恢复需要能对单个
 *   进程 kill / restart。因此 `bun run dev:api` / `dev:worker`（含它们的 `--env-file=../../.env`）本身
 *   没有被本脚本覆盖；
 * - `claimNext` 与 handler 返回之间的“执行中途被 kill -9”窗口是毫秒级、无可注入点，崩溃态是**构造**
 *   出来的（见“重启恢复 ②”）；
 * - MinIO 不是 scratch 的：脚本成功时删掉本轮上传的对象，否则 `--runs=5` 会在桶里累积垃圾
 *   （失败时默认保留，见上面的清理策略）。
 */
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import {
  buildListingEmbeddingText,
  buildWishEmbeddingText,
  contentHashOf,
} from '@fish/contracts/embedding/text'
import {
  MATCH_SCORE_THRESHOLD,
  RANKING_VERSION,
  RANKING_VERSION_V1,
} from '@fish/contracts/matching/schema'
import {
  RECOMMENDATION_HEADERS,
  RECOMMENDATION_ROUTES,
} from '@fish/contracts/recommendation/routes'
import { RECOMMENDATION_STRATEGY_VERSION_NONE } from '@fish/contracts/recommendation/schema'
import { parseMeetupQrPayload } from '@fish/contracts/transactions/meetup-qr'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { EMBEDDING_DIMENSIONS, embeddings } from '@fish/db/schema/embeddings'
import { jobs } from '@fish/db/schema/jobs'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { notifications } from '@fish/db/schema/notifications'
import { recommendationEvents } from '@fish/db/schema/recommendation-events'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
import { decodePublicId, encodePublicId, PUBLIC_ID_PREFIX } from '@fish/shared/public-id'
import { and, eq, sql } from 'drizzle-orm'
import { MEETUP_TOKEN_MAX_ATTEMPTS } from '../src/modules/transactions/service'

// ---------------------------------------------------------------------------
// 常量与断言工具
// ---------------------------------------------------------------------------

const PASSWORD = 'fish123456'
/** seed 里 demo 买家的学号（README「演示账号」）。 */
const DEMO_BUYER_STUDENT_NO = '202101000002'
const REPO_ROOT = Bun.fileURLToPath(new URL('../../../', import.meta.url))

/** 1×1 JPEG（合法 SOI/EOI）。用它走真实的 presign → PUT → 匿名 GET 字节回环。 */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
)

/**
 * 覆盖 PUT 用的第二份字节：在合法 JPEG 后面多挂一个 EOI 标记。它和 `JPEG` 摘要不同、大小不同，
 * 用来验证"同一个 staging 键被 PUT 成别的内容后，旧审核结论不会被复用"（#286 验收）。
 */
const OVERWRITE_JPEG = Buffer.concat([JPEG, Buffer.from([0xff, 0xd9])])

/**
 * #43 链路商品的字段。抽成常量是为了让「人工队列商品」和「链路商品」共用同一份事实，只在
 * 必要处覆盖 title / description / objectKeys —— 避免某处漏改一个字段就让两个商品悄悄不同。
 */
const CHAIN_LISTING_FIELDS = {
  title: '罗技 C270 网络摄像头',
  description: '端到端冒烟创建：支持 720p，附原装支架与数据线。',
  priceCents: 16000,
  category: 'DIGITAL',
  condition: 'GOOD',
  urgent: false,
  negotiable: false,
  free: false,
} as const

let checks = 0
/**
 * 当前步骤名。初值不能是空串：建库 / 清同名库 / 建 `Db` 句柄这段（`runOnce` 进入 `try` 之前）
 * 失败时 `assert` 会打出 `✗ [] …`，事后无法定位是哪一步断的。
 */
let step = '建库'
/** 失败报告用的轮次前缀。多轮连跑时不说清是哪一轮，stack 与 scratch 库名就对不上号。 */
let currentRunLabel = '启动阶段（未进入任何轮次）'

function section(title: string): void {
  console.log(`\n  ── ${title}`)
}

function ok(label: string): void {
  checks += 1
  console.log(`    ✓ ${label}`)
}

/** 失败即抛：脚本没有“继续跑完再汇总”的需求，第一条不满足就是断链。 */
function assert(condition: unknown, label: string, detail?: unknown): void {
  if (condition) {
    ok(label)
    return
  }
  const tail = detail === undefined ? '' : `｜实得：${JSON.stringify(detail)}`
  throw new Error(`✗ [${step}] ${label}${tail}`)
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(Object.is(actual, expected), label, { actual, expected })
}

type ServerEnv = {
  DATABASE_URL: string
  WEB_ORIGIN: string
  S3_ENDPOINT: string
  S3_REGION: string
  S3_ACCESS_KEY_ID: string
  S3_SECRET_ACCESS_KEY: string
  S3_BUCKET: string
  S3_PUBLIC_URL: string
}

function requireEnv(): ServerEnv {
  const required = [
    'DATABASE_URL',
    'WEB_ORIGIN',
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_BUCKET',
    'S3_PUBLIC_URL',
  ] as const
  const missing = required.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`缺少环境变量：${missing.join(', ')}（先 cp .env.example .env）`)
  }
  return {
    DATABASE_URL: process.env.DATABASE_URL as string,
    WEB_ORIGIN: process.env.WEB_ORIGIN as string,
    S3_ENDPOINT: process.env.S3_ENDPOINT as string,
    S3_REGION: process.env.S3_REGION as string,
    S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID as string,
    S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY as string,
    S3_BUCKET: process.env.S3_BUCKET as string,
    S3_PUBLIC_URL: process.env.S3_PUBLIC_URL as string,
  }
}

function readRuns(argv: string[]): number {
  const arg = argv.find((value) => value.startsWith('--runs='))
  if (!arg) return 1
  const runs = Number(arg.slice('--runs='.length))
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs 需要正整数：${arg}`)
  return runs
}

/**
 * 失败时是否也清理现场。**默认保留**（不 drop scratch 库、不删已上传对象）——失败时最需要的是
 * 能用 `psql` / MinIO 复查现场；成功路径无论如何都会清理。`--clean` 显式要求失败时也清掉。
 */
function readCleanFlag(argv: string[]): boolean {
  return argv.includes('--clean')
}

// ---------------------------------------------------------------------------
// HTTP / 子进程 / 等待
// ---------------------------------------------------------------------------

type Cookie = string
type Child = ReturnType<typeof Bun.spawn>

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) {
    throw new Error(`响应不是 JSON 对象：${response.url}`)
  }
  return body as Record<string, unknown>
}

function cookieOf(response: Response): Cookie {
  const raw = response.headers.getSetCookie().find((value) => value.startsWith('fish_session='))
  if (!raw) throw new Error('响应未下发 fish_session cookie')
  return raw.split(';')[0] as string
}

function jsonInit(method: string, body: unknown, cookie?: Cookie): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }
}

const postJson = (base: string, path: string, body: unknown, cookie?: Cookie) =>
  fetch(new URL(path, base), jsonInit('POST', body, cookie))

const patchJson = (base: string, path: string, body: unknown, cookie?: Cookie) =>
  fetch(new URL(path, base), jsonInit('PATCH', body, cookie))

const get = (base: string, path: string, cookie?: Cookie) =>
  fetch(new URL(path, base), cookie ? { headers: { cookie } } : {})

async function register(base: string, serial: number): Promise<Cookie> {
  const response = await postJson(base, '/auth/register', {
    studentNo: `2021000000${String(serial).padStart(2, '0')}`,
    password: PASSWORD,
    nickname: `验收用户${serial}`,
  })
  assertEqual(response.status, 200, `注册账号 #${serial}`)
  return cookieOf(response)
}

async function login(base: string, studentNo: string): Promise<Cookie> {
  const response = await postJson(base, '/auth/login', { studentNo, password: PASSWORD })
  assertEqual(response.status, 200, `登录 ${studentNo}`)
  return cookieOf(response)
}

function spawnChild(entry: string, overrides: Record<string, string>): Child {
  return Bun.spawn(['bun', entry], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...overrides },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = server.port
  await server.stop(true)
  if (port === undefined) throw new Error('Bun.serve(port: 0) 未返回端口')
  return port
}

/**
 * 跑仓库里**文档化**的根脚本（`bun run db:migrate` / `db:seed`），把 `DATABASE_URL` 指到 scratch 库。
 *
 * 用它而不是编程式 `migrate()` / `seed(tx)`：`drizzle-kit` CLI、`--env-file=../../.env` 的路径、
 * `seed.ts` 的 `import.meta.main` 守卫都是“按文档从干净环境启动”这条验收的一部分，直接调函数
 * 会把它们全跳过。子进程的显式 env 优先于 `--env-file`（实测），所以不会打到开发库。
 */
async function runRootScript(script: string, overrides: Record<string, string>): Promise<void> {
  const child = Bun.spawn(['bun', 'run', script], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...overrides },
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`✗ [${step}] bun run ${script} 退出码 ${code}`)
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) throw new Error(`✗ [${step}] 超时（${timeoutMs}ms）：${label}`)
    await Bun.sleep(100)
  }
}

// ---------------------------------------------------------------------------
// DB 读取助手（只读断言用；写入只通过真实 API 或“模拟崩溃”的 job 行）
// ---------------------------------------------------------------------------

async function jobRows(db: Db, type: string, key: string, value: string) {
  return db
    .select({
      id: jobs.id,
      status: jobs.status,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(sql`${jobs.type} = ${type} and ${jobs.payload}->>${key} = ${value}`)
    .orderBy(jobs.createdAt, jobs.id)
}

type JobRow = Awaited<ReturnType<typeof jobRows>>[number]

async function jobById(db: Db, id: string): Promise<JobRow | null> {
  const rows = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      attempts: jobs.attempts,
      lastError: jobs.lastError,
    })
    .from(jobs)
    .where(eq(jobs.id, id))
    .limit(1)
  return rows[0] ?? null
}

async function waitJob(db: Db, id: string, status: JobRow['status'], timeoutMs = 20_000) {
  await waitFor(
    `job ${id} → ${status}`,
    async () => (await jobById(db, id))?.status === status,
    timeoutMs,
  )
  ok(`job ${id} → ${status}`)
}

/** 等一条**新增**的 job 达到目标状态（编辑/上下架/重复投递都会追加一条）。 */
async function waitNewJob(
  db: Db,
  type: string,
  key: string,
  value: string,
  knownIds: Set<string>,
  status: JobRow['status'],
): Promise<JobRow> {
  let fresh: JobRow | undefined
  await waitFor(`新增 job ${type} → ${status}`, async () => {
    const candidates = (await jobRows(db, type, key, value)).filter((row) => !knownIds.has(row.id))
    fresh = candidates[0]
    // 收紧到「恰好一条」：本文件每处调用都只伴随一次写操作，多出一条就是投递规则回归
    //（Done 要求「无重复 Match / 首次通知异常」）。
    return candidates.length === 1 && candidates[0]?.status === status
  })
  if (!fresh) throw new Error('内部错误：未取得新增 job')
  ok(`新增 ${type} → ${status}`)
  return fresh
}

function jobIds(rows: JobRow[]): Set<string> {
  return new Set(rows.map((row) => row.id))
}

/**
 * 等某实体的 EMBED_* job **至少有一条** DONE（#322）。
 *
 * 不能要求「恰好一条」：编辑会追加新 job（M1 的 partial unique 只挡同状态的重复投递），
 * 而这里只关心"向量已经落库"，所以只要有任意一条跑完就够 —— 之后由调用方直接读 embeddings 行。
 */
async function waitEmbedJob(db: Db, type: string, key: string, value: string): Promise<void> {
  await waitFor(`${type}（${value}）→ DONE`, async () =>
    (await jobRows(db, type, key, value)).some((row) => row.status === 'DONE'),
  )
  ok(`${type} 已有 DONE`)
}

/**
 * 读某实体当前的向量行（#322 smoke 专用）。
 *
 * 直接读整行、先拿 `model` 再按 model 使用，避免把 provider 的模型名硬编码进 smoke
 *（`EMBEDDING_TRANSPORT` 换实现时模型名就会变，而 #322 的读侧纪律是"必须显式带 model"）。
 */
async function embeddingRow(db: Db, column: 'listingId' | 'wishId', id: string) {
  const rows = await db.select().from(embeddings).where(eq(embeddings[column], id)).limit(1)
  return rows[0] ?? null
}

/** `/matches` 响应里是否存在某个分数的条目（用于卖家侧可能有多条的情形）。 */
function hasScore(response: Record<string, unknown>, score: number): boolean {
  const items = response.items
  if (!Array.isArray(items)) return false
  return items.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as Record<string, unknown>).score === score,
  )
}

async function matchRow(db: Db, listingId: string, wishId: string) {
  const rows = await db
    .select()
    .from(matches)
    .where(and(eq(matches.listingId, listingId), eq(matches.wishId, wishId)))
    .limit(1)
  return rows[0] ?? null
}

async function matchCount(db: Db, listingId: string, wishId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matches)
    .where(and(eq(matches.listingId, listingId), eq(matches.wishId, wishId)))
  return rows[0]?.n ?? 0
}

async function totalMatchCount(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(matches)
  return rows[0]?.n ?? 0
}

/** 交易行总数：用于钉住「提案不落库、只有卖家接受才建行」（#11）。 */
async function transactionCount(db: Db): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)::int` }).from(transactions)
  return rows[0]?.n ?? 0
}

/** 某笔交易当前是否还挂着面交凭证行（#147 终态销毁的断言口径）。 */
async function meetupTokenRowCount(db: Db, transactionId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from transaction_meetup_tokens
    where transaction_id = ${decodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId)}
  `)
  return [...rows][0]?.n ?? 0
}

async function notificationCount(db: Db, listingId: string, wishId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(
      sql`${notifications.payload}->>'listingId' = ${listingId} and ${notifications.payload}->>'wishId' = ${wishId}`,
    )
  return rows[0]?.n ?? 0
}

/** `/matches` 响应里的 Top-1 分数（契约：`items[].score`）。 */
function topScore(response: Record<string, unknown>, label: string): number {
  const items = response.items
  assert(Array.isArray(items) && items.length > 0, `${label} 至少返回 1 条`)
  const first = (items as unknown[])[0]
  if (typeof first !== 'object' || first === null) throw new Error(`${label} 的 item 不是对象`)
  const score = (first as Record<string, unknown>).score
  if (typeof score !== 'number') throw new Error(`${label} 的 item 没有 score`)
  return score
}

function total(response: Record<string, unknown>, label: string): number {
  const value = response.total
  assert(typeof value === 'number', `${label} 返回 total`)
  return value as number
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function scratchUrl(databaseUrl: string, name: string): string {
  const url = new URL(databaseUrl)
  url.pathname = `/${name}`
  return url.toString()
}

// ---------------------------------------------------------------------------
// 单轮主链
// ---------------------------------------------------------------------------

async function runOnce(runIndex: number, admin: Db, env: ServerEnv): Promise<void> {
  const dbName = `fish_core_smoke_${process.pid}_${runIndex}`
  const dbUrl = scratchUrl(env.DATABASE_URL, dbName)
  currentRunLabel = `第 ${runIndex} 轮（${dbName}）`
  // 每轮从头开始记步骤名：`step` 是模块级变量，不重置的话上一轮的最后一步会盖住本轮的早段失败。
  step = '建库'
  console.log(`\n[core-smoke] ===== 第 ${runIndex} 轮：${dbName} =====`)

  const dbEnv = { ...env, DATABASE_URL: dbUrl }
  // MinIO 不是 scratch 的：记下本轮上传的对象，成功时删掉（否则 `--runs=5` 会在桶里累积垃圾）；
  // 失败时默认保留，好让现场可复查。用数组而不是单个变量：上传点以后可能不止一处。
  const uploadedObjectKeys: string[] = []
  let api: Child | null = null
  let worker: Child | null = null
  // 现场报告与清理要用的句柄。它们的**创建**在下面的 `try` 内（建库成功后初始化失败同样要保留
  // 现场、同样要让 `--clean` 生效），所以这里只能先留可空引用，创建成功后再赋值。
  let scratchDb: Db | null = null
  let scratchS3: Bun.S3Client | null = null

  const stop = async (child: Child | null): Promise<void> => {
    if (!child) return
    child.kill(9)
    await child.exited
  }
  const startWorker = (): void => {
    worker = spawnChild('apps/worker/src/index.ts', dbEnv)
  }
  const stopWorker = async (): Promise<void> => {
    await stop(worker)
    worker = null
  }

  let failed = false
  try {
    // 建库 / 建 `Db` 句柄 / 建 S3 客户端都在保护范围内：这一段失败时同样要输出本轮现场（轮次、
    // scratch 库名、对象 key），并按 `--clean` 决定是否清理。放在 `try` 外面的话，建库成功后
    // 初始化失败会静默留下 scratch 库、且 `--clean` 也不生效。
    // 上一次被硬杀（Ctrl-C / 超时）留下的同名库会让 `create database` 报 42P04，
    // 而那个错误信息与真实原因无关。先无条件清掉同名库。
    await admin.$client.unsafe(`drop database if exists "${dbName}" with (force)`)
    await admin.$client.unsafe(`create database "${dbName}"`)
    // 主链内继续用 `db` / `s3` 两个局部名，主链代码不变；外部引用供 finally 报告与清理用。
    const db = createDb(dbUrl)
    scratchDb = db
    const s3 = new Bun.S3Client({
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
    })
    scratchS3 = s3

    // 0. 干净库：migration + seed，走 README 里那条文档化命令
    step = '干净环境'
    section('干净环境：bun run db:migrate + db:seed')
    await runRootScript('db:migrate', { DATABASE_URL: dbUrl })
    ok('bun run db:migrate 在空库成功')
    await runRootScript('db:seed', { DATABASE_URL: dbUrl })
    ok('bun run db:seed 成功')

    // seed 的契约是“只投一条 PENDING 的 MATCH_LISTING、不预写 match / 通知”（#43）。
    // 必须**在 worker 启动前**断言：worker 一起来就可能把这条 job 消费掉，那时再断言 PENDING 就是竞态。
    const seedListing = (
      await db
        .select({ id: listings.id })
        .from(listings)
        .where(eq(listings.title, '罗技 K380 机械键盘'))
    )[0]
    const demoBuyer = (
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.studentNo, DEMO_BUYER_STUDENT_NO))
        .limit(1)
    )[0]
    if (!seedListing || !demoBuyer) throw new Error('seed 里没有 demo 的 K380 / 买家')
    // 按 (keyword, userId) 取，并断言唯一：不靠 `.limit(1)` 掩盖“seed 新增了同关键词愿望”这种漂移。
    const seedWishes = await db
      .select({ id: wishes.id })
      .from(wishes)
      .where(and(eq(wishes.keyword, '机械键盘'), eq(wishes.userId, demoBuyer.id)))
    assertEqual(seedWishes.length, 1, 'seed 的 demo 愿望唯一（机械键盘 / demo 买家）')
    const seedWish = seedWishes[0]
    if (!seedWish) throw new Error('seed 没有 demo 愿望')
    assertEqual(await totalMatchCount(db), 0, 'seed 不预写 match')
    const seededJob = (await jobRows(db, 'MATCH_LISTING', 'listingId', seedListing.id))[0]
    if (!seededJob) throw new Error('seed 没有投出 MATCH_LISTING')
    assertEqual(seededJob.status, 'PENDING', 'seed 只投一条 PENDING 的 MATCH_LISTING')
    assertEqual(seededJob.attempts, 0, 'seed 的 job 未被领取过')

    // 1. 起真实 API（Worker 留到后面：发布 / 建愿望的 job 投递断言要在停机态下做）
    step = '启动'
    section('启动真实 API')
    const port = await freePort()
    const base = `http://127.0.0.1:${port}`
    // `WEB_ORIGIN` 不覆盖：用 `.env` 里的文档值（它决定 CORS 与 cookie 的 Secure 属性）。
    // MAIL_TRANSPORT：smoke 是本地环境，走 dev outbox（#68 的显式 transport 配置）。
    // WECHAT_TRANSPORT：#86 评审 P1 后 transport 无默认值——smoke 不碰微信入口，
    // 显式 off，不依赖调用方环境（本机 .env 的 stub 不漏进子进程）。
    api = spawnChild('apps/api/src/index.ts', {
      ...dbEnv,
      API_PORT: String(port),
      MAIL_TRANSPORT: 'outbox',
      WECHAT_TRANSPORT: 'off',
      // #228：内容审核 transport 无默认值，缺配置 API 启动即失败。core smoke 不经过审核接线
      // （发布链本期未接入适配器），显式 local；不依赖调用方环境，也不让生产的 tencent 漏进来。
      CONTENT_MODERATION_TRANSPORT: 'local',
    })
    await waitFor('API /health → 200', async () => {
      try {
        return (await fetch(`${base}/health`)).status === 200
      } catch {
        return false
      }
    })
    ok(`API 就绪（${base}）`)

    // 2. Demo 高分样例必须由引擎真实产出（seed 不再预写结果）
    step = 'Demo 样例'
    section('Demo 高分样例：机械键盘 ≤¥200 ↔ K380 ¥160（#322 降级口径）')
    startWorker()
    ok('Worker 已启动')
    await waitJob(db, seededJob.id, 'DONE')
    const seededMatch = await matchRow(db, seedListing.id, seedWish.id)
    assert(seededMatch !== null, 'Worker 用真实打分生成了 demo 的 match 行')
    if (!seededMatch) throw new Error('demo match 缺失')
    assertEqual(seededMatch.score, 100, 'demo 样例总分 = 100')
    assertEqual(seededMatch.categoryScore, 100, 'demo 样例分类分 = 100')
    assertEqual(seededMatch.keywordScore, 100, 'demo 样例关键词分 = 100')
    assertEqual(seededMatch.priceScore, 100, 'demo 样例价格分 = 100')
    // #322 M2 的降级契约在真实链路上的证据：seed 按 #43 契约**只投一条 MATCH_LISTING**、不投
    // EMBED_*，所以愿望这一侧没有向量 ⇒ 本轮按 v1 口径打分（semantic_score 落 NULL、
    // ranking_version = 1、分数是 0.35/0.35/0.30 的 #8 算法），同时补投目标实体的 EMBED_LISTING。
    // v2（hybrid + semantic_score）由本文件后面的「语义链」一节在同一套 API/Worker/DB 上验证。
    assertEqual(
      seededMatch.rankingVersion,
      RANKING_VERSION_V1,
      'demo 行是 v1 退化口径（愿望没有向量）',
    )
    assertEqual(seededMatch.semanticScore, null, 'v1 行的 semantic_score 落 NULL，不伪造语义分')
    assert(
      (await jobRows(db, 'EMBED_LISTING', 'listingId', seedListing.id)).length > 0,
      '降级时补投了 EMBED_LISTING（否则这一对永远停在 v1）',
    )
    assertEqual(
      await notificationCount(db, seedListing.id, seedWish.id),
      1,
      'demo 样例恰好 1 条首通知',
    )

    const demoCookie = await login(base, DEMO_BUYER_STUDENT_NO)
    const demoWishSide = await readJson(
      await get(
        base,
        `/matches?wishId=${encodePublicId(PUBLIC_ID_PREFIX.wish, seedWish.id)}`,
        demoCookie,
      ),
    )
    assertEqual(total(demoWishSide, 'demo /matches?wishId='), 1, 'demo 买家能读到“愿望成真”')
    assertEqual(topScore(demoWishSide, 'demo /matches?wishId='), 100, 'demo 读接口分数 = 100')

    // 发布与建愿望的 job 投递断言要在**停机态**下做：worker 在跑时，job 可能在脚本读库前就被
    // 领取成 RUNNING，硬断言 PENDING 会变成竞态（“连跑 5 次”会偶发失败）。
    await stopWorker()
    ok('Worker 已停止（在停机态断言 job 投递）')

    // 3. 真实图片上传 + 发布
    step = '上传与发布'
    section('真实图片：presign → PUT → confirm → 匿名读')
    // 注册即登录，但 `/auth/login` 是文档化入口：显式再登录一次，让 smoke 真的覆盖它
    //（demo 账号那条只验证了 seed 写进去的哈希，不能替代新账号）。
    const sellerStudentNo = '202100000001'
    await register(base, 1)
    const seller = await login(base, sellerStudentNo)
    const buyer = await register(base, 2)

    const presignResponse = await postJson(
      base,
      '/uploads/presign',
      { contentType: 'image/jpeg', sizeBytes: JPEG.length },
      seller,
    )
    assertEqual(presignResponse.status, 200, 'POST /uploads/presign → 200')
    const presigned = await readJson(presignResponse)
    const uploadUrl = String(presigned.uploadUrl)
    const stagingKey = String(presigned.objectKey)
    const extraHeaders = (presigned.headers ?? {}) as Record<string, string>
    // #286 的结构性保证：presign 只签 staging 前缀，客户端**拿不到** `listings/` 的签名，
    // 于是"审核通过后再 PUT 覆盖同一对象"这条绕过不靠摘要比对去拦，而是根本做不到。
    assert(
      stagingKey.startsWith('listing-media/'),
      `presign 签发 staging 键（实得：${stagingKey}）`,
    )

    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: JPEG,
      headers: { 'content-type': 'image/jpeg', ...extraHeaders },
    })
    assert(
      putResponse.status >= 200 && putResponse.status < 300,
      `presigned PUT → ${putResponse.status}`,
    )
    // 对象一落桶就登记（不等到 confirm 成功）：confirm 断言若失败，对象仍在 MinIO 里，
    // 失败现场块必须能报出这个 key，否则事后无从查证、也无从清理。
    uploadedObjectKeys.push(stagingKey)

    // staging 不在匿名读白名单里（`infra/minio-public-policy.json` 只放开 `listings/*`）：未过审的
    // 图**结构上就取不到**，不依赖"审核完再删"这种时序假设。
    assertEqual(
      (await fetch(`${env.S3_PUBLIC_URL}/${stagingKey}`)).status,
      403,
      'staging 对象匿名读 → 403',
    )

    const confirmResponse = await postJson(
      base,
      '/uploads/confirm',
      { objectKey: stagingKey },
      seller,
    )
    assertEqual(confirmResponse.status, 200, 'POST /uploads/confirm → 200')
    const confirmed = await readJson(confirmResponse)
    const finalKey = String(confirmed.objectKey)
    // #286 的核心契约：客户端能引用的键是 **confirm 返回的 final 键**，不是它自己 PUT 的那个
    // staging 键。三个 App 的上传适配器都以这个返回值为准（见各自的 api.test.ts）。
    // CI 与本地都跑 `CONTENT_MODERATION_TRANSPORT=local`，provider 给不出内容摘要 ⇒ 结论恒为 REVIEW
    // ⇒ 复审 blocker 2 要求它固化在**私有**的 `listing-review-media/` 下，绝不落在匿名可读的 `listings/*`。
    assert(
      finalKey.startsWith('listing-review-media/'),
      `local transport 下 confirm 返回私有 review 键（实得：${finalKey}）`,
    )
    assert(finalKey !== stagingKey, 'final 键与 staging 键不同')
    uploadedObjectKeys.push(finalKey)

    // 私有固化对象与 staging 一样不在匿名白名单里：没有签名就取不到，不依赖"审核完再删"的时序假设。
    assertEqual(
      (await fetch(`${env.S3_PUBLIC_URL}/${finalKey}`)).status,
      403,
      '私有 review 对象匿名直读 → 403',
    )

    // 卖家与审核队列要能看到它，靠的是 confirm 回的**签名代理 URL**（capability URL，无 cookie 也能读，
    // 小程序原生 `<Image>` 因此能显示）。它指向 WEB_ORIGIN（同源代理），smoke 里没有 web 进程，
    // 所以按同一路径改打 API。
    const confirmToken = /\/uploads\/media\/([A-Za-z0-9_-]+)$/.exec(String(confirmed.url))?.[1]
    assert(
      typeof confirmToken === 'string',
      `confirm 回的 review URL 带代理令牌（实得：${confirmed.url}）`,
    )
    if (!confirmToken) throw new Error('confirm 没有回 review 代理令牌')
    const reviewResponse = await fetch(`${base}/uploads/media/${confirmToken}`)
    assertEqual(reviewResponse.status, 200, '签名代理 URL 匿名 GET → 200（无 cookie）')
    assert(
      bytesEqual(new Uint8Array(await reviewResponse.arrayBuffer()), JPEG),
      '签名代理读到的字节与上传一致',
    )

    // 接口重试不得重复计费审核：同一 staging 键 + 同一内容的第二次 confirm 直接复用既有结论。
    const replay = await postJson(base, '/uploads/confirm', { objectKey: stagingKey }, seller)
    assertEqual(replay.status, 200, '重复 confirm → 200')
    assertEqual(
      String((await readJson(replay)).objectKey),
      finalKey,
      '重复 confirm 复用同一 final 键（幂等，不重复审核）',
    )

    // 对象覆盖不能绕过已完成的审核：把同一个 staging 键 PUT 成**别的字节**后再 confirm，摘要不同
    // ⇒ 不命中幂等行 ⇒ 重新审核并产出**新的** final 键，旧审核结论不会被套到新内容上。
    const overwritePut = await fetch(uploadUrl, {
      method: 'PUT',
      body: OVERWRITE_JPEG,
      headers: { 'content-type': 'image/jpeg', ...extraHeaders },
    })
    assert(
      overwritePut.status >= 200 && overwritePut.status < 300,
      `覆盖 PUT → ${overwritePut.status}`,
    )
    const overwriteConfirm = await postJson(
      base,
      '/uploads/confirm',
      { objectKey: stagingKey },
      seller,
    )
    assertEqual(overwriteConfirm.status, 200, '覆盖后 confirm → 200')
    const overwrittenFinalKey = String((await readJson(overwriteConfirm)).objectKey)
    assert(
      overwrittenFinalKey !== finalKey,
      '覆盖后 confirm 产出新的 final 键（旧结论不套用新内容）',
    )
    uploadedObjectKeys.push(overwrittenFinalKey)

    section('#286 引用校验与人工队列（CI / 本地 transport：图片一律 REVIEW）')
    // staging 键进 `objectKeys` → 422：未确认的对象结构上不可能被 Listing 引用。
    const stagingRef = await postJson(
      base,
      '/listings',
      { ...CHAIN_LISTING_FIELDS, objectKeys: [stagingKey] },
      seller,
    )
    assertEqual(stagingRef.status, 422, 'objectKeys 带 staging 键 → 422')
    assertEqual(
      ((await readJson(stagingRef)).error as { code: string }).code,
      'IMAGE_REFERENCE_INVALID',
      'staging 键的错误码是 IMAGE_REFERENCE_INVALID',
    )

    // final 键可以引用，但 local transport 给不出内容摘要 ⇒ 图片结论恒为 REVIEW ⇒ 商品进人工队列
    //（status 变 OFFLINE，匿名读不到）。这就是「宁可进人工队列，也不当作审核通过」的运行时证据。
    // 标题刻意与下面的链路商品不同，免得人工队列商品被卷进后面的匹配断言。
    const heldResponse = await postJson(
      base,
      '/listings',
      {
        ...CHAIN_LISTING_FIELDS,
        title: '人工队列样例（本地审核 transport）',
        description: '本地 transport 给不出内容摘要，图片一律 REVIEW：该商品应停在人工队列。',
        objectKeys: [finalKey],
      },
      seller,
    )
    assertEqual(heldResponse.status, 201, 'final 键发布 → 201（发布本身不失败）')
    const heldId = String((await readJson(heldResponse)).id)
    assertEqual((await get(base, `/listings/${heldId}`)).status, 404, '人工队列商品匿名读不到')
    const heldSellerView = await readJson(await get(base, `/listings/${heldId}`, seller))
    assertEqual(heldSellerView.status, 'OFFLINE', '人工队列商品对卖家显示 OFFLINE')
    assertEqual(heldSellerView.moderationStatus, 'REVIEW', '人工队列商品标注 REVIEW')
    // 卖家视角的 coverUrl 走的仍是「#6 契约 §7.8」那一个实现；审核中的图是私有的，所以它必须投影成
    // 签名代理 URL（而不是 `listings/*` 的匿名直链）—— 这也是"未过审的图对公众取不到"的运行时证据。
    assert(typeof heldSellerView.coverUrl === 'string', '人工队列商品对卖家仍返回可用的 coverUrl')
    const heldToken = /\/uploads\/media\/([A-Za-z0-9_-]+)$/.exec(
      String(heldSellerView.coverUrl),
    )?.[1]
    assert(
      typeof heldToken === 'string',
      `人工队列商品的 coverUrl 是签名代理（实得：${heldSellerView.coverUrl}）`,
    )
    if (!heldToken) throw new Error('人工队列商品的 coverUrl 没有代理令牌')
    assertEqual(
      (await fetch(`${base}/uploads/media/${heldToken}`)).status,
      200,
      '签名代理封面 → 200（卖家/审核队列可见）',
    )

    // 生产形态的“已通过审核”图片：CI 与本地都跑 `CONTENT_MODERATION_TRANSPORT=local`，本地 provider
    // 恒给 REVIEW（上一节就是它的证据），而 #43 的匹配/交易链路需要一个公开在售（ACTIVE / APPROVED）
    // 的商品，商品又必须至少带 1 张图。这里直接落一行“腾讯 IMS 判 ALLOW”形态的记录（final 键 + 对象
    // 本体 + 64 位摘要），让链路继续走真实的 API 路径 —— 本地 transport 产不出这个状态，只能构造。
    const approvedSellerPublicId = finalKey.split('/')[1] ?? ''
    assert(approvedSellerPublicId.length > 0, 'confirm 的 final 键里带用户段')
    const approvedKey = `listings/${approvedSellerPublicId}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.jpg`
    const approvedStagingKey = `listing-media/${approvedSellerPublicId}/${encodePublicId(PUBLIC_ID_PREFIX.media, newId())}.jpg`
    await s3.write(approvedKey, JPEG, { type: 'image/jpeg' })
    await db.execute(sql`
      insert into listing_media_objects
        (user_id, staging_key, final_key, content_digest, provider_md5, moderation_decision, provider, provider_request_id)
      values (
        ${decodePublicId(PUBLIC_ID_PREFIX.user, approvedSellerPublicId)},
        ${approvedStagingKey},
        ${approvedKey},
        ${new Bun.CryptoHasher('sha256').update(JPEG).digest('hex')},
        null,
        'ALLOW',
        'LOCAL',
        null
      )
    `)
    uploadedObjectKeys.push(approvedKey)

    section('发布 Listing 与 MATCH_LISTING 投递')
    // 关键词刻意不复用 demo 的“机械键盘”：seed 里已有一条 K380（DIGITAL / ¥160 / 标题含“机械键盘”），
    // 若愿望也用同一关键词，会同时命中 seed 那条与本次发布的这条。demo 那一对由上面的 seed 步骤
    // 专门验证，这里用 seed 不存在的“网络摄像头”，双方向才能一义地断言各 1 条。
    //
    // 链路商品带的是上一节构造的 ALLOW 图片（本地 transport 的图一律 REVIEW，见上一节），所以它
    // 是公开在售的商品，后面的匹配/交易链路才能照旧跑。
    const createResponse = await postJson(
      base,
      '/listings',
      { ...CHAIN_LISTING_FIELDS, objectKeys: [approvedKey] },
      seller,
    )
    assertEqual(createResponse.status, 201, 'POST /listings → 201（发布立即返回）')
    const listing = await readJson(createResponse)
    const listingPublicId = String(listing.id)
    const listingId = decodePublicId(PUBLIC_ID_PREFIX.listing, listingPublicId)

    const detailResponse = await get(base, `/listings/${listingPublicId}`)
    assertEqual(detailResponse.status, 200, '匿名 GET /listings/:id → 200')
    const coverUrl = (await readJson(detailResponse)).coverUrl
    assert(typeof coverUrl === 'string', '详情返回可用的 coverUrl')
    assertEqual((await fetch(String(coverUrl))).status, 200, '封面 URL 匿名 → 200')

    // 推荐归因链（#323 R1 验收）：一次推荐请求 → 曝光 → 开详情，事件必须能按
    // `requestId` / `position` 归因回**同一次**推荐请求。R1 的 Feed 是 newest 透传
    // （`strategy_version = rec-v1-none`），这里用匿名会话真打一次 Feed，取首张卡发
    // IMPRESSION + DETAIL_VIEW，再回库里核对归因字段（客户端上报的四类"服务端确证事件"
    // 由业务写路径产生，不在这一步里造）。
    const stepBeforeRecommendation = step
    step = '推荐归因链（request → IMPRESSION → DETAIL_VIEW）'
    section('推荐归因链：request → IMPRESSION → DETAIL_VIEW')
    const anonSessionId = crypto.randomUUID()
    const feedResponse = await fetch(new URL(`${RECOMMENDATION_ROUTES.feed}?limit=5`, base), {
      headers: { [RECOMMENDATION_HEADERS.sessionId]: anonSessionId },
    })
    assertEqual(feedResponse.status, 200, '匿名 GET /recommendations/feed → 200')
    const feed = await readJson(feedResponse)
    assertEqual(
      feed.strategyVersion,
      RECOMMENDATION_STRATEGY_VERSION_NONE,
      'R1 推荐策略版本 = rec-v1-none',
    )
    const feedItems = feed.items as { id: string }[]
    assert(feedItems.length > 0, '推荐 Feed 至少返回一张卡')
    const feedListingPublicId = String(feedItems[0]?.id)
    const feedListingId = decodePublicId(PUBLIC_ID_PREFIX.listing, feedListingPublicId)
    const requestId = String(feed.requestId)
    const occurredAt = new Date().toISOString()

    const impressionResponse = await postJson(base, RECOMMENDATION_ROUTES.events, {
      events: [
        {
          eventId: crypto.randomUUID(),
          requestId,
          listingId: feedListingPublicId,
          eventType: 'IMPRESSION',
          position: 0,
          anonymousSessionId: anonSessionId,
          occurredAt,
          metadata: { visibleRatio: 1, durationMs: 1_500 },
        },
      ],
    })
    assertEqual(impressionResponse.status, 202, 'POST /recommendations/events（IMPRESSION）→ 202')
    assertEqual(
      (await readJson(impressionResponse)).accepted,
      1,
      'IMPRESSION 被接受（accepted = 1）',
    )

    const detailViewResponse = await postJson(base, RECOMMENDATION_ROUTES.events, {
      events: [
        {
          eventId: crypto.randomUUID(),
          requestId,
          listingId: feedListingPublicId,
          eventType: 'DETAIL_VIEW',
          position: 0,
          anonymousSessionId: anonSessionId,
          occurredAt,
        },
      ],
    })
    assertEqual(detailViewResponse.status, 202, 'POST /recommendations/events（DETAIL_VIEW）→ 202')
    assertEqual(
      (await readJson(detailViewResponse)).accepted,
      1,
      'DETAIL_VIEW 被接受（accepted = 1）',
    )

    const attributed = await db
      .select({
        eventType: recommendationEvents.eventType,
        requestId: recommendationEvents.requestId,
        position: recommendationEvents.position,
        userId: recommendationEvents.userId,
      })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.listingId, feedListingId),
          eq(recommendationEvents.requestId, requestId),
        ),
      )
    const attributedByType = new Map(attributed.map((row) => [row.eventType, row]))
    assertEqual(attributed.length, 2, '库里恰两条事件（IMPRESSION + DETAIL_VIEW）')
    assertEqual(
      [...attributedByType.keys()].sort().join(','),
      'DETAIL_VIEW,IMPRESSION',
      '库里两条事件都归因到同一次 request（IMPRESSION + DETAIL_VIEW）',
    )
    assertEqual(attributedByType.get('IMPRESSION')?.position, 0, 'IMPRESSION 记录了 position = 0')
    assertEqual(attributedByType.get('DETAIL_VIEW')?.position, 0, 'DETAIL_VIEW 记录了 position = 0')
    assertEqual(
      attributedByType.get('IMPRESSION')?.userId,
      null,
      '匿名流量的 IMPRESSION 不挂 user_id',
    )
    assertEqual(
      attributedByType.get('DETAIL_VIEW')?.userId,
      null,
      '匿名流量的 DETAIL_VIEW 不挂 user_id',
    )

    // 归因链小节到此结束：把 `step` 复位，否则紧接的 MATCH_LISTING 断言失败会被误报成这一步。
    step = stepBeforeRecommendation

    const listingJobRows = await jobRows(db, 'MATCH_LISTING', 'listingId', listingId)
    assertEqual(listingJobRows.length, 1, '发布写入恰好一条 MATCH_LISTING')
    assertEqual(listingJobRows[0]?.status, 'PENDING', '该 job 在停机态保持 PENDING')
    if (!listingJobRows[0]) throw new Error('没有投出 MATCH_LISTING')
    const listingJob = listingJobRows[0]

    // 4. Wish → MATCH_WISH → 双方向匹配
    step = 'Wish 与双向匹配'
    section('Wish → MATCH_WISH → 双方向 /matches')
    const wishResponse = await postJson(
      base,
      '/wishes',
      {
        keyword: '网络摄像头',
        category: 'DIGITAL',
        budgetMinCents: 10000,
        budgetMaxCents: 20000,
        acceptSimilar: true,
      },
      buyer,
    )
    assertEqual(wishResponse.status, 201, 'POST /wishes → 201')
    const wishPublicId = String((await readJson(wishResponse)).id)
    const wishId = decodePublicId(PUBLIC_ID_PREFIX.wish, wishPublicId)

    const wishJobRows = await jobRows(db, 'MATCH_WISH', 'wishId', wishId)
    assertEqual(wishJobRows.length, 1, '创建愿望写入恰好一条 MATCH_WISH')
    assertEqual(wishJobRows[0]?.status, 'PENDING', '该 job 在停机态保持 PENDING')
    if (!wishJobRows[0]) throw new Error('没有投出 MATCH_WISH')
    const wishJob = wishJobRows[0]

    // 愿望域挂载在根级 `/wishes`（与 listings / matches 同口径）。#52 的 `/api/wishes` 过渡别名
    // 已随 `WISH_ROUTES` 收敛（#53）删除，这里只打正典路径，并把响应结构钉住
    //（只断 status 会放过“200 但返回空壳”）。
    const listResponse = await get(base, '/wishes', buyer)
    assertEqual(listResponse.status, 200, 'GET /wishes → 200')
    assert(Array.isArray((await readJson(listResponse)).items), 'GET /wishes 返回列表结构')

    startWorker()
    ok('Worker 已启动')
    await waitJob(db, listingJob.id, 'DONE')
    await waitJob(db, wishJob.id, 'DONE')

    // #322 M2/M3：`MATCH_*` 与 `EMBED_*` 是同一次写事务里并行投出的两条链，队列按 (run_at, id)
    // 领取 ⇒ 第一轮 MATCH 完全可能还没拿到向量（那时落的是 v1 退化行）。所以先等 embedding 真正
    // 落库，再断言分数 —— 在这里钉绝对值会变成"谁先跑完"的竞态。
    await waitEmbedJob(db, 'EMBED_LISTING', 'listingId', listingId)
    await waitEmbedJob(db, 'EMBED_WISH', 'wishId', wishId)

    const wishSide = await readJson(await get(base, `/matches?wishId=${wishPublicId}`, buyer))
    const listingSide = await readJson(
      await get(base, `/matches?listingId=${listingPublicId}`, seller),
    )
    assertEqual(total(wishSide, '买家 /matches?wishId='), 1, '买家 /matches?wishId= 命中 1 条')
    assertEqual(
      total(listingSide, '卖家 /matches?listingId='),
      1,
      '卖家 /matches?listingId= 命中 1 条',
    )
    const wishScore = topScore(wishSide, '买家 /matches?wishId=')
    const listingScore = topScore(listingSide, '卖家 /matches?listingId=')
    // 口径无关的不变式：同一对、同一套权重 ⇒ 两个方向必须给出同一个分数；且它必须 ≥ 阈值
    //（读谓词本身就要求 score ≥ MATCH_SCORE_THRESHOLD，能读到就说明成立）。
    assertEqual(wishScore, listingScore, '两个方向的 score 一致（同一套语义定义）')
    assert(wishScore >= MATCH_SCORE_THRESHOLD, `可见的 match 分数 ≥ 阈值（实得 ${wishScore}）`)
    assertEqual(await matchCount(db, listingId, wishId), 1, 'matches 只有 1 行（幂等键生效）')
    assertEqual(await notificationCount(db, listingId, wishId), 1, '首次匹配恰好 1 条通知')

    // 5. 幂等：重复投递/重算不新增行、不重复通知
    step = '幂等'
    section('重算幂等（不新增 match / 不重复通知）')
    const replayKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const replayPatch = await patchJson(
      base,
      `/listings/${listingPublicId}`,
      { negotiable: true },
      seller,
    )
    assertEqual(replayPatch.status, 200, 'PATCH /listings/:id → 200（触发 MATCH_LISTING）')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, replayKnown, 'DONE')
    assertEqual(await matchCount(db, listingId, wishId), 1, '重算不新增 match 行')
    assertEqual(await notificationCount(db, listingId, wishId), 1, '重算不重复发通知')

    // #322 M3：embedding 就绪后这一对必然按 v2 口径重算。这里断言的不是某个绝对值（语义分取决于
    // provider 的尺度，stub 与 live 不可比），而是**冻结后的权重算式**：结构三项全中（分类 100 /
    // 关键词 100 / 价格 100）+ S4 权重 {semantic .30, category .32, keyword .15, price .23} ⇒
    // score = round(0.30×semantic + 0.32×100 + 0.15×100 + 0.23×100) = 70 + round(0.30×semantic)。
    const recomputed = await matchRow(db, listingId, wishId)
    assert(recomputed !== null, '重算后 matches 行仍在')
    if (!recomputed) throw new Error('重算后 matches 行丢了')
    assertEqual(
      recomputed.rankingVersion,
      RANKING_VERSION,
      '重算后是 v2 口径（ranking_version = 2）',
    )
    assert(recomputed.semanticScore !== null, 'v2 行必须落 semantic_score（不是 NULL）')
    assertEqual(
      recomputed.score,
      70 + Math.round(0.3 * (recomputed.semanticScore ?? 0)),
      'v2 分数 = S4 权重下的四路加权和（结构三项全中）',
    )
    assertEqual(
      topScore(
        await readJson(await get(base, `/matches?wishId=${wishPublicId}`, buyer)),
        '重算后买家侧',
      ),
      recomputed.score,
      '读接口分数 = 落库分数（v2 行）',
    )

    // 6. 编辑改变事实：价格越过 2× 预算后旧 Match 必须降级
    step = '编辑重算'
    section('编辑价格到 2× 预算之外：旧 Match 降级且不残留')
    const overBudgetKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const overBudget = await patchJson(
      base,
      `/listings/${listingPublicId}`,
      { priceCents: 50000 },
      seller,
    )
    assertEqual(overBudget.status, 200, 'PATCH 价格 50000 → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, overBudgetKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishPublicId}`, buyer)), '超预算'),
      0,
      '超预算后买家侧不再展示',
    )
    assertEqual(
      total(
        await readJson(await get(base, `/matches?listingId=${listingPublicId}`, seller)),
        '超预算',
      ),
      0,
      '超预算后卖家侧不再展示',
    )
    const downgraded = await matchRow(db, listingId, wishId)
    assert(downgraded !== null, '降级保留 matches 行（不删行）')
    if (!downgraded) throw new Error('降级后 matches 行丢了')
    // 超预算 ⇒ 价格分 0；分类/关键词仍全中 ⇒ 0.32×100 + 0.15×100 + 0.23×0 = 47，
    // 加上语义项 = 47 + round(0.30×semantic)。"看不见"由读谓词的 priceWithinBudget 决定
    //（与分数无关），所以这里钉的是"旧 100 分被覆盖成真实裸分"这件事。
    assertEqual(downgraded.priceScore, 0, '超预算后价格分 = 0')
    assertEqual(
      downgraded.score,
      47 + Math.round(0.3 * (downgraded.semanticScore ?? 0)),
      '超预算后的分数 = S4 权重下的四路加权和（价格项归零）',
    )

    const restoreKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const restore = await patchJson(
      base,
      `/listings/${listingPublicId}`,
      { priceCents: 16000 },
      seller,
    )
    assertEqual(restore.status, 200, 'PATCH 价格恢复 16000 → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, restoreKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishPublicId}`, buyer)), '恢复后'),
      1,
      '价格恢复后买家侧重新可见',
    )
    // 只断 total 挡不住"分数停在裸分、但已满足读谓词（≥阈值且在预算内）"：必须确认分数真的被重算。
    const restoredMatch = await matchRow(db, listingId, wishId)
    assert(restoredMatch !== null, '恢复后 matches 行仍在')
    if (!restoredMatch) throw new Error('恢复后 matches 行丢了')
    assertEqual(
      restoredMatch.score,
      70 + Math.round(0.3 * (restoredMatch.semanticScore ?? 0)),
      '恢复后分数被重算回 v2 的四路加权和（不只是重新可见）',
    )
    assert(
      restoredMatch.score >= MATCH_SCORE_THRESHOLD,
      `恢复后分数 ≥ 阈值（实得 ${restoredMatch.score}）`,
    )

    // 7. 下架 / 重新上架
    step = '上下架'
    section('下架隐藏、重新上架恢复')
    const offlineKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const offline = await postJson(base, `/listings/${listingPublicId}/offline`, {}, seller)
    assertEqual(offline.status, 200, 'POST offline → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, offlineKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishPublicId}`, buyer)), '下架后'),
      0,
      '下架后买家侧不展示该 Match',
    )
    assert((await matchRow(db, listingId, wishId)) !== null, '下架不删 matches 行')
    // 只钉愿望侧：listing 侧读谓词不过滤商品状态（`apps/api/src/modules/matching/store.ts`），
    // 卖家仍能看见自己 OFFLINE 商品的 match——这是 #8 契约的有意取舍，这里把它一并钉住，
    // 将来若要改成双向隐藏，这条断言会提醒改动者那是契约变更。
    assertEqual(
      total(
        await readJson(await get(base, `/matches?listingId=${listingPublicId}`, seller)),
        '下架后',
      ),
      1,
      '下架后卖家侧仍可见（#8 有意取舍）',
    )

    const onlineKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const online = await postJson(base, `/listings/${listingPublicId}/online`, {}, seller)
    assertEqual(online.status, 200, 'POST online → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, onlineKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishPublicId}`, buyer)), '上架后'),
      1,
      '重新上架后买家侧恢复展示',
    )

    // 7.5 #322 M3 语义链：向量召回 + hybrid 打分在真实 API / Worker / DB 上成立
    step = '语义链'
    section('语义链：零词法重叠 → 向量召回 → hybrid 分数')
    // 关键词与描述跟链路商品**零 token 重叠**（substring 与空白分词都命不中），同分类、预算内。
    const semanticWishResponse = await postJson(
      base,
      '/wishes',
      {
        keyword: '户外露营装备',
        description: '想要一顶轻便的帐篷，最好能塞进背包侧袋。',
        category: 'DIGITAL',
        budgetMinCents: 5000,
        budgetMaxCents: 20000,
        acceptSimilar: true,
      },
      buyer,
    )
    assertEqual(semanticWishResponse.status, 201, 'POST /wishes（语义样本）→ 201')
    const semanticWishPublicId = String((await readJson(semanticWishResponse)).id)
    const semanticWishId = decodePublicId(PUBLIC_ID_PREFIX.wish, semanticWishPublicId)

    await waitEmbedJob(db, 'EMBED_WISH', 'wishId', semanticWishId)
    // 结构分不够：分类 100 + 价格 100 + 关键词 0 ⇒ v1 = 0.35×100 + 0.30×100 = 65，
    // v2 = 0.32×100 + 0.23×100 + 0.30×0 = 55，都低于阈值 70 ⇒ 不建行。
    assertEqual(
      await matchCount(db, listingId, semanticWishId),
      0,
      '文本语义不可比时不建 Match（关键词 0 命中，v1/v2 都过不了阈值）',
    )

    const listingEmbedded = await embeddingRow(db, 'listingId', listingId)
    const wishEmbedded = await embeddingRow(db, 'wishId', semanticWishId)
    assert(listingEmbedded !== null && wishEmbedded !== null, '两个实体都有向量行')
    if (!listingEmbedded || !wishEmbedded) throw new Error('向量行缺失')
    assertEqual(listingEmbedded.dimensions, EMBEDDING_DIMENSIONS, '商品向量维度 = 迁移 typmod')
    assertEqual(wishEmbedded.dimensions, EMBEDDING_DIMENSIONS, '愿望向量维度 = 迁移 typmod')
    assertEqual(listingEmbedded.model, wishEmbedded.model, '两实体用同一 model 的向量（不混模型）')
    // 文本构造与指纹的端到端证据：落库的 content_hash 必须等于"当前内容"的指纹（#322 M1 契约）。
    assertEqual(
      listingEmbedded.contentHash,
      contentHashOf(
        buildListingEmbeddingText({
          title: CHAIN_LISTING_FIELDS.title,
          description: CHAIN_LISTING_FIELDS.description,
          category: CHAIN_LISTING_FIELDS.category,
        }),
      ),
      '商品 content_hash = 当前内容的指纹',
    )

    const semanticWishRow = (
      await db.select().from(wishes).where(eq(wishes.id, semanticWishId)).limit(1)
    )[0]
    assert(semanticWishRow !== undefined, '读到语义样本愿望')
    if (!semanticWishRow) throw new Error('语义样本愿望缺失')
    const semanticWishTextHash = contentHashOf(
      buildWishEmbeddingText({
        keyword: semanticWishRow.keyword,
        description: semanticWishRow.description,
        category: semanticWishRow.category,
      }),
    )
    assertEqual(
      wishEmbedded.contentHash,
      semanticWishTextHash,
      '愿望 content_hash = 当前内容的指纹',
    )

    // 把愿望的向量替换成与商品**逐位相同**的向量：cos = 1 ⇒ 归一化语义分 100（与 provider 的尺度
    // 无关，stub 与 live 都成立），而两边文本仍然零重叠（keywordScore 必须还是 0）。
    // content_hash 写成当前内容的指纹，且 source_updated_at 对齐愿望当前版本：目标侧的就绪判定用
    // 前者（model + dimensions + 指纹），候选侧的新鲜度谓词用后者（#322 M3 评审 blocker），两者都满足
    // 引擎才会把这条向量当"对应当前内容"。
    await db.execute(sql`
      update embeddings
         set embedding = ${JSON.stringify(listingEmbedded.embedding)}::vector,
             content_hash = ${semanticWishTextHash},
             source_updated_at = (select updated_at from wishes where id = ${semanticWishId}),
             updated_at = now()
       where wish_id = ${semanticWishId} and model = ${listingEmbedded.model}
    `)

    // 直接投一条 MATCH_WISH：这一节验的是召回与打分，投递钩子已由别处钉住。
    const semanticJobId = newId()
    await db.execute(sql`
      insert into jobs (id, type, payload)
      values (${semanticJobId}, 'MATCH_WISH', ${jsonParam({ wishId: semanticWishId })})
    `)
    await waitJob(db, semanticJobId, 'DONE')

    const semanticMatch = await matchRow(db, listingId, semanticWishId)
    assert(semanticMatch !== null, '向量逐位相同 ⇒ 召回并建 Match（文本零重叠也召回）')
    if (!semanticMatch) throw new Error('语义样本没有建 Match')
    assertEqual(semanticMatch.keywordScore, 0, '关键词分 0 证明召回不是 substring 决定的')
    assertEqual(semanticMatch.categoryScore, 100, '分类分 100（结构化硬规则仍然生效）')
    assertEqual(semanticMatch.semanticScore, 100, '逐位相同的向量 ⇒ 归一化语义分 100')
    assertEqual(semanticMatch.rankingVersion, RANKING_VERSION, 'match 行是 v2 口径')
    assertEqual(
      semanticMatch.score,
      85,
      'v2 = 0.30×100 + 0.32×100 + 0.15×0 + 0.23×100 = 85（同样两行走 v1 只有 65，低于阈值）',
    )
    const semanticWishSide = await readJson(
      await get(base, `/matches?wishId=${semanticWishPublicId}`, buyer),
    )
    assertEqual(total(semanticWishSide, '语义链买家侧'), 1, '语义链买家侧恰好 1 条')
    assertEqual(topScore(semanticWishSide, '语义链买家侧'), 85, '语义链买家侧 score = 85')
    const semanticListingSide = await readJson(
      await get(base, `/matches?listingId=${listingPublicId}`, seller),
    )
    assert(hasScore(semanticListingSide, 85), '卖家侧同样看得到这一对（两个方向口径一致）')

    // 8. 重启恢复·口径 1：worker 停机期间投递的 job，重启后继续
    step = '重启恢复（停机积压）'
    section('重启恢复 ①：停机期间投递的 PENDING job')
    await stopWorker()
    ok('Worker 已停止')
    const stoppedKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const stoppedPatch = await patchJson(
      base,
      `/listings/${listingPublicId}`,
      { negotiable: false },
      seller,
    )
    assertEqual(stoppedPatch.status, 200, '停机态下 PATCH /listings/:id → 200')
    const queued = await waitNewJob(
      db,
      'MATCH_LISTING',
      'listingId',
      listingId,
      stoppedKnown,
      'PENDING',
    )
    await Bun.sleep(2500)
    assertEqual(
      (await jobById(db, queued.id))?.status,
      'PENDING',
      'Worker 停机时 job 一直保持 PENDING（没有被消费）',
    )
    startWorker()
    await waitJob(db, queued.id, 'DONE')
    ok('Worker 重启后继续处理停机期间积压的 job')

    // 9. 重启恢复·口径 2：崩溃遗留的 RUNNING job 在重启时被回收并重放
    step = '重启恢复（RUNNING 回收）'
    section('重启恢复 ②：崩溃遗留的 RUNNING job')
    await stopWorker()
    const zombieId = newId()
    await db.insert(jobs).values({
      id: zombieId,
      type: 'MATCH_LISTING',
      payload: jsonParam({ listingId }),
      // **构造**崩溃后的状态，而不是真的在 handler 执行中途 kill -9：那个窗口是毫秒级、
      // 没有可注入的阻塞点，抢时间杀进程只会得到一个 flaky 测试。这里验的是回收逻辑对
      // “遗留 RUNNING 行”的端到端效果（真实 kill -9 发生在上一节的停机 / 重启，只是那时
      // worker 处于空闲态，不会留下 RUNNING 行）。
      status: 'RUNNING',
      attempts: 1,
      lockedAt: new Date(),
    })
    ok('构造一条崩溃遗留的 RUNNING job')
    startWorker()
    await waitJob(db, zombieId, 'DONE')
    assertEqual(await matchCount(db, listingId, wishId), 1, '崩溃重放不新增 match 行')
    assertEqual(await notificationCount(db, listingId, wishId), 1, '崩溃重放不重复发通知')

    // 10. 坏 payload → FAILED（重试不会变好）
    step = '坏 payload'
    section('坏 payload 直接 FAILED，且不产生 Match')
    const matchesBefore = await totalMatchCount(db)
    const badId = newId()
    await db.insert(jobs).values({
      id: badId,
      type: 'MATCH_LISTING',
      payload: jsonParam({}),
      status: 'PENDING',
    })
    await waitJob(db, badId, 'FAILED')
    const badJob = await jobById(db, badId)
    assert(
      badJob?.lastError !== null && badJob?.lastError !== undefined,
      '坏 payload 的 job 写明 last_error',
    )
    assertEqual(await totalMatchCount(db), matchesBefore, '坏 payload 不新增任何 match')

    // 11. 交易与面交（#147）：三元组一致 → 取消终态销毁 → 一单一码 → 重取即解锁 → 成交终态销毁
    //
    // 为什么必须放在**最后一步**：本步骤会把主链 listing 推到 SOLD，插在「重启恢复」之前
    // 会污染那两步对同一 listing 的 PATCH。取舍见
    // docs/design/issue-147-transaction-invariants.md §4.1。
    step = '交易与面交'
    section('交易与面交：三元组一致、取消/成交终态销毁、一单一码、重取解锁')

    // 不变量 ①：交易 ↔ 会话三元组一致。join 不上的交易在订单页静默消失（#157 的失败模式）。
    const conversationResponse = await postJson(
      base,
      CHAT_ROUTES.base,
      { listingId: listingPublicId },
      buyer,
    )
    assertEqual(conversationResponse.status, 201, 'POST /conversations → 201')
    const conversationId = String((await readJson(conversationResponse)).id)

    const txRowsBeforeProposal = await transactionCount(db)
    const proposalResponse = await postJson(
      base,
      TRANSACTION_ROUTES.proposals,
      { conversationId, amountCents: 0 },
      buyer,
    )
    assertEqual(proposalResponse.status, 201, '买家提案 → 201')
    assertEqual(
      await transactionCount(db),
      txRowsBeforeProposal,
      '提案不落交易行（只有卖家接受才建行）',
    )

    // 不变量 ①a：CANCELLED 是「终态同事务销毁」的另一半（#169）。先用一笔取消掉的交易把
    // 这条钉住，再让同一 listing 走完整成交链路 —— cancel 会把 listing 无条件恢复 ACTIVE，
    // 所以两笔能顺序落在同一个商品上。
    const cancelledAccept = await postJson(
      base,
      TRANSACTION_ROUTES.accept,
      { conversationId, amountCents: 0 },
      seller,
    )
    assertEqual(cancelledAccept.status, 201, '卖家接受（待取消用例）→ 201')
    const cancelledId = String((await readJson(cancelledAccept)).id)

    const cancelledIssue = await postJson(
      base,
      TRANSACTION_ROUTES.issueMeetupToken(cancelledId),
      {},
      seller,
    )
    assertEqual(cancelledIssue.status, 201, '待取消用例取码 → 201')
    const cancelledQr = String((await readJson(cancelledIssue)).qrPayload)
    assertEqual(await meetupTokenRowCount(db, cancelledId), 1, '取码后凭证行存在')

    const cancelledResponse = await postJson(
      base,
      TRANSACTION_ROUTES.cancel(cancelledId),
      {},
      buyer,
    )
    assertEqual(cancelledResponse.status, 200, '买家取消 → 200')
    assertEqual((await readJson(cancelledResponse)).status, 'CANCELLED', '取消后交易为 CANCELLED')
    assertEqual(await meetupTokenRowCount(db, cancelledId), 0, 'CANCELLED 后凭证行已删除')

    const cancelAfterTerminal = await postJson(
      base,
      TRANSACTION_ROUTES.issueMeetupToken(cancelledId),
      {},
      seller,
    )
    assertEqual(cancelAfterTerminal.status, 409, 'CANCELLED 后取码 → 409')
    assertEqual(
      ((await readJson(cancelAfterTerminal)).error as { code: string }).code,
      'TRANSACTION_NOT_IN_PENDING',
      'CANCELLED 后取码错误码是 TRANSACTION_NOT_IN_PENDING',
    )

    const restored = await readJson(await get(base, `/listings/${listingPublicId}`))
    assertEqual(restored.status, 'ACTIVE', '取消后商品恢复 ACTIVE（可再次成交）')

    const acceptResponse = await postJson(
      base,
      TRANSACTION_ROUTES.accept,
      { conversationId, amountCents: 0 },
      seller,
    )
    assertEqual(acceptResponse.status, 201, '卖家接受 → 201')
    const accepted = await readJson(acceptResponse)
    const transactionId = String(accepted.id)
    assertEqual(accepted.status, 'PENDING_MEETUP', '接受后交易为 PENDING_MEETUP')
    assertEqual(accepted.conversationId, conversationId, '交易 DTO 回指同一会话')

    // 与 GET /transactions 的 listForUser / findById 同一个 join：join 不上就是订单页看不见。
    const joined = await db.execute<{ id: string }>(sql`
      select c.id from transactions t
      join conversations c
        on c.listing_id = t.listing_id
       and c.buyer_id = t.buyer_id
       and c.seller_id = t.seller_id
      where t.id = ${decodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId)}
    `)
    assertEqual([...joined].length, 1, '交易按三元组恰好 join 到 1 个会话')
    assertEqual(
      [...joined][0]?.id,
      decodePublicId(PUBLIC_ID_PREFIX.conversation, conversationId),
      'join 到的会话就是本笔交易的会话',
    )
    for (const [who, cookie] of [
      ['买家', buyer],
      ['卖家', seller],
    ] as const) {
      const list = await readJson(await get(base, TRANSACTION_ROUTES.base, cookie))
      const ids = (list.items as { id: string }[]).map((item) => item.id)
      assert(ids.includes(transactionId), `${who} GET /transactions 能读到本笔交易`)
    }

    // 不变量 ②：一单一码 —— 码由交易 id + 服务端密钥派生，任何一次读取都是同一枚（#175）。
    const issue = () =>
      postJson(base, TRANSACTION_ROUTES.issueMeetupToken(transactionId), {}, seller)
    const firstIssue = await issue()
    assertEqual(firstIssue.status, 201, '卖家取码 → 201')
    const firstToken = await readJson(firstIssue)
    const meetupCode = String(firstToken.code)
    assert(/^\d{6}$/.test(meetupCode), '取码返回 6 位数字码')
    // 跨交易唯一性：派生输入必须是**交易 id**，不是 listing id —— 否则同一商品上先后两笔交易
    // （上面取消掉的那笔 + 这笔记成交的）会拿到同一枚凭证。比的是 payload 里的 `t`（token）：
    // 整串 payload 含 `tx=<交易 id>`，两笔交易的整串必然不同，比它等于没比。
    // 也不比 6 位码：码空间只有 10^6，两枚独立码有 1e-6 的碰撞概率，拿它做断言会变成极低频 flake。
    const firstQr = parseMeetupQrPayload(String(firstToken.qrPayload))
    const cancelledQrParsed = parseMeetupQrPayload(cancelledQr)
    assert(
      firstQr !== null && cancelledQrParsed !== null,
      '两笔交易的 qrPayload 都能被契约解析器解析',
    )
    if (firstQr === null || cancelledQrParsed === null) throw new Error('unreachable')
    assert(
      firstQr.token !== cancelledQrParsed.token,
      '不同交易派生出不同凭证（派生输入是交易 id，不是商品 id）',
    )
    const secondIssue = await issue()
    assertEqual(secondIssue.status, 201, '卖家重复取码 → 201')
    const secondToken = await readJson(secondIssue)
    assertEqual(String(secondToken.code), meetupCode, '重复取码 6 位码不变（一单一码）')
    assertEqual(
      parseMeetupQrPayload(String(secondToken.qrPayload))?.token,
      firstQr.token,
      '重复取码二维码凭证不变（一单一码）',
    )

    // 不变量 ③：连错达阈值即锁，卖家重取码解锁且码值不变（#176「重取是现场解锁的唯一路径」）。
    // 循环边界取服务端常量，避免把 5 抄第二份；但常量本身要钉住 —— 否则阈值漂到 6 时
    // 本步骤会跟着漂、什么都拦不住。「5 次 / 锁 10 分钟」是 #70 冻结的产品口径。
    assertEqual(MEETUP_TOKEN_MAX_ATTEMPTS, 5, '6 位码失败阈值冻结为 5 次（#70 口径）')
    const wrongCode = meetupCode === '000000' ? '111111' : '000000'
    const verifyCode = (value: string) =>
      postJson(base, TRANSACTION_ROUTES.verifyMeetupCode(transactionId), { code: value }, buyer)
    for (let attempt = 1; attempt < MEETUP_TOKEN_MAX_ATTEMPTS; attempt += 1) {
      const failed = await verifyCode(wrongCode)
      assertEqual(failed.status, 422, `第 ${attempt} 次错误码 → 422`)
      assertEqual(
        ((await readJson(failed)).error as { code: string }).code,
        'MEETUP_TOKEN_INVALID',
        `第 ${attempt} 次错误码 → MEETUP_TOKEN_INVALID`,
      )
    }
    const threshold = await verifyCode(wrongCode)
    assertEqual(
      threshold.status,
      429,
      `第 ${MEETUP_TOKEN_MAX_ATTEMPTS} 次错误码 → 429（达阈值即锁）`,
    )
    assertEqual(
      ((await readJson(threshold)).error as { code: string }).code,
      'MEETUP_TOKEN_LOCKED',
      '锁定错误码是 MEETUP_TOKEN_LOCKED',
    )

    const reissued = await issue()
    assertEqual(reissued.status, 201, '锁定后卖家重取码 → 201')
    assertEqual(String((await readJson(reissued)).code), meetupCode, '重取解锁不换码')
    const tokenRows = await db.execute<{ failedAttempts: number; lockedUntil: string | null }>(sql`
      select failed_attempts as "failedAttempts", locked_until as "lockedUntil"
      from transaction_meetup_tokens where transaction_id = ${decodePublicId(PUBLIC_ID_PREFIX.transaction, transactionId)}
    `)
    assertEqual([...tokenRows].length, 1, '重取后凭证行仍在（未核销）')
    assertEqual([...tokenRows][0]?.failedAttempts, 0, '重取码复位失败计数')
    assertEqual([...tokenRows][0]?.lockedUntil, null, '重取码清空 locked_until')

    // 不变量 ④：正确码核销 → 买家 confirm → 终态同事务销毁凭证（#147 / #169）。
    //
    // 注意核销的语义：**出示码 = 卖家同意面交**，核销那一笔事务里就盖上
    // seller_confirmed_at（store.ts「展示码 = 卖家对面交的同意」）。所以核销后交易仍是
    // PENDING_MEETUP + 只有买家未确认 —— 面交页的恢复口径正是靠这两个字段判「还差最后一步」。
    const verifiedResponse = await verifyCode(meetupCode)
    assertEqual(verifiedResponse.status, 200, '正确码核销 → 200')
    assertEqual(
      (await readJson(verifiedResponse)).nextAction,
      'CONFIRM_DELIVERY',
      '核销后 nextAction = CONFIRM_DELIVERY',
    )

    const afterRedeem = await readJson(
      await get(base, TRANSACTION_ROUTES.detail(transactionId), buyer),
    )
    assertEqual(afterRedeem.status, 'PENDING_MEETUP', '核销后交易仍是 PENDING_MEETUP')
    assert(
      typeof afterRedeem.sellerConfirmedAt === 'string',
      '核销即盖卖家确认（出示码 = 卖家同意）',
    )
    assertEqual(afterRedeem.buyerConfirmedAt, null, '核销不动买家确认')

    const buyerConfirm = await postJson(base, TRANSACTION_ROUTES.confirm(transactionId), {}, buyer)
    assertEqual(buyerConfirm.status, 200, '买家 confirm → 200')
    assertEqual((await readJson(buyerConfirm)).status, 'COMPLETED', '买家确认后双侧齐 → COMPLETED')

    assertEqual(await meetupTokenRowCount(db, transactionId), 0, 'COMPLETED 后凭证行已删除')

    const afterTerminal = await issue()
    assertEqual(afterTerminal.status, 409, '终态后取码 → 409')
    assertEqual(
      ((await readJson(afterTerminal)).error as { code: string }).code,
      'TRANSACTION_NOT_IN_PENDING',
      '终态后取码错误码是 TRANSACTION_NOT_IN_PENDING',
    )
  } catch (error) {
    failed = true
    throw error
  } finally {
    // 清理阶段：停子进程 / 关 scratch 库连接 / 删对象 / drop 库，每一步都单独捕获。清理失败只作为
    // **附加诊断**打印，绝不覆盖原始 smoke 错误、也绝不阻断后面的现场报告或 `--clean` 清理——否则
    // 最需要现场的时候（清理本身也坏了）恰好什么都看不到。
    const cleanupErrors: string[] = []
    const attempt = async (what: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action()
      } catch (error) {
        cleanupErrors.push(`${what}：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    await attempt('停止 worker', stopWorker)
    await attempt('停止 API', async () => {
      await stop(api)
    })
    const dbHandle = scratchDb
    if (dbHandle) {
      await attempt('关闭 scratch 库连接', async () => {
        await dbHandle.$client.close()
      })
    }

    if (failed && !cleanOnFailure) {
      // 默认保留现场：失败时最需要的是能用 psql / MinIO 事后复查。scratch 库名带 pid、对象 key 是
      // 随机串，不在这里打出来，事后就找不回是哪一份。
      console.error('\n[core-smoke] 失败现场已保留（默认不清理；`--clean` 表示失败时也清理）：')
      console.error(`[core-smoke]   scratch 库：${dbName}`)
      console.error(
        `[core-smoke]   已上传对象：${uploadedObjectKeys.length === 0 ? '（无）' : uploadedObjectKeys.join(', ')}`,
      )
      console.error(
        `[core-smoke]   复查完清理库（本地 docker 开发栈）：docker exec fish-postgres-1 psql -U fish -d postgres -c 'drop database if exists "${dbName}" with (force)'`,
      )
      if (uploadedObjectKeys.length > 0) {
        const objectPaths = uploadedObjectKeys
          .map((key) => `/data/${env.S3_BUCKET}/${key}`)
          .join(' ')
        console.error(
          `[core-smoke]   复查完清理对象（本地 docker 开发栈）：docker exec fish-minio-1 rm -rf ${objectPaths}`,
        )
      }
    } else {
      const s3Handle = scratchS3
      for (const key of uploadedObjectKeys) {
        if (!s3Handle) break
        await attempt(`删除对象 ${key}`, async () => {
          await s3Handle.delete(key)
        })
      }
      await attempt('drop scratch 库', async () => {
        await admin.$client.unsafe(`drop database if exists "${dbName}" with (force)`)
      })
    }

    if (cleanupErrors.length > 0) {
      console.error(
        `\n[core-smoke] 清理阶段有 ${cleanupErrors.length} 处失败（不改变原始结论；现场可能残留）：`,
      )
      for (const line of cleanupErrors) console.error(`[core-smoke]   ${line}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const runs = readRuns(argv)
const cleanOnFailure = readCleanFlag(argv)
const env = requireEnv()
const admin = createDb(env.DATABASE_URL)
const startedAt = performance.now()

try {
  for (let index = 1; index <= runs; index += 1) {
    await runOnce(index, admin, env)
  }
  console.log(
    `\n[core-smoke] ok — ${runs} 轮全部通过，共 ${checks} 项断言（${Math.round(performance.now() - startedAt)}ms）`,
  )
} catch (error) {
  // 轮次 + 步骤名 + stack 三者缺一不可：断言消息里有标签与实得值，但只有 stack 能给出失败位置
  // （脚本自身、还是它 spawn 的 API / Worker 子进程）。
  console.error(`\n[core-smoke] 失败：${currentRunLabel}｜步骤：${step}`)
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
  process.exitCode = 1
} finally {
  // admin 连接的关闭失败不该覆盖已经打印出来的失败诊断（脚本到此即将退出）。
  await admin.$client.close().catch((error: unknown) => {
    console.error(
      `[core-smoke] 关闭 admin 连接失败（忽略）：${error instanceof Error ? error.message : String(error)}`,
    )
  })
}
