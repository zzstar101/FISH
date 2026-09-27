import { expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * #309 迁移 journal 一致性门禁：**纯文件断言，不连库、不读 `DATABASE_URL`**。
 *
 * 为什么需要它：drizzle 的 migrator 按 `meta/_journal.json` 的 `tag` 定位 SQL 文件
 * （`${migrationsFolder}/${journalEntry.tag}.sql`），序号只体现在 tag 前缀上。于是有两类
 * 事故 `db:migrate` 与 CI 都发现不了：
 *
 * 1. 两个分支各生成同号迁移（tag 不同）→ merge 后两条都执行，库里多出一对同号迁移；
 * 2. journal 条目在 merge 中丢失、`.sql` 文件还在 → 该迁移**永远不会被应用**，照样全绿。
 *
 * 本文件逐条断言：序号唯一且恰为 `0..N-1` 连续、tag 前缀与 idx 一致、`.sql` ↔ journal
 * 双向一一对应、snapshot 数量与 `prevId` 链完整。失败信息点名冲突双方（同号的两个 tag /
 * 孤儿文件名 / 断链的 snapshot 与期望 id），而不是一句 `expect(...).toBe(true)`。
 *
 * 不改 `packages/db/src/migrations/**`（生成物）：下面的「会失败的用例」在**内存夹具**上
 * 构造坏数据，证明每条断言真的能红，不碰真实迁移文件。
 */

const migrationsFolder = join(import.meta.dir, 'migrations')
const metaFolderName = 'meta'
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

type JournalEntry = {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}

type Journal = { version: string; dialect: string; entries: JournalEntry[] }

type Snapshot = { name: string; id: string; prevId: string }

type MigrationsFixture = {
  entries: JournalEntry[]
  sqlFiles: string[]
  snapshots: Snapshot[]
}

function pad4(idx: number): string {
  return String(idx).padStart(4, '0')
}

/** snapshot 的短标签：`0007_snapshot.json` → `0007`。 */
function snapshotLabel(snapshot: Snapshot): string {
  return /^(\d+)_/.exec(snapshot.name)?.[1] ?? snapshot.name
}

/** 序号唯一，且恰为 `0..N-1` 连续。 */
function journalOrderViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  const tagsByIdx = new Map<number, string[]>()
  for (const entry of entries) {
    const tags = tagsByIdx.get(entry.idx)
    if (tags) tags.push(entry.tag)
    else tagsByIdx.set(entry.idx, [entry.tag])
  }
  for (const [idx, tags] of [...tagsByIdx].sort((a, b) => a[0] - b[0])) {
    if (tags.length > 1) {
      violations.push(
        `序号 ${pad4(idx)} 被 ${tags.map((tag) => `\`${tag}\``).join(' 与 ')} 同时占用`,
      )
    }
  }
  const missing = entries.map((_, index) => index).filter((idx) => !tagsByIdx.has(idx))
  const extra = [...tagsByIdx.keys()]
    .filter((idx) => idx < 0 || idx >= entries.length)
    .sort((a, b) => a - b)
  if (missing.length > 0 || extra.length > 0) {
    violations.push(
      `journal idx 应为 0..${entries.length - 1} 连续：缺少 [${missing.map(pad4).join(', ')}]，多出 [${extra.map(pad4).join(', ')}]`,
    )
  }
  return violations
}

/** tag 前缀与 idx 一致：序号必须体现在 tag 前四位。 */
function tagPrefixViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  for (const entry of entries) {
    const prefix = `${pad4(entry.idx)}_`
    if (!entry.tag.startsWith(prefix)) {
      violations.push(`序号 ${pad4(entry.idx)} 的 tag \`${entry.tag}\` 不以 \`${prefix}\` 开头`)
    }
  }
  return violations
}

