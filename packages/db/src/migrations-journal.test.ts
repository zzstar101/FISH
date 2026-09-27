import { expect, test } from 'bun:test'
import { join } from 'node:path'

/**
 * #316 迁移 journal 一致性门禁：**纯文件断言，不连库、不读 `DATABASE_URL`**（与 #309 / PR #312 同源的兼容版）。
 *
 * 为什么需要它：drizzle 的 migrator 按 `meta/_journal.json` 的 `tag` 定位 SQL 文件
 * （`${migrationsFolder}/${journalEntry.tag}.sql`），并按 `when > 已应用的 folderMillis` 决定是否应用；
 * **`idx` 完全不参与 Postgres 迁移**（`drizzle-orm` 的 `migrator.js`，只有 sqlite/expo 系用 `m${idx}`）。
 * 于是有三类事故 `db:migrate` 与 CI 都发现不了：
 *
 * 1. 两个分支各自生成迁移、tag 撞车 → merge 后两条都执行，库里多出一对同编号迁移；
 * 2. journal 条目在 merge 中丢失、`.sql` 文件还在 → 该迁移**永远不会被应用**，照样全绿；
 * 3. journal 顺序与 `when` 不一致（merge 冲突解错）→ 排在后面的旧 `when` 被**静默跳过**。
 *
 * #316 把迁移编号从「按合入顺序分配的 4 位序号」换成「UTC+8 时间戳前缀」，因此本文件相对 #309 的
 * 门禁有两点口径变化：**`idx` 不再要求全局唯一 / 连续**（时间戳方案下 idx 不代表身份，两条并行分支
 * 合入后重复是良性的），改以 **tag 唯一** 作为「编号不撞车」的硬约束；并新增「时间戳前缀必须是合法
 * UTC+8 墙钟时间且与 `when` 对应」与「`when` 沿 journal 顺序严格递增」两条不变式。
 *
 * 失败信息点名冲突双方（重复的 tag 与其条目位置、乱序的两条 tag 与 when、孤儿文件名、断链的
 * snapshot 与期望 id），而不是一句 `expect(...).toBe(true)`。
 *
 * 不改 `packages/db/src/migrations/**`（生成物）：下面的「会失败的用例」在**内存夹具**上构造坏数据，
 * 证明每条断言真的能红，不碰真实迁移文件。
 */

const migrationsFolder = join(import.meta.dir, 'migrations')
const metaFolderName = 'meta'
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000
/** 前缀与 `when` 的允许偏差：drizzle-kit 先取时间戳、再取 `when`，两者相差毫秒级。 */
const WHEN_TOLERANCE_MS = 2000
const NUMERIC_TAG = /^(\d{4})_/
const TIMESTAMP_TAG = /^(\d{14})_/

type JournalEntry = {
  idx: number
  version: string
  when: number
  tag: string
  /** drizzle-kit 会写这个字段，但门禁不依赖它。 */
  breakpoints?: boolean
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

/** snapshot 的短标签：`0007_snapshot.json` / `20260928063000_snapshot.json` → 前缀数字。 */
function snapshotLabel(snapshot: Snapshot): string {
  return /^(\d+)_/.exec(snapshot.name)?.[1] ?? snapshot.name
}

/** epoch 毫秒 → UTC+8 墙钟的 14 位前缀，例 `1790546582603` → `20260928060302`。 */
function formatUtc8Prefix(when: number): string {
  return new Date(when + UTC8_OFFSET_MS).toISOString().slice(0, 19).replace(/[-:T]/g, '')
}

/** 14 位 UTC+8 墙钟前缀 → epoch 毫秒；不是合法墙钟时间（如 `20261332000000`）时返回 null。 */
function timestampPrefixEpochMs(prefix: string): number | null {
  const year = Number(prefix.slice(0, 4))
  const month = Number(prefix.slice(4, 6))
  const day = Number(prefix.slice(6, 8))
  const hour = Number(prefix.slice(8, 10))
  const minute = Number(prefix.slice(10, 12))
  const second = Number(prefix.slice(12, 14))
  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const wallClock = new Date(wallClockMs)
  // Date.UTC 会把 13 月 / 32 日归一化成别的日期，必须回代校验。
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day ||
    wallClock.getUTCHours() !== hour ||
    wallClock.getUTCMinutes() !== minute ||
    wallClock.getUTCSeconds() !== second
  ) {
    return null
  }
  return wallClockMs - UTC8_OFFSET_MS
}

