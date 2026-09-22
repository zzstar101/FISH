/**
 * 核心主链端到端冒烟（Issue #43）。
 *
 * 用**真实进程**走完整条 P0 主链：自建 scratch 库 → migration + seed → 真实 API + 真实 Worker
 * + 真实 MinIO → 图片 presign/PUT/公开读 → 发布 Listing → MATCH_LISTING → Worker → Match →
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
 * ```
 *
 * 不需要事先 migrate / seed：脚本自己建空库，并用文档化的 `bun run db:migrate` / `db:seed`
 * 把 schema 与基础数据建出来（因此它顺带验证了“干净环境按文档可启动”）。跑完自动 drop 掉
 * scratch 库，不碰开发库。
 *
 * 保真边界：
 * - migration / seed 走文档化 CLI（覆盖 drizzle-kit、`--env-file` 路径与 `seed.ts` 的 `import.meta.main` 守卫）；
 * - API / Worker **直接 spawn 各自入口**并显式覆盖 `DATABASE_URL` / `API_PORT`——重启恢复需要能对单个
 *   进程 kill / restart。因此 `bun run dev:api` / `dev:worker`（含它们的 `--env-file=../../.env`）本身
 *   没有被本脚本覆盖；
 * - `claimNext` 与 handler 返回之间的“执行中途被 kill -9”窗口是毫秒级、无可注入点，崩溃态是**构造**
 *   出来的（见“重启恢复 ②”）；
 * - MinIO 不是 scratch 的：脚本结束时删掉本轮上传的对象，否则 `--runs=5` 会在桶里累积垃圾。
 */
import { CHAT_ROUTES } from '@fish/contracts/chat/routes'
import { TRANSACTION_ROUTES } from '@fish/contracts/transactions/routes'
import { createDb, type Db } from '@fish/db/client'
import { newId } from '@fish/db/ids'
import { jsonParam } from '@fish/db/json'
import { jobs } from '@fish/db/schema/jobs'
import { listings } from '@fish/db/schema/listings'
import { matches } from '@fish/db/schema/matches'
import { notifications } from '@fish/db/schema/notifications'
import { transactions } from '@fish/db/schema/transactions'
import { users } from '@fish/db/schema/users'
import { wishes } from '@fish/db/schema/wishes'
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