/** 目录内每个 `*.sql` 恰有一条 journal 条目，每条 journal 条目都有对应的 `<tag>.sql`。 */
function fileMappingViolations(entries: JournalEntry[], sqlFiles: string[]): string[] {
  const violations: string[] = []
  const tagCounts = new Map<string, number>()
  for (const entry of entries) tagCounts.set(entry.tag, (tagCounts.get(entry.tag) ?? 0) + 1)
  for (const [tag, count] of tagCounts) {
    if (count > 1) violations.push(`tag \`${tag}\` 在 journal 中出现 ${count} 次`)
  }
  const fileNames = new Set(sqlFiles)
  for (const entry of entries) {
    if (!fileNames.has(`${entry.tag}.sql`)) {
      violations.push(`journal 条目 \`${entry.tag}\` 缺少对应文件 \`${entry.tag}.sql\``)
    }
  }
  const knownTags = new Set(entries.map((entry) => entry.tag))
  for (const file of sqlFiles) {
    if (!knownTags.has(file.slice(0, -'.sql'.length))) {
      violations.push(`孤儿迁移 \`${file}\` 不在 journal 中`)
    }
  }
  return violations
}

/** `meta/*_snapshot.json` 数量与 journal 条目数一致，且 `prevId` 链连续。 */
function snapshotChainViolations(entries: JournalEntry[], snapshots: Snapshot[]): string[] {
  const violations: string[] = []
  if (snapshots.length !== entries.length) {
    violations.push(
      `meta/ 的 snapshot 数量 ${snapshots.length} 与 journal 条目数 ${entries.length} 不一致`,
    )
  }
  const ordered = [...snapshots].sort((a, b) => a.name.localeCompare(b.name))
  for (const [index, snapshot] of ordered.entries()) {
    const previous = index === 0 ? null : ordered[index - 1]
    if (previous === undefined) continue
    if (previous === null) {
      if (snapshot.prevId !== ZERO_UUID) {
        violations.push(
          `snapshot ${snapshotLabel(snapshot)} 的 prevId 是 ${snapshot.prevId}，应为全零 UUID ${ZERO_UUID}`,
        )
      }
      continue
    }
    if (snapshot.prevId !== previous.id) {
      violations.push(
        `snapshot ${snapshotLabel(snapshot)} 的 prevId 指向 ${snapshot.prevId}，但 ${snapshotLabel(previous)} 的 id 是 ${previous.id}`,
      )
    }
  }
  return violations
}

function collectJournalViolations(fixture: MigrationsFixture): string[] {
  return [
    ...journalOrderViolations(fixture.entries),
    ...tagPrefixViolations(fixture.entries),
    ...fileMappingViolations(fixture.entries, fixture.sqlFiles),
    ...snapshotChainViolations(fixture.entries, fixture.snapshots),
  ]
}

async function readJson<T>(path: string): Promise<T> {
  return (await Bun.file(path).json()) as T
}

async function listFileNames(folder: string, pattern: string): Promise<string[]> {
  const names: string[] = []
  for await (const name of new Bun.Glob(pattern).scan({ cwd: folder, onlyFiles: true })) {
    names.push(name)
  }
  return names.sort()
}

async function loadMigrationsFixture(folder: string): Promise<MigrationsFixture> {
  const journal = await readJson<Journal>(join(folder, metaFolderName, '_journal.json'))
  const sqlFiles = await listFileNames(folder, '*.sql')
  const snapshotNames = await listFileNames(join(folder, metaFolderName), '*_snapshot.json')
  const snapshots: Snapshot[] = []
  for (const name of snapshotNames) {
    const snapshot = await readJson<{ id: string; prevId: string }>(
      join(folder, metaFolderName, name),
    )
    snapshots.push({ name, id: snapshot.id, prevId: snapshot.prevId })
  }
  return { entries: journal.entries, sqlFiles, snapshots }
}

test('#309 真实迁移目录：序号 / tag 前缀 / .sql ↔ journal / snapshot 链全部一致', async () => {
  const fixture = await loadMigrationsFixture(migrationsFolder)
  // 防止夹具读空导致「空断言全绿」。
  expect(fixture.entries.length).toBeGreaterThan(0)
  expect(fixture.sqlFiles.length).toBeGreaterThan(0)
  expect(fixture.snapshots.length).toBeGreaterThan(0)
  expect(collectJournalViolations(fixture)).toEqual([])
})

