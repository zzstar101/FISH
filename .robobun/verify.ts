#!/usr/bin/env bun
/**
 * RoboBun Lite 确定性验证器（方案书 §7）。
 *
 * 这是脚本，不是 agent：验证结论只来自本文件的 JSON 输出，
 * 任何会话内判断都不得替代或覆盖它。
 *
 * 用法：bun .robobun/verify.ts [-p quick|full]
 *   -p quick  只跑 verification.yaml profiles.quick 列出的 stage 子集（可带 per-stage
 *             命令覆盖），用于实现过程反馈；不覆写 latest.json，不产生验收结论。
 *   默认/full 全量 stages，PR 前的结论性运行，覆写 latest.json。
 * 输出：.robobun/evidence/verify-<utc>.json（+ full 时 latest.json）+ logs/<stage>.log
 * 退出码：0 = 全部 required stage 通过；1 = 任一失败或配置错误。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------- 严格小型 YAML 解析器（只认 verification.yaml 用到的子集） ----------

type Stage = { name: string; command: string; required: boolean; timeout_seconds: number }
type ProfileEntry = { stage: string; command?: string }
type Config = {
  version: number
  baseline: 'lazy' | 'off' | 'always'
  repair: { max_rounds: number; stall_stop: boolean }
  stages: Stage[]
  profiles: Record<string, ProfileEntry[]>
}

function stripQuotes(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
    return t.slice(1, -1)
  return t
}

function parseScalar(v: string): string | number | boolean {
  const s = stripQuotes(v)
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

function fail(msg: string): never {
  console.error(`[robobun-verify] 配置错误：${msg}`)
  process.exit(1)
}

function parseConfig(text: string): Config {
  const cfg: Config = {
    version: 0,
    baseline: 'lazy',
    repair: { max_rounds: 3, stall_stop: true },
    stages: [],
    profiles: {},
  }
  let section: '' | 'repair' | 'stages' | 'profiles' = ''
  let currentProfile: string | null = null
  let current: Partial<Stage> | null = null

  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue
    if (/\t/.test(raw)) fail('不允许使用 Tab 缩进')

    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()

    if (line.startsWith('- ')) {
      if (section === 'stages') {
        if (current) cfg.stages.push(current as Stage)
        current = {}
        const m = line.slice(2).match(/^(\w+):\s*(.*)$/)
        if (!m) fail(`stages 列表项首行必须是 "name: ..."：${line}`)
        current[m[1]] = parseScalar(m[2]) as never
        continue
      }
      if (section === 'profiles' && currentProfile) {
        // 条目形态：`- stage名` 或 `- stage名 "覆盖命令"`（命令经 sh -c 展开，支持 ${VAR:-默认}）
        const m = line.slice(2).match(/^(\S+)(?:\s+(.*))?$/)
        if (!m) fail(`profiles 条目无法解析：${line}`)
        cfg.profiles[currentProfile].push({
          stage: m[1],
          command: m[2] ? stripQuotes(m[2]) : undefined,
        })
        continue
      }
      fail(`列表项只允许出现在 stages / profiles 下：${line}`)
    }

    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (!kv) fail(`无法解析的行：${line}`)
    const [, key, value] = kv

    if (indent === 0) {
      if (value === '') {
        if (key === 'repair') section = 'repair'
        else if (key === 'stages') section = 'stages'
        else if (key === 'profiles') section = 'profiles'
        else fail(`未知分组：${key}`)
      } else {
        if (key === 'version') cfg.version = Number(value)
        else if (key === 'baseline') cfg.baseline = parseScalar(value) as Config['baseline']
        else fail(`未知顶层键：${key}`)
        section = ''
      }
      continue
    }

    if (section === 'repair' && indent >= 2) {
      if (key === 'max_rounds') cfg.repair.max_rounds = Number(value)
      else if (key === 'stall_stop') cfg.repair.stall_stop = value === 'true'
      else fail(`repair 下未知键：${key}`)
      continue
    }

    if (section === 'profiles' && indent === 2 && value === '') {
      currentProfile = key
      cfg.profiles[key] = []
      continue
    }

    if (section === 'stages' && indent >= 4 && current) {
      if (!(key in { name: 1, command: 1, required: 1, timeout_seconds: 1 }))
        fail(`stage 下未知键：${key}`)
      current[key] = parseScalar(value) as never
      continue
    }

    fail(`无法归属的行（缩进 ${indent}）：${line}`)
  }
  if (current) cfg.stages.push(current as Stage)

  if (cfg.version !== 1) fail('version 必须为 1')
  if (!cfg.stages.length) fail('stages 不能为空')
  for (const s of cfg.stages) {
    if (!s.name || !s.command) fail(`stage 缺 name/command：${JSON.stringify(s)}`)
    if (typeof s.required !== 'boolean') fail(`stage ${s.name} 缺 required 布尔值`)
    s.timeout_seconds = typeof s.timeout_seconds === 'number' ? s.timeout_seconds : 600
  }
  return cfg
}

/** 解析 -p 参数并展开 profile：按名引用 stages，允许 per-stage 命令覆盖。 */
function resolveStages(cfg: Config, profile: 'full' | 'quick'): Stage[] {
  if (profile === 'full') return cfg.stages
  const entries = cfg.profiles.quick
  if (!entries?.length) fail('verification.yaml 缺 profiles.quick 定义，无法 -p quick')
  return entries.map((e) => {
    const base = cfg.stages.find((s) => s.name === e.stage)
    if (!base) fail(`profiles.quick 引用了不存在的 stage：${e.stage}`)
    return e.command ? { ...base, command: e.command } : base
  })
}