/** tag 是新的「迁移编号」：必须唯一，撞号在此暴露。 */
function tagUniquenessViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  const positionsByTag = new Map<string, number[]>()
  entries.forEach((entry, index) => {
    const positions = positionsByTag.get(entry.tag)
    if (positions) positions.push(index + 1)
    else positionsByTag.set(entry.tag, [index + 1])
  })
  for (const [tag, positions] of positionsByTag) {
    if (positions.length > 1) {
      violations.push(
        `迁移编号 \`${tag}\` 在 journal 中出现 ${positions.length} 次（第 ${positions.join('、')} 条）`,
      )
    }
  }
  return violations
}

/**
 * tag 前缀方案：遗留的 `NNNN_` 只允许出现在 journal 开头连续一段且 `NNNN === pad4(idx)`；
 * 一旦出现 14 位时间戳 tag，其后不得再出现手写序号 tag；时间戳前缀必须是合法 UTC+8 墙钟时间，
 * 且与同条目 `when` 对应（容差 ≤ 2s）。
 */
function tagSchemeViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  const firstTimestamp = entries.findIndex((entry) => TIMESTAMP_TAG.test(entry.tag))
  entries.forEach((entry, index) => {
    const position = index + 1
    const numeric = NUMERIC_TAG.exec(entry.tag)
    if (numeric) {
      if (firstTimestamp !== -1 && index > firstTimestamp) {
        violations.push(
          `第 ${position} 条 \`${entry.tag}\` 是手写序号 tag：时间戳 tag \`${entries[firstTimestamp]?.tag}\`（第 ${firstTimestamp + 1} 条）之后必须使用生成器产出的 14 位 UTC+8 时间戳前缀`,
        )
        return
      }
      const prefix = `${pad4(entry.idx)}_`
      if (!entry.tag.startsWith(prefix)) {
        violations.push(
          `第 ${position} 条 \`${entry.tag}\` 的遗留序号前缀与 idx 不一致：应以 \`${prefix}\` 开头`,
        )
      }
      return
    }
    const timestamp = TIMESTAMP_TAG.exec(entry.tag)
    if (timestamp === null) {
      violations.push(
        `第 ${position} 条 \`${entry.tag}\` 既不是遗留的 \`NNNN_\` 序号 tag，也不是 14 位 UTC+8 时间戳 tag`,
      )
      return
    }
    const digits = timestamp[1] ?? ''
    const prefixEpochMs = timestampPrefixEpochMs(digits)
    if (prefixEpochMs === null) {
      violations.push(
        `第 ${position} 条 \`${entry.tag}\` 的 14 位前缀 \`${digits}\` 不是合法的 UTC+8 墙钟时间`,
      )
      return
    }
    const deltaMs = entry.when - prefixEpochMs
    if (Math.abs(deltaMs) > WHEN_TOLERANCE_MS) {
      violations.push(
        `第 ${position} 条 \`${entry.tag}\` 的时间戳前缀与 when=${entry.when} 不对应：按 UTC+8 应为 \`${formatUtc8Prefix(entry.when)}\`（相差 ${deltaMs}ms，容差 ${WHEN_TOLERANCE_MS}ms）`,
      )
    }
  })
  return violations
}