/** 以下用例的合法基线：若基线本身有告警，失败用例就不能证明断言有效。 */
const syntheticId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const validEntries: JournalEntry[] = [
  { idx: 0, version: '7', when: 1, tag: '0000_init', breakpoints: true },
  { idx: 1, version: '7', when: 2, tag: '0001_alpha', breakpoints: true },
  { idx: 2, version: '7', when: 3, tag: '0002_beta', breakpoints: true },
]
const validSqlFiles = ['0000_init.sql', '0001_alpha.sql', '0002_beta.sql']
const validSnapshots: Snapshot[] = [
  { name: '0000_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID },
  { name: '0001_snapshot.json', id: syntheticId(1), prevId: syntheticId(0) },
  { name: '0002_snapshot.json', id: syntheticId(2), prevId: syntheticId(1) },
]

function syntheticFixture(overrides: Partial<MigrationsFixture> = {}): MigrationsFixture {
  return { entries: validEntries, sqlFiles: validSqlFiles, snapshots: validSnapshots, ...overrides }
}

function syntheticMessages(overrides: Partial<MigrationsFixture> = {}): string {
  return collectJournalViolations(syntheticFixture(overrides)).join('\n')
}

test('#309 校验器基线：合法夹具零告警', () => {
  expect(collectJournalViolations(syntheticFixture())).toEqual([])
})

test('#309 同号迁移：点名同时占用该序号的两个 tag', () => {
  const messages = syntheticMessages({
    entries: [
      ...validEntries.slice(0, 2),
      { idx: 1, version: '7', when: 3, tag: '0001_beta', breakpoints: true },
    ],
  })
  expect(messages).toContain('序号 0001 被 `0001_alpha` 与 `0001_beta` 同时占用')
})

test('#309 tag 前缀与 idx 不一致：点名序号与 tag', () => {
  const messages = syntheticMessages({
    entries: [
      ...validEntries.slice(0, 2),
      { idx: 2, version: '7', when: 3, tag: '0001_beta', breakpoints: true },
    ],
  })
  expect(messages).toContain('序号 0002 的 tag `0001_beta` 不以 `0002_` 开头')
})

test('#309 孤儿迁移与缺文件：双向都点名具体文件名', () => {
  expect(syntheticMessages({ sqlFiles: [...validSqlFiles, '0003_ghost.sql'] })).toContain(
    '孤儿迁移 `0003_ghost.sql` 不在 journal 中',
  )
  expect(
    syntheticMessages({ sqlFiles: validSqlFiles.filter((name) => name !== '0002_beta.sql') }),
  ).toContain('journal 条目 `0002_beta` 缺少对应文件 `0002_beta.sql`')
})

test('#309 snapshot 数量与 prevId 链：点名断链的 snapshot 与期望 id', () => {
  expect(syntheticMessages({ snapshots: validSnapshots.slice(0, 2) })).toContain(
    'meta/ 的 snapshot 数量 2 与 journal 条目数 3 不一致',
  )
  expect(
    syntheticMessages({
      snapshots: validSnapshots.map((snapshot, index) =>
        index === 0 ? { ...snapshot, prevId: syntheticId(9) } : snapshot,
      ),
    }),
  ).toContain(`snapshot 0000 的 prevId 是 ${syntheticId(9)}，应为全零 UUID ${ZERO_UUID}`)
  expect(
    syntheticMessages({
      snapshots: validSnapshots.map((snapshot, index) =>
        index === 2 ? { ...snapshot, prevId: syntheticId(9) } : snapshot,
      ),
    }),
  ).toContain(`snapshot 0002 的 prevId 指向 ${syntheticId(9)}，但 0001 的 id 是 ${syntheticId(1)}`)
})
