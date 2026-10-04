import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

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
 * UTC+8 墙钟时间且与 `when` 对应」、「`when` 沿 journal 顺序严格递增」、「`when` 是有限数字」三条不变式。
 *
 * 还**冻结了遗留序号段**：数字 tag 的数量与末条 tag 必须停在 #316 合入时的 `0000_init` … `0025_shallow_mimic`
 * （26 条）。文档明令「不要手写 `0026_xxx`」，而只断言 `NNNN === pad4(idx)` 是挡不住的——紧接着手写的
 * `0026_hand_written` 恰好满足「idx 与位置一致」，所以这里再钉一条「遗留段不得增长」。
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
/** #316 合入时遗留序号段的快照：`0000_init` … `0025_shallow_mimic`，此后只允许时间戳 tag。 */
const FROZEN_LEGACY_TAG_COUNT = 26
const FROZEN_LEGACY_LAST_TAG = '0025_shallow_mimic'

type JournalEntry = {
  idx: number
  version: string
  /** drizzle-kit 一定会写；声明成可选才能让门禁真的验出「缺字段」（见 `whenFieldViolations`）。 */
  when?: number
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

type JournalGateOptions = {
  /**
   * 冻结遗留序号段：只在真实目录上启用——内存夹具为了可读性只造 2~3 条缩略遗留段，
   * 对它们套用真实数量（26 条）会误报。
   */
  frozenLegacy?: { count: number; lastTag: string }
}

function pad4(idx: number): string {
  return String(idx).padStart(4, '0')
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** snapshot 的短标签：`0007_snapshot.json` / `20260928063000_snapshot.json` → 前缀数字。 */
function snapshotLabel(snapshot: Snapshot): string {
  return /^(\d+)_/.exec(snapshot.name)?.[1] ?? snapshot.name
}

/**
 * epoch 毫秒 → UTC+8 墙钟的 14 位前缀，例 `1790546582603` → `20260928060302`。
 *
 * 刻意只用 `getUTC*` 取值、**不走 `toISOString()`**：生成侧 preload（`scripts/utc8-timestamp-prefix.ts`）
 * 会把 `Date.prototype.toISOString` 全局改写成「按 UTC+8 渲染」，若这里依赖它，同进程跑完那个测试文件后
 * 期望值会被多叠一次 8 小时（+16h）而误报。
 */
function formatUtc8Prefix(when: number): string {
  const shifted = new Date(when + UTC8_OFFSET_MS)
  return [
    String(shifted.getUTCFullYear()),
    pad2(shifted.getUTCMonth() + 1),
    pad2(shifted.getUTCDate()),
    pad2(shifted.getUTCHours()),
    pad2(shifted.getUTCMinutes()),
    pad2(shifted.getUTCSeconds()),
  ].join('')
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
      const twin = entries.find(
        (other, otherIndex) => otherIndex !== index && other.idx === entry.idx,
      )
      if (entry.idx !== index) {
        const twinNote =
          twin === undefined
            ? ''
            : `；\`idx=${entry.idx}\` 也出现在 \`${twin.tag}\`（两条并行分支各自追加了同一个编号）`
        violations.push(
          `第 ${position} 条 \`${entry.tag}\` 的 idx=${entry.idx} 与它的位置不一致（应为 ${index}）${twinNote}：遗留序号段必须从 0 开始、与位置一一对应且连续`,
        )
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
    // `when` 缺失 / NaN 由 `whenFieldViolations` 单独点名，这里不重复报。
    const when = entry.when
    if (typeof when !== 'number' || !Number.isFinite(when)) return
    const deltaMs = when - prefixEpochMs
    if (Math.abs(deltaMs) > WHEN_TOLERANCE_MS) {
      violations.push(
        `第 ${position} 条 \`${entry.tag}\` 的时间戳前缀与 when=${when} 不对应：按 UTC+8 应为 \`${formatUtc8Prefix(when)}\`（相差 ${deltaMs}ms，容差 ${WHEN_TOLERANCE_MS}ms）`,
      )
    }
  })
  return violations
}

/**
 * `when` 必须是有限数字：drizzle 的 migrator 用 `when > 已应用的 folderMillis` 判断是否应用，
 * `when` 缺失或为 `NaN` 时比较恒为 false，该迁移会被**静默跳过**（`db:migrate` 照样全绿）。
 */
function whenFieldViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  entries.forEach((entry, index) => {
    if (!Number.isFinite(entry.when)) {
      violations.push(
        `第 ${index + 1} 条 \`${entry.tag}\` 的 when=${String(entry.when)} 不是有限数字：migrator 以 when 判定「哪些迁移已应用」，缺字段或 NaN 会让该迁移被静默跳过`,
      )
    }
  })
  return violations
}

