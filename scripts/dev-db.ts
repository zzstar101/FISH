#!/usr/bin/env bun
// scripts/dev-db.ts — 并行 worktree 独立开发库（#300）
//
// 为当前 worktree 派生稳定的独立库名 fish_dev_<slug>_<hash>：
//   - slug：分支名（detached 时退化为 worktree 目录名），slug 化后截断
//   - hash：worktree 绝对路径的 sha256 前 8 位（Bun.CryptoHasher）
// 同一 worktree 派生名恒定；不同 worktree 派生名互不相同（ Issue #300 验收标准）。
//
// 硬性安全断言：任何目标库名必须匹配白名单正则（fish_dev_ 前缀 + 受限字符集），
// 校验发生在建立任何数据库连接之前——库名非法时非零退出，不发送任何 SQL；
// 共享开发库 `fish` 与测试库约定（fish_seed_test_* 等）永远不是本脚本的操作对象。
//
// 用法：
//   bun run db:dev up          # 建库（如缺）并对该库跑 drizzle-kit 迁移
//   bun run db:dev url         # 打印当前 worktree 的 DATABASE_URL
//   bun run db:dev drop        # 删除当前 worktree 的独立库（with (force)）
//   bun run db:dev list        # 列出本机 fish_dev_* 库及其归属 worktree
// 选项：
//   --admin-url <url>          # 管理连接（建库/删库/查列表），默认共享实例 maintenance 库
//   --db-name <name>           # 显式指定目标库名（仍必须通过安全校验）
// 环境变量：
//   DATABASE_ADMIN_URL         # 同 --admin-url（优先级低于命令行）

import { SQL } from 'bun'

const DB_NAME_RE = /^fish_dev_[a-z0-9][a-z0-9-]{0,39}_[0-9a-f]{8}$/
const DEFAULT_ADMIN_URL = 'postgres://fish:fish@localhost:5432/postgres'

interface Cli {
  command: 'up' | 'url' | 'drop' | 'list'
  adminUrl: string
  dbNameOverride: string | null
}

function fail(msg: string): never {
  console.error(`[dev-db] ${msg}`)
  process.exit(1)
}