let checks = 0
let step = ''

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
    campus: '肇庆',
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
    where transaction_id = ${transactionId}
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
  console.log(`\n[core-smoke] ===== 第 ${runIndex} 轮：${dbName} =====`)

  // 上一次被硬杀（Ctrl-C / 超时）留下的同名库会让 `create database` 报 42P04，
  // 而那个错误信息与真实原因无关。先无条件清掉同名库。
  await admin.$client.unsafe(`drop database if exists "${dbName}" with (force)`)
  await admin.$client.unsafe(`create database "${dbName}"`)
  const db = createDb(dbUrl)
  const dbEnv = { ...env, DATABASE_URL: dbUrl }
  // MinIO 不是 scratch 的：记下本轮上传的对象，结束时删掉（否则 `--runs=5` 会在桶里累积垃圾）。
  const s3 = new Bun.S3Client({
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    bucket: env.S3_BUCKET,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
  })
  let uploadedObjectKey: string | null = null
  let api: Child | null = null
  let worker: Child | null = null

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

  try {
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
    api = spawnChild('apps/api/src/index.ts', {
      ...dbEnv,
      API_PORT: String(port),
      MAIL_TRANSPORT: 'outbox',
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
    section('Demo 高分样例：机械键盘 ≤¥200 ↔ K380 ¥160')
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
    assertEqual(
      await notificationCount(db, seedListing.id, seedWish.id),
      1,
      'demo 样例恰好 1 条首通知',
    )

    const demoCookie = await login(base, DEMO_BUYER_STUDENT_NO)
    const demoWishSide = await readJson(
      await get(base, `/matches?wishId=${seedWish.id}`, demoCookie),
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
    const objectKey = String(presigned.objectKey)
    const extraHeaders = (presigned.headers ?? {}) as Record<string, string>

    const putResponse = await fetch(uploadUrl, {
      method: 'PUT',
      body: JPEG,
      headers: { 'content-type': 'image/jpeg', ...extraHeaders },
    })
    assert(
      putResponse.status >= 200 && putResponse.status < 300,
      `presigned PUT → ${putResponse.status}`,
    )

    const confirmResponse = await postJson(base, '/uploads/confirm', { objectKey }, seller)
    assertEqual(confirmResponse.status, 200, 'POST /uploads/confirm → 200')
    uploadedObjectKey = objectKey
    const publicUrl = String((await readJson(confirmResponse)).url)

    const publicResponse = await fetch(publicUrl)
    assertEqual(publicResponse.status, 200, '匿名 GET 公开 URL → 200')
    assert(
      bytesEqual(new Uint8Array(await publicResponse.arrayBuffer()), JPEG),
      '公开读到的字节与上传一致',
    )

    section('发布 Listing 与 MATCH_LISTING 投递')
    // 关键词刻意不复用 demo 的“机械键盘”：seed 里已有一条 K380（DIGITAL / ¥160 / 标题含“机械键盘”），
    // 若愿望也用同一关键词，会同时命中 seed 那条与本次发布的这条。demo 那一对由上面的 seed 步骤
    // 专门验证，这里用 seed 不存在的“网络摄像头”，双方向才能一义地断言各 1 条。
    const createResponse = await postJson(
      base,
      '/listings',
      {
        title: '罗技 C270 网络摄像头',
        description: '端到端冒烟创建：支持 720p，附原装支架与数据线。',
        priceCents: 16000,
        category: 'DIGITAL',
        condition: 'GOOD',
        urgent: false,
        negotiable: false,
        free: false,
        objectKeys: [objectKey],
      },
      seller,
    )
    assertEqual(createResponse.status, 201, 'POST /listings → 201（发布立即返回）')
    const listing = await readJson(createResponse)
    const listingId = String(listing.id)

    const detailResponse = await get(base, `/listings/${listingId}`)
    assertEqual(detailResponse.status, 200, '匿名 GET /listings/:id → 200')
    const coverUrl = (await readJson(detailResponse)).coverUrl
    assert(typeof coverUrl === 'string', '详情返回可用的 coverUrl')
    assertEqual((await fetch(String(coverUrl))).status, 200, '封面 URL 匿名 → 200')

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
    const wishId = String((await readJson(wishResponse)).id)

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

    const wishSide = await readJson(await get(base, `/matches?wishId=${wishId}`, buyer))
    const listingSide = await readJson(await get(base, `/matches?listingId=${listingId}`, seller))
    assertEqual(total(wishSide, '买家 /matches?wishId='), 1, '买家 /matches?wishId= 命中 1 条')
    assertEqual(
      total(listingSide, '卖家 /matches?listingId='),
      1,
      '卖家 /matches?listingId= 命中 1 条',
    )
    const wishScore = topScore(wishSide, '买家 /matches?wishId=')
    const listingScore = topScore(listingSide, '卖家 /matches?listingId=')
    assertEqual(wishScore, 100, '买家侧 score = 100')
    assertEqual(listingScore, 100, '卖家侧 score = 100（与买家侧一致）')
    assertEqual(await matchCount(db, listingId, wishId), 1, 'matches 只有 1 行（幂等键生效）')
    assertEqual(await notificationCount(db, listingId, wishId), 1, '首次匹配恰好 1 条通知')

    // 5. 幂等：重复投递/重算不新增行、不重复通知
    step = '幂等'
    section('重算幂等（不新增 match / 不重复通知）')
    const replayKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const replayPatch = await patchJson(
      base,
      `/listings/${listingId}`,
      { negotiable: true },
      seller,
    )
    assertEqual(replayPatch.status, 200, 'PATCH /listings/:id → 200（触发 MATCH_LISTING）')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, replayKnown, 'DONE')
    assertEqual(await matchCount(db, listingId, wishId), 1, '重算不新增 match 行')
    assertEqual(await notificationCount(db, listingId, wishId), 1, '重算不重复发通知')
    assertEqual((await matchRow(db, listingId, wishId))?.score, 100, '重算后分数不变')

    // 6. 编辑改变事实：价格越过 2× 预算后旧 Match 必须降级
    step = '编辑重算'
    section('编辑价格到 2× 预算之外：旧 Match 降级且不残留')
    const overBudgetKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const overBudget = await patchJson(
      base,
      `/listings/${listingId}`,
      { priceCents: 50000 },
      seller,
    )
    assertEqual(overBudget.status, 200, 'PATCH 价格 50000 → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, overBudgetKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishId}`, buyer)), '超预算'),
      0,
      '超预算后买家侧不再展示',
    )
    assertEqual(
      total(await readJson(await get(base, `/matches?listingId=${listingId}`, seller)), '超预算'),
      0,
      '超预算后卖家侧不再展示',
    )
    const downgraded = await matchRow(db, listingId, wishId)
    assert(downgraded !== null, '降级保留 matches 行（不删行）')
    assertEqual(downgraded?.score, 70, '分数被覆盖成真实裸分 70（分类 100 + 关键词 100 + 价格 0）')

    const restoreKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const restore = await patchJson(base, `/listings/${listingId}`, { priceCents: 16000 }, seller)
    assertEqual(restore.status, 200, 'PATCH 价格恢复 16000 → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, restoreKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishId}`, buyer)), '恢复后'),
      1,
      '价格恢复后买家侧重新可见',
    )
    // 只断 total 挡不住“分数停在 70、但已满足读谓词（≥70 且在预算内）”：必须确认分数真的被重算回 100。
    assertEqual(
      (await matchRow(db, listingId, wishId))?.score,
      100,
      '恢复后分数被重算回 100（不只是重新可见）',
    )

    // 7. 下架 / 重新上架
    step = '上下架'
    section('下架隐藏、重新上架恢复')
    const offlineKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const offline = await postJson(base, `/listings/${listingId}/offline`, {}, seller)
    assertEqual(offline.status, 200, 'POST offline → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, offlineKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishId}`, buyer)), '下架后'),
      0,
      '下架后买家侧不展示该 Match',
    )
    assert((await matchRow(db, listingId, wishId)) !== null, '下架不删 matches 行')
    // 只钉愿望侧：listing 侧读谓词不过滤商品状态（`apps/api/src/modules/matching/store.ts`），
    // 卖家仍能看见自己 OFFLINE 商品的 match——这是 #8 契约的有意取舍，这里把它一并钉住，
    // 将来若要改成双向隐藏，这条断言会提醒改动者那是契约变更。
    assertEqual(
      total(await readJson(await get(base, `/matches?listingId=${listingId}`, seller)), '下架后'),
      1,
      '下架后卖家侧仍可见（#8 有意取舍）',
    )

    const onlineKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const online = await postJson(base, `/listings/${listingId}/online`, {}, seller)
    assertEqual(online.status, 200, 'POST online → 200')
    await waitNewJob(db, 'MATCH_LISTING', 'listingId', listingId, onlineKnown, 'DONE')
    assertEqual(
      total(await readJson(await get(base, `/matches?wishId=${wishId}`, buyer)), '上架后'),
      1,
      '重新上架后买家侧恢复展示',
    )

    // 8. 重启恢复·口径 1：worker 停机期间投递的 job，重启后继续
    step = '重启恢复（停机积压）'
    section('重启恢复 ①：停机期间投递的 PENDING job')
    await stopWorker()
    ok('Worker 已停止')
    const stoppedKnown = jobIds(await jobRows(db, 'MATCH_LISTING', 'listingId', listingId))
    const stoppedPatch = await patchJson(
      base,
      `/listings/${listingId}`,
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
    const conversationResponse = await postJson(base, CHAT_ROUTES.base, { listingId }, buyer)
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

    const restored = await readJson(await get(base, `/listings/${listingId}`))
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
      where t.id = ${transactionId}
    `)
    assertEqual([...joined].length, 1, '交易按三元组恰好 join 到 1 个会话')
    assertEqual([...joined][0]?.id, conversationId, 'join 到的会话就是本笔交易的会话')
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
    // （上面取消掉的那笔 + 这笔记成交的）会拿到同一枚凭证。这里比 qrPayload 而不是比 6 位码：
    // 码空间只有 10^6，两枚独立码有 1e-6 的碰撞概率，拿它做断言会变成极低频 flake。
    assert(
      String(firstToken.qrPayload) !== cancelledQr,
      '不同交易派生出不同凭证（派生输入是交易 id，不是商品 id）',
    )
    const secondIssue = await issue()
    assertEqual(secondIssue.status, 201, '卖家重复取码 → 201')
    assertEqual(
      String((await readJson(secondIssue)).code),
      meetupCode,
      '重复取码码值不变（一单一码）',
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
      from transaction_meetup_tokens where transaction_id = ${transactionId}
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
  } finally {
    await stopWorker()
    await stop(api)
    await db.$client.close()
    if (uploadedObjectKey) {
      await s3.delete(uploadedObjectKey).catch(() => undefined)
    }
    await admin.$client.unsafe(`drop database if exists "${dbName}" with (force)`)
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const runs = readRuns(process.argv.slice(2))
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
  console.error(`\n[core-smoke] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await admin.$client.close()
}