/**
 * 遗留序号段冻结：数字 tag 只允许是 #316 合入时的 `0000_init` … `0025_shallow_mimic`（26 条）。
 * 只断言 `NNNN === pad4(idx)` 挡不住「紧接着手写 `0026_xxx`」（它与位置恰好一致），而文档
 * （`CONTRIBUTING.md` / `packages/db/AGENTS.md`）明令不得再手写序号，故在此钉死遗留段长度。
 */
function legacyFreezeViolations(
  entries: JournalEntry[],
  frozen: { count: number; lastTag: string },
): string[] {
  const violations: string[] = []
  const numericTags = entries.map((entry) => entry.tag).filter((tag) => NUMERIC_TAG.test(tag))
  const lastNumericTag = numericTags[numericTags.length - 1]
  if (lastNumericTag !== undefined && lastNumericTag !== frozen.lastTag) {
    violations.push(
      `遗留序号段的末条 tag 是 \`${lastNumericTag}\`，应为 \`${frozen.lastTag}\`：遗留段已冻结，新增迁移必须用生成器产出的 UTC+8 时间戳 tag`,
    )
  }
  if (numericTags.length !== frozen.count) {
    violations.push(
      `遗留序号 tag 共 ${numericTags.length} 条，应为 ${frozen.count} 条（\`0000_init\` … \`${frozen.lastTag}\`）：不得再手写 \`00NN_xxx\`，请用 \`bun run --filter '@fish/db' generate\` 生成时间戳编号`,
    )
  }
  return violations
}