function parseCli(argv: string[]): Cli {
  let command: Cli['command'] | null = null
  let adminUrl = process.env.DATABASE_ADMIN_URL ?? DEFAULT_ADMIN_URL
  let dbNameOverride: string | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const takeValue = (name: string): string => {
      if (arg === name) {
        i++
        if (i >= argv.length) fail(`缺少 ${name} 的参数值`)
        return argv[i] ?? ''
      }
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
      return ''
    }
    const asAdmin = takeValue('--admin-url')
    if (asAdmin) {
      adminUrl = asAdmin
      continue
    }
    const asName = takeValue('--db-name')
    if (asName) {
      dbNameOverride = asName
      continue
    }
    if (arg === 'up' || arg === 'url' || arg === 'drop' || arg === 'list') {
      if (command) fail(`重复的子命令：${arg}`)
      command = arg
      continue
    }
    fail(`无法识别的参数：${arg}（可用子命令：up | url | drop | list）`)
  }
  if (!command) fail('缺少子命令：up | url | drop | list')
  return { command, adminUrl, dbNameOverride }
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} 失败（exit ${code}）：${err.trim()}`)
  return out.trim()
}

function slugify(branch: string, worktree: string): string {
  const raw = (branch || worktree.split('/').pop() || 'wt').toLowerCase()
  const slug = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20)
    .replace(/-+$/g, '')
  return slug || 'wt'
}

function devDbName(worktree: string, branch: string): string {
  const slug = slugify(branch, worktree)
  const hash = new Bun.CryptoHasher('sha256').update(worktree).digest('hex').slice(0, 8)
  return `fish_dev_${slug}_${hash}`
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** 管理连接 URL 的解析出口：非法 URL 走统一的 fail()，不把原始 TypeError 堆栈甩给用户。 */
function parseAdminUrl(adminUrl: string): URL {
  try {
    return new URL(adminUrl)
  } catch {
    return fail(`管理连接 URL 无法解析：${adminUrl}`)
  }
}

function devDbUrl(adminUrl: string, dbName: string): string {
  const url = parseAdminUrl(adminUrl)
  url.pathname = `/${dbName}`
  url.hash = ''
  return url.toString()
}

/** 安全校验：不通过就非零退出。必须在任何 SQL 连接建立之前调用。 */
function assertSafeDbName(name: string | null, forCommand: Cli['command']): string {
  if (!name) fail(`无法为当前 worktree 解析目标库名，拒绝执行 ${forCommand}`)
  if (!DB_NAME_RE.test(name)) {
    fail(
      `拒绝把 "${name}" 作为目标库（${forCommand}）：库名必须形如 fish_dev_<slug>_<hash8>；` +
        `共享开发库 fish 与测试库（fish_seed_test_* 等）不是本脚本的操作对象`,
    )
  }
  return name
}

async function connectAdmin(adminUrl: string): Promise<SQL> {
  try {
    return new SQL(adminUrl)
  } catch (err) {
    return fail(
      `管理连接不可用（${adminUrl}）：${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * 把底层连接/查询错误折叠成一行可读信息。
 *
 * 取 PG 的 SQLSTATE（如 42P04）要读 `errno`：Bun 的 SQL 错误把服务端 SQLSTATE 放在
 * `errno`，而 `code` 恒为 `ERR_POSTGRES_SERVER_ERROR`（实测），照 `code` 取会丢掉真正的码。
 */
function pgMessage(err: unknown): string {
  const shaped = err as { errno?: string; code?: string } | null
  const code = shaped?.errno ?? shaped?.code
  const msg = err instanceof Error ? err.message : String(err)
  return code ? `[${code}] ${msg}` : msg
}

/**
 * 按库名派生一个稳定的 64 位 advisory lock key（取 sha256 前 60 位，恒为正）。
 *
 * 同一 worktree 并发 `up` 时用它把「建库 + 迁移」整段串行化：只处理建库竞态是不够的，
 * 输家紧接着还会和赢家同时跑 `drizzle-kit migrate`，撞在 `pg_namespace` 的唯一约束上。
 */
function advisoryLockKey(dbName: string): string {
  const hex = new Bun.CryptoHasher('sha256').update(`dev-db:${dbName}`).digest('hex')
  return BigInt(`0x${hex.slice(0, 15)}`).toString()
}

async function currentWorktree(): Promise<{ worktree: string; branch: string }> {
  let worktree: string
  let branch: string
  try {
    worktree = await git(['rev-parse', '--show-toplevel'])
    branch = await git(['branch', '--show-current'])
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  return { worktree, branch }
}

async function cmdUp(cli: Cli): Promise<void> {
  const { worktree, branch } = await currentWorktree()
  const dbName = assertSafeDbName(cli.dbNameOverride ?? devDbName(worktree, branch), 'up')
  const devUrl = devDbUrl(cli.adminUrl, dbName)

  const sql = await connectAdmin(cli.adminUrl)
  const lockKey = advisoryLockKey(dbName)
  try {
    /*
     * 同一 worktree 并发 `up` 时，赢家与输家会同时建库、同时迁移。这里用一把按库名的
     * 会话级 advisory lock 把「建库 + 迁移」整段串行化：输家等赢家做完再进临界区，
     * 此时库已存在、迁移也已完成（drizzle migrate 幂等），直接放行。
     * 只兜住建库那一步是不够的 —— 实测输家随后会在 `drizzle-kit migrate` 上撞
     * `pg_namespace_nspname_index`。
     */
    await sql`select pg_advisory_lock(${lockKey}::bigint)`
    try {
      const rows = await sql`select 1 from pg_database where datname = ${dbName}`
      if (rows.length > 0) {
        console.log(`[dev-db] ${dbName} 已存在，跳过建库`)
      } else {
        const owner = parseAdminUrl(cli.adminUrl).username.replace(/"/g, '""') || 'fish'
        await sql.unsafe(`create database ${quoteIdent(dbName)} owner ${quoteIdent(owner)}`)
        console.log(`[dev-db] 已创建 ${dbName}`)
      }
    } catch (err) {
      /*
       * 兜底：极端情况下仍可能撞上唯一约束（例如别的工具建了同名库）。
       * PG 给的既可能是 42P04 duplicate_database，也可能是 23505 撞
       * pg_database_datname_index（实测后者）。SQLSTATE 读 `errno`（见 pgMessage）。
       */
      const errno = (err as { errno?: string } | null)?.errno
      const message = err instanceof Error ? err.message : String(err)
      const alreadyExists =
        errno === '42P04' || (errno === '23505' && message.includes('pg_database_datname_index'))
      if (!alreadyExists) fail(`建库/查询失败：${pgMessage(err)}`)
      console.log(`[dev-db] ${dbName} 已存在（并发创建，按已存在处理），跳过建库`)
    }

    console.log(`[dev-db] 正在迁移 ${dbName}（bun run --filter '@fish/db' migrate）…`)
    const proc = Bun.spawn(['bun', 'run', '--filter', '@fish/db', 'migrate'], {
      cwd: worktree,
      env: { ...process.env, DATABASE_URL: devUrl },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    const code = await proc.exited
    if (code !== 0) fail(`迁移失败（exit ${code}），库 ${dbName} 保留以便排查`)
    console.log(`[dev-db] 完成。使用方式：export DATABASE_URL=${devUrl}`)
  } finally {
    // 会话级 advisory lock 随连接关闭也会释放，这里显式解锁让锁的持有范围一目了然
    await sql`select pg_advisory_unlock(${lockKey}::bigint)`.catch(() => undefined)
    await sql.end()
  }
}

async function cmdUrl(cli: Cli): Promise<void> {
  const { worktree, branch } = await currentWorktree()
  const dbName = assertSafeDbName(cli.dbNameOverride ?? devDbName(worktree, branch), 'url')
  console.log(devDbUrl(cli.adminUrl, dbName))
}

async function cmdDrop(cli: Cli): Promise<void> {
  const wt = await currentWorktree()
  // 校验先于连接：非法库名在此处退出，不发送任何 SQL
  const dbName = assertSafeDbName(cli.dbNameOverride ?? devDbName(wt.worktree, wt.branch), 'drop')
  const sql = await connectAdmin(cli.adminUrl)
  try {
    await sql.unsafe(`drop database if exists ${quoteIdent(dbName)} with (force)`)
    console.log(`[dev-db] 已删除 ${dbName}`)
  } catch (err) {
    fail(`删库失败：${pgMessage(err)}`)
  } finally {
    await sql.end()
  }
}

interface WorktreeEntry {
  path: string
  branch: string
}

async function listWorktrees(): Promise<WorktreeEntry[]> {
  const porcelain = await git(['worktree', 'list', '--porcelain'])
  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry)
      current = { path: line.slice('worktree '.length) }
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  if (current.path) entries.push(current as WorktreeEntry)
  return entries
}

async function cmdList(cli: Cli): Promise<void> {
  const sql = await connectAdmin(cli.adminUrl)
  let rows: { datname: string }[]
  try {
    // 用正则而不是 LIKE：LIKE 里 `_` 是单字符通配，'fishXdevY_…' 也会被列进来
    rows = await sql`select datname from pg_database where datname ~ '^fish_dev_' order by datname`
  } catch (err) {
    fail(`查询失败：${pgMessage(err)}`)
  } finally {
    await sql.end()
  }

  const worktrees = await listWorktrees()
  const byHash = new Map<string, WorktreeEntry>()
  for (const wt of worktrees) {
    const hash = new Bun.CryptoHasher('sha256').update(wt.path).digest('hex').slice(0, 8)
    byHash.set(hash, wt)
  }

  if (rows.length === 0) {
    console.log('[dev-db] 本机没有 fish_dev_* 库')
    return
  }
  for (const { datname } of rows) {
    const hash = datname.split('_').pop() ?? ''
    const owner = byHash.get(hash)
    const where = owner ? `${owner.branch || '(detached)'} @ ${owner.path}` : '(未知 worktree)'
    console.log(`${datname}\t${where}`)
  }
}

const cli = parseCli(process.argv.slice(2))
if (cli.command === 'up') await cmdUp(cli)
else if (cli.command === 'url') await cmdUrl(cli)
else if (cli.command === 'drop') await cmdDrop(cli)
else await cmdList(cli)