// ---------- 执行 ----------

interface StageResult {
  name: string
  command: string
  status: 'passed' | 'failed' | 'skipped'
  exit_code: number | null
  duration_ms: number
  failed_tests: string[]
  log: string
}

async function runStage(stage: Stage, logDir: string): Promise<StageResult> {
  const started = Date.now()
  const logPath = join(logDir, `${stage.name}.log`)
  const proc = Bun.spawn(['sh', '-c', stage.command], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const timer = setTimeout(() => proc.kill(9), stage.timeout_seconds * 1000)
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exitCode = await proc.exited
  clearTimeout(timer)
  await Bun.write(
    logPath,
    `# command: ${stage.command}\n\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
  )
  const passed = exitCode === 0
  return {
    name: stage.name,
    command: stage.command,
    status: passed ? 'passed' : 'failed',
    exit_code: exitCode,
    duration_ms: Date.now() - started,
    failed_tests: extractFailedTests(out + err),
    log: relativeLog(logPath),
  }
}

/** 从常见测试输出中提取失败用例名（bun test 的 "(fail)" 行）。 */
function extractFailedTests(output: string): string[] {
  const lines: string[] = []
  for (const line of output.split('\n')) {
    const m = line.match(/\(fail\)\s+(.+?)\s+\[\d+(\.\d+)?(ms|s)\]\s*$/)
    if (m) lines.push(m[1].trim())
  }
  return [...new Set(lines)]
}

function relativeLog(p: string): string {
  return p.startsWith(`${process.cwd()}/`) ? p.slice(process.cwd().length + 1) : p
}

async function gitInfo(): Promise<{ commit: string; dirty: boolean }> {
  const shaProc = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
  const stProc = Bun.spawn(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' })
  const [commit, status] = await Promise.all([
    new Response(shaProc.stdout).text(),
    new Response(stProc.stdout).text(),
  ])
  return { commit: commit.trim(), dirty: status.trim().length > 0 }
}

// ---------- 主流程 ----------

const argProfile = (() => {
  const i = process.argv.indexOf('-p')
  const v = i >= 0 ? process.argv[i + 1] : undefined
  if (v === undefined) return 'full' as const
  if (v === 'quick' || v === 'full') return v
  fail(`-p 只接受 quick|full：${v}`)
})()

const root = process.cwd()
const cfg = parseConfig(await Bun.file(join(root, '.robobun/verification.yaml')).text())
const stages = resolveStages(cfg, argProfile)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const evDir = join(root, '.robobun/evidence')
const logDir = join(evDir, `verify-${stamp}`, 'logs')
mkdirSync(logDir, { recursive: true })

const results: StageResult[] = []
let shortCircuit = false
for (const stage of stages) {
  if (shortCircuit) {
    results.push({
      name: stage.name,
      command: stage.command,
      status: 'skipped',
      exit_code: null,
      duration_ms: 0,
      failed_tests: [],
      log: '',
    })
    continue
  }
  const r = await runStage(stage, logDir)
  results.push(r)
  const mark = r.status === 'passed' ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${stage.name} (${(r.duration_ms / 1000).toFixed(1)}s) exit=${r.exit_code}`)
  if (r.status === 'failed') shortCircuit = true // 任一失败即短路，后续记 skipped
}

const failed = results.filter((r) => r.status === 'failed')
const skipped = results.filter((r) => r.status === 'skipped')
const passedCount = results.filter((r) => r.status === 'passed').length
const report = {
  schema: 'robobun.verify/1' as const,
  task: process.env.ROBOBUN_TASK ?? null,
  attempt: process.env.ROBOBUN_ATTEMPT ? Number(process.env.ROBOBUN_ATTEMPT) : null,
  profile: argProfile,
  ...(await gitInfo()),
  started_at: new Date(Date.now() - results.reduce((a, r) => a + r.duration_ms, 0)).toISOString(),
  finished_at: new Date().toISOString(),
  status: failed.length === 0 ? ('passed' as const) : ('failed' as const),
  stages: results,
  summary: { passed: passedCount, failed: failed.length, skipped: skipped.length },
}

const outPath = join(evDir, `verify-${stamp}.json`)
await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`)
// latest.json 只由结论性全量运行覆写；quick 是过程反馈，不得覆盖 PR 证据引用的结论。
if (argProfile === 'full') {
  await Bun.write(join(evDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`)
}

console.log(
  `\nrobobun.verify/1 [${argProfile}] → ${report.status.toUpperCase()}  (passed=${passedCount} failed=${failed.length} skipped=${skipped.length})`,
)
console.log(`证据: ${outPath.replace(`${root}/`, '')}`)
if (failed.length) {
  for (const f of failed) {
    console.log(
      `  失败: ${f.name} → ${f.log}${f.failed_tests.length ? `\n    失败用例: ${f.failed_tests.join(' | ')}` : ''}`,
    )
  }
  process.exit(1)
}