/** `when` 沿 journal 顺序严格递增：否则 drizzle 会静默跳过排在后面的旧 `when` 迁移。 */
function whenOrderViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (previous === undefined || current === undefined) continue
    if (current.when <= previous.when) {
      violations.push(
        `第 ${index + 1} 条 \`${current.tag}\` 的 when=${current.when} 不大于第 ${index} 条 \`${previous.tag}\` 的 when=${previous.when}：migrator 按 when 递增判定是否应用，乱序会让该迁移被静默跳过`,
      )
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
    ...tagUniquenessViolations(fixture.entries),
    ...tagSchemeViolations(fixture.entries),
    ...whenOrderViolations(fixture.entries),
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

test('#316 真实迁移目录：tag 唯一 / 前缀方案 / when 递增 / .sql ↔ journal / snapshot 链全部一致', async () => {
  const fixture = await loadMigrationsFixture(migrationsFolder)
  // 防止夹具读空导致「空断言全绿」。
  expect(fixture.entries.length).toBeGreaterThan(0)
  expect(fixture.sqlFiles.length).toBeGreaterThan(0)
  expect(fixture.snapshots.length).toBeGreaterThan(0)
  expect(collectJournalViolations(fixture)).toEqual([])
})

/** 以下用例的合法基线：若基线本身有告警，失败用例就不能证明断言有效。 */
const syntheticId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const legacyEntries: JournalEntry[] = [
  { idx: 0, version: '7', when: 1, tag: '0000_init', breakpoints: true },
  { idx: 1, version: '7', when: 2, tag: '0001_alpha', breakpoints: true },
  { idx: 2, version: '7', when: 3, tag: '0002_beta', breakpoints: true },
]
const legacySqlFiles = ['0000_init.sql', '0001_alpha.sql', '0002_beta.sql']
const legacySnapshots: Snapshot[] = [
  { name: '0000_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID },
  { name: '0001_snapshot.json', id: syntheticId(1), prevId: syntheticId(0) },
  { name: '0002_snapshot.json', id: syntheticId(2), prevId: syntheticId(1) },
]

function syntheticFixture(overrides: Partial<MigrationsFixture> = {}): MigrationsFixture {
  return {
    entries: legacyEntries,
    sqlFiles: legacySqlFiles,
    snapshots: legacySnapshots,
    ...overrides,
  }
}

function syntheticMessages(overrides: Partial<MigrationsFixture> = {}): string {
  return collectJournalViolations(syntheticFixture(overrides)).join('\n')
}

test('#316 校验器基线：合法夹具零告警', () => {
  expect(collectJournalViolations(syntheticFixture())).toEqual([])
})

test('#316 合法的时间戳 tag：前缀 == when 的 UTC+8 墙钟（容差 2s）', () => {
  const when = 1790546582603 // UTC 2026-09-27T22:03:02.603Z → UTC+8 2026-09-28 06:03:02
  expect(formatUtc8Prefix(when)).toBe('20260928060302')
  const fixture = syntheticFixture({
    entries: [{ idx: 25, version: '7', when, tag: '20260928060302_shallow_mimic' }],
    sqlFiles: ['20260928060302_shallow_mimic.sql'],
    snapshots: [{ name: '20260928060302_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID }],
  })
  expect(collectJournalViolations(fixture)).toEqual([])
  // 前缀与 when 相差超过容差即报警，并给出按 UTC+8 算出的正确前缀。
  expect(
    syntheticMessages({
      entries: [{ idx: 25, version: '7', when, tag: '20260928050000_shallow_mimic' }],
      sqlFiles: ['20260928050000_shallow_mimic.sql'],
      snapshots: [{ name: '20260928050000_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID }],
    }),
  ).toContain('按 UTC+8 应为 `20260928060302`')
})

test('#316 撞号：点名同时占用同一编号的 tag 与条目位置', () => {
  const messages = syntheticMessages({
    entries: [
      ...legacyEntries.slice(0, 2),
      { idx: 1, version: '7', when: 3, tag: '0001_alpha', breakpoints: true },
    ],
    sqlFiles: ['0000_init.sql', '0001_alpha.sql'],
    snapshots: legacySnapshots.slice(0, 2),
  })
  expect(messages).toContain('迁移编号 `0001_alpha` 在 journal 中出现 2 次（第 2、3 条）')
})

test('#316 时间戳之后又手写序号：点名两条 tag', () => {
  const messages = syntheticMessages({
    entries: [
      { idx: 25, version: '7', when: 1790546582603, tag: '20260928060302_legacy_shift' },
      { idx: 26, version: '7', when: 1790548339749, tag: '0026_late_havok', breakpoints: true },
    ],
    sqlFiles: ['20260928060302_legacy_shift.sql', '0026_late_havok.sql'],
    snapshots: [
      { name: '20260928060302_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID },
      { name: '0026_snapshot.json', id: syntheticId(1), prevId: syntheticId(0) },
    ],
  })
  expect(messages).toContain('`0026_late_havok` 是手写序号 tag')
  expect(messages).toContain('`20260928060302_legacy_shift`（第 1 条）之后')
})

test('#316 非法前缀与未知方案：都要点名具体 tag', () => {
  expect(
    syntheticMessages({
      entries: [{ idx: 26, version: '7', when: 1790548339749, tag: '20261332000000_bad' }],
      sqlFiles: ['20261332000000_bad.sql'],
      snapshots: [{ name: '20261332000000_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID }],
    }),
  ).toContain('`20261332000000_bad` 的 14 位前缀 `20261332000000` 不是合法的 UTC+8 墙钟时间')
  expect(
    syntheticMessages({
      entries: [{ idx: 26, version: '7', when: 1790548339749, tag: '0027_late_havok' }],
      sqlFiles: ['0027_late_havok.sql'],
      snapshots: [{ name: '0027_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID }],
    }),
  ).toContain('`0027_late_havok` 的遗留序号前缀与 idx 不一致：应以 `0026_` 开头')
  expect(
    syntheticMessages({
      entries: [{ idx: 26, version: '7', when: 1790548339749, tag: 'late_havok' }],
      sqlFiles: ['late_havok.sql'],
      snapshots: [{ name: 'late_havok_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID }],
    }),
  ).toContain('`late_havok` 既不是遗留的 `NNNN_` 序号 tag，也不是 14 位 UTC+8 时间戳 tag')
})

test('#316 when 乱序：点名两条 tag 与各自 when', () => {
  const messages = syntheticMessages({
    entries: [
      { idx: 0, version: '7', when: 1790548339749, tag: '0000_newer' },
      { idx: 1, version: '7', when: 1790546582603, tag: '0001_older', breakpoints: true },
    ],
    sqlFiles: ['0000_newer.sql', '0001_older.sql'],
    snapshots: legacySnapshots.slice(0, 2),
  })
  expect(messages).toContain('第 2 条 `0001_older` 的 when=1790546582603')
  expect(messages).toContain('不大于第 1 条 `0000_newer` 的 when=1790548339749')
  expect(messages).toContain('静默跳过')
})

test('#316 重复 idx 但 tag 唯一：不再报警（两条并行分支合入后的良性形态）', () => {
  const firstWhen = 1790546582603 // → 20260928060302
  const secondWhen = 1790548339749 // → 20260928063219
  const fixture = syntheticFixture({
    entries: [
      ...legacyEntries,
      { idx: 3, version: '7', when: firstWhen, tag: '20260928060302_parallel_one' },
      { idx: 3, version: '7', when: secondWhen, tag: '20260928063219_parallel_two' },
    ],
    sqlFiles: [
      ...legacySqlFiles,
      '20260928060302_parallel_one.sql',
      '20260928063219_parallel_two.sql',
    ],
    snapshots: [
      ...legacySnapshots,
      {
        name: '20260928060302_snapshot.json',
        id: syntheticId(3),
        prevId: syntheticId(2),
      },
      {
        name: '20260928063219_snapshot.json',
        id: syntheticId(4),
        prevId: syntheticId(3),
      },
    ],
  })
  expect(collectJournalViolations(fixture)).toEqual([])
})

test('#316 孤儿迁移与缺文件：双向都点名具体文件名', () => {
  expect(syntheticMessages({ sqlFiles: [...legacySqlFiles, '0003_ghost.sql'] })).toContain(
    '孤儿迁移 `0003_ghost.sql` 不在 journal 中',
  )
  expect(
    syntheticMessages({ sqlFiles: legacySqlFiles.filter((name) => name !== '0002_beta.sql') }),
  ).toContain('journal 条目 `0002_beta` 缺少对应文件 `0002_beta.sql`')
})

test('#316 snapshot 数量与 prevId 链：点名断链的 snapshot 与期望 id', () => {
  expect(syntheticMessages({ snapshots: legacySnapshots.slice(0, 2) })).toContain(
    'meta/ 的 snapshot 数量 2 与 journal 条目数 3 不一致',
  )
  expect(
    syntheticMessages({
      snapshots: legacySnapshots.map((snapshot, index) =>
        index === 0 ? { ...snapshot, prevId: syntheticId(9) } : snapshot,
      ),
    }),
  ).toContain(`snapshot 0000 的 prevId 是 ${syntheticId(9)}，应为全零 UUID ${ZERO_UUID}`)
  expect(
    syntheticMessages({
      snapshots: legacySnapshots.map((snapshot, index) =>
        index === 2 ? { ...snapshot, prevId: syntheticId(9) } : snapshot,
      ),
    }),
  ).toContain(`snapshot 0002 的 prevId 指向 ${syntheticId(9)}，但 0001 的 id 是 ${syntheticId(1)}`)
})