/** `when` 沿 journal 顺序严格递增：否则 drizzle 会静默跳过排在后面的旧 `when` 迁移。 */
function whenOrderViolations(entries: JournalEntry[]): string[] {
  const violations: string[] = []
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (previous === undefined || current === undefined) continue
    const previousWhen = previous.when
    const currentWhen = current.when
    // 缺字段 / 非有限数字由 `whenFieldViolations` 点名，这里不重复报。
    if (typeof previousWhen !== 'number' || typeof currentWhen !== 'number') continue
    if (!Number.isFinite(previousWhen) || !Number.isFinite(currentWhen)) continue
    if (currentWhen <= previousWhen) {
      violations.push(
        `第 ${index + 1} 条 \`${current.tag}\` 的 when=${currentWhen} 不大于第 ${index} 条 \`${previous.tag}\` 的 when=${previousWhen}：migrator 按 when 递增判定是否应用，乱序会让该迁移被静默跳过`,
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
  // snapshot 文件名前缀必须与同位置条目的编号前缀一致（`0007_snapshot.json` ↔ `0007_*`、
  // `20260928063000_snapshot.json` ↔ `20260928063000_*`）：挡住「文件名与 tag 无关」的脏数据。
  if (ordered.length === entries.length) {
    entries.forEach((entry, index) => {
      const snapshot = ordered[index]
      if (snapshot === undefined) return
      const tagPrefix = /^(\d+)_/.exec(entry.tag)?.[1]
      if (tagPrefix === undefined) return
      const label = snapshotLabel(snapshot)
      if (label !== tagPrefix) {
        violations.push(
          `第 ${index + 1} 条 \`${entry.tag}\` 对应 snapshot \`${snapshot.name}\` 的前缀 \`${label}\` 与编号前缀 \`${tagPrefix}\` 不一致：应为 \`${tagPrefix}_snapshot.json\``,
        )
      }
    })
  }
  return violations
}

function collectJournalViolations(
  fixture: MigrationsFixture,
  options: JournalGateOptions = {},
): string[] {
  const violations = [
    ...tagUniquenessViolations(fixture.entries),
    ...tagSchemeViolations(fixture.entries),
    ...whenFieldViolations(fixture.entries),
    ...whenOrderViolations(fixture.entries),
    ...fileMappingViolations(fixture.entries, fixture.sqlFiles),
    ...snapshotChainViolations(fixture.entries, fixture.snapshots),
  ]
  if (options.frozenLegacy) {
    violations.push(...legacyFreezeViolations(fixture.entries, options.frozenLegacy))
  }
  return violations
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
  expect(
    collectJournalViolations(fixture, {
      frozenLegacy: { count: FROZEN_LEGACY_TAG_COUNT, lastTag: FROZEN_LEGACY_LAST_TAG },
    }),
  ).toEqual([])
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

test('#316 真实撞号形态：两条并行分支各自追加同一个编号（tag 不同、idx 相同）', () => {
  const messages = syntheticMessages({
    entries: [
      ...legacyEntries,
      { idx: 3, version: '7', when: 4, tag: '0003_kind_harry_osborn', breakpoints: true },
      { idx: 3, version: '7', when: 5, tag: '0003_late_havok', breakpoints: true },
    ],
    sqlFiles: [...legacySqlFiles, '0003_kind_harry_osborn.sql', '0003_late_havok.sql'],
    snapshots: [
      ...legacySnapshots,
      { name: '0003_snapshot.json', id: syntheticId(3), prevId: syntheticId(2) },
    ],
  })
  expect(messages).toContain('`0003_late_havok` 的 idx=3 与它的位置不一致（应为 4）')
  expect(messages).toContain('`idx=3` 也出现在 `0003_kind_harry_osborn`')
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

test('#316 when 缺失：不再静默通过（drizzle 会静默跳过该迁移）', () => {
  const messages = syntheticMessages({
    entries: [{ idx: 0, version: '7', tag: '0000_init', breakpoints: true }],
    sqlFiles: ['0000_init.sql'],
    snapshots: [{ name: '0000_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID }],
  })
  expect(messages).toContain('第 1 条 `0000_init` 的 when=undefined 不是有限数字')
  expect(messages).toContain('静默跳过')
})

test('#316 snapshot 文件名前缀与编号不对应：点名文件与期望文件名', () => {
  expect(
    syntheticMessages({
      snapshots: [
        { name: '0000_snapshot.json', id: syntheticId(0), prevId: ZERO_UUID },
        { name: '0001_snapshot.json', id: syntheticId(1), prevId: syntheticId(0) },
        { name: '9999_snapshot.json', id: syntheticId(2), prevId: syntheticId(1) },
      ],
    }),
  ).toContain('对应 snapshot `9999_snapshot.json` 的前缀 `9999` 与编号前缀 `0002` 不一致')
})

/** 遗留段冻结用「真实规模」的夹具：26 条 `0000_init` … `0025_shallow_mimic`。 */
const frozenLegacyEntries: JournalEntry[] = Array.from(
  { length: FROZEN_LEGACY_TAG_COUNT },
  (_, index) => ({
    idx: index,
    version: '7',
    when: index + 1,
    tag:
      index === FROZEN_LEGACY_TAG_COUNT - 1
        ? FROZEN_LEGACY_LAST_TAG
        : `${pad4(index)}_legacy_${index}`,
    breakpoints: true,
  }),
)
const frozenLegacySqlFiles = frozenLegacyEntries.map((entry) => `${entry.tag}.sql`)
const frozenLegacySnapshots: Snapshot[] = frozenLegacyEntries.map((_, index) => ({
  name: `${pad4(index)}_snapshot.json`,
  id: syntheticId(index),
  prevId: index === 0 ? ZERO_UUID : syntheticId(index - 1),
}))
const frozenLegacyOption: JournalGateOptions = {
  frozenLegacy: { count: FROZEN_LEGACY_TAG_COUNT, lastTag: FROZEN_LEGACY_LAST_TAG },
}

test('#316 遗留段冻结：26 条真实规模的合法夹具零告警', () => {
  expect(
    collectJournalViolations(
      {
        entries: frozenLegacyEntries,
        sqlFiles: frozenLegacySqlFiles,
        snapshots: frozenLegacySnapshots,
      },
      frozenLegacyOption,
    ),
  ).toEqual([])
})

test('#316 遗留段冻结：接着手写 0026_xxx（idx 与位置恰好一致）也要报错', () => {
  const messages = collectJournalViolations(
    {
      entries: [
        ...frozenLegacyEntries,
        { idx: 26, version: '7', when: 27, tag: '0026_hand_written', breakpoints: true },
      ],
      sqlFiles: [...frozenLegacySqlFiles, '0026_hand_written.sql'],
      snapshots: [
        ...frozenLegacySnapshots,
        { name: '0026_snapshot.json', id: syntheticId(26), prevId: syntheticId(25) },
      ],
    },
    frozenLegacyOption,
  ).join('\n')
  expect(messages).toContain(
    '遗留序号段的末条 tag 是 `0026_hand_written`，应为 `0025_shallow_mimic`',
  )
  expect(messages).toContain('遗留序号 tag 共 27 条，应为 26 条')
})

/**
 * #439：**最新快照必须覆盖 `src/schema` 里的每一张表。**
 *
 * 为什么要单开一条：本文件此前的断言全是「迁移文件之间自洽」（tag 唯一 / `when` 递增 / `.sql` ↔ journal /
 * snapshot 链连续），断不出「快照内容落后于 schema」。而 drizzle-kit 算 diff 的基线恰恰是**最后一份快照**，
 * 不是 schema —— `20261002165919_perfect_scorpion`（#418）的快照丢了 `recommendation_request_items`
 * （#407 加的），于是 `db:generate` 把 `20261002123003_busy_lockheed` 的建表语句**字节等价**地又生成一遍
 * （sha256 `881f7730…`），随即被 #429 的簿记守卫拦下：本地 `db:generate → db:migrate → db:seed`
 * 全链路被 main 自己阻断。
 *
 * 只查单向（schema ⊆ 快照）：快照里有而 schema 里没有的表是**正常的**——迁移可以删表，
 * 那样 schema 与快照的差集本来就不为空（本仓库目前没有 `DROP TABLE`）。
 */
async function schemaTableNames(folder: string): Promise<string[]> {
  const names = new Set<string>()
  for (const file of await listFileNames(folder, '*.ts')) {
    if (file.endsWith('.test.ts')) continue
    const module = (await import(join(folder, file))) as Record<string, unknown>
    for (const value of Object.values(module)) {
      if (is(value, PgTable)) names.add(`public.${getTableName(value)}`)
    }
  }
  return [...names].sort()
}

/** 最新一份快照（journal 末条 tag 的**编号前缀**对应的 `meta/<前缀>_snapshot.json`）里的表键。 */
async function latestSnapshotTableNames(folder: string): Promise<string[]> {
  const journal = await readJson<Journal>(join(folder, metaFolderName, '_journal.json'))
  const latest = journal.entries.at(-1)
  if (latest === undefined) throw new Error('meta/_journal.json 没有任何条目')
  const prefix = /^(\d+)_/.exec(latest.tag)?.[1]
  if (prefix === undefined) throw new Error(`末条 tag \`${latest.tag}\` 没有编号前缀`)
  const snapshot = await readJson<{ tables: Record<string, unknown> }>(
    join(folder, metaFolderName, `${prefix}_snapshot.json`),
  )
  return Object.keys(snapshot.tables).sort()
}

/** 纯函数，便于在内存夹具上证明这条断言真的能红。 */
function snapshotCoverageViolations(schemaTables: string[], snapshotTables: string[]): string[] {
  const covered = new Set(snapshotTables)
  return schemaTables
    .filter((table) => !covered.has(table))
    .map(
      (table) =>
        `最新快照缺少 schema 里的表 \`${table}\`：快照已落后于 schema，\`db:generate\` 会把早已合过的迁移重新生成一遍（#439）`,
    )
}

test('#439 真实迁移目录：最新快照覆盖 schema 里的每一张表', async () => {
  const schemaTables = await schemaTableNames(join(import.meta.dir, 'schema'))
  const snapshotTables = await latestSnapshotTableNames(migrationsFolder)
  // 防夹具读空导致「空断言全绿」。
  expect(schemaTables.length).toBeGreaterThan(0)
  expect(snapshotTables.length).toBeGreaterThan(0)
  expect(snapshotCoverageViolations(schemaTables, snapshotTables)).toEqual([])
})

test('#439 #418 的形状：快照丢了前一条迁移新增的表必须报错', () => {
  const messages = snapshotCoverageViolations(
    ['public.listing_view_history', 'public.recommendation_request_items'],
    ['public.listing_view_history'],
  ).join('\n')
  expect(messages).toContain('`public.recommendation_request_items`')
  expect(messages).not.toContain('`public.listing_view_history`')
})
