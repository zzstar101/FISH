import { expect, test } from 'bun:test'
import {
  blockingDrift,
  findJournalDrift,
  formatJournalDrift,
  type JournalEntryRef,
} from './journal-alignment'

function entry(tag: string, when: number, hash: string): JournalEntryRef {
  return { tag, when, hash }
}

/** 造一条 64 位假 hash，便于按前缀断言。 */
function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64)
}

test('#429 对齐的库：零漂移', () => {
  const drift = findJournalDrift(
    [entry('0001_a', 100, hash('a')), entry('0002_b', 200, hash('b'))],
    [
      { hash: hash('a'), createdAt: 100 },
      { hash: hash('b'), createdAt: 200 },
    ],
  )
  expect(drift).toEqual([])
})

test('#429 全新空库不算漂移（没有水位就谈不上「高于水位」）', () => {
  expect(findJournalDrift([entry('0001_a', 100, hash('a'))], [])).toEqual([])
})

test('#429 #401 的形状：when 高于水位但内容早已应用 → replay-hazard，且是唯一阻断项', () => {
  // 复刻 #401：`parched_emma_frost`（when=300）早已应用，但其 created_at(100) 小于
  // 后合入的 `mighty_madame_web`(200)，水位因此停在 200 → drizzle 会重放 when=300 那条。
  const drift = findJournalDrift(
    [entry('0001_mighty', 200, hash('a')), entry('0002_parched', 300, hash('b'))],
    [
      { hash: hash('a'), createdAt: 200 },
      { hash: hash('b'), createdAt: 100 },
    ],
  )

  expect(drift).toEqual([
    {
      kind: 'replay-hazard',
      tag: '0002_parched',
      when: 300,
      watermark: 200,
      hash: hash('b'),
      hashEntries: 1,
      appliedRows: 1,
      swallowedPending: [],
    },
  ])
  expect(blockingDrift(drift)).toHaveLength(1)
})

test('#429 水位之下缺条目 → skipped-entry（静默漏迁移），只告警不阻断', () => {
  const drift = findJournalDrift(
    [
      entry('0001_a', 100, hash('a')),
      entry('0002_b', 200, hash('b')),
      entry('0003_c', 300, hash('c')),
    ],
    [
      { hash: hash('a'), createdAt: 100 },
      { hash: hash('c'), createdAt: 300 },
    ],
  )

  expect(drift).toEqual([{ kind: 'skipped-entry', tag: '0002_b', when: 200, watermark: 300 }])
  expect(blockingDrift(drift)).toEqual([])
})

test('#429 库内有 journal 不认识的 hash → stale-row，只告警不阻断', () => {
  const drift = findJournalDrift(
    [entry('0001_a', 100, hash('a'))],
    [
      { hash: hash('a'), createdAt: 100 },
      { hash: hash('z'), createdAt: 50 },
    ],
  )

  expect(drift).toEqual([{ kind: 'stale-row', hash: hash('z'), createdAt: 50 }])
  expect(blockingDrift(drift)).toEqual([])
})

test('#429 失败信息点名 tag / 水位 / hash 前缀 / 修法，而不是一句 assert failed', () => {
  const text = formatJournalDrift([
    {
      kind: 'replay-hazard',
      tag: '0002_parched',
      when: 300,
      watermark: 200,
      hash: hash('b'),
      hashEntries: 1,
      appliedRows: 1,
      swallowedPending: [],
    },
  ])

  expect(text).toContain('0002_parched')
  expect(text).toContain('when=300')
  expect(text).toContain('200')
  expect(text).toContain(hash('b').slice(0, 12))
  expect(text).toContain('42710')
  expect(text).toContain('pg_dump')
  expect(text).toContain('created_at')
})

test('#429 告警类也会被渲染出来（不能静默吞掉）', () => {
  const text = formatJournalDrift([
    { kind: 'skipped-entry', tag: '0002_b', when: 200, watermark: 300 },
    { kind: 'stale-row', hash: hash('z'), createdAt: 50 },
  ])

  expect(text).toContain('0002_b')
  expect(text).toContain('静默漏迁移')
  expect(text).toContain(hash('z').slice(0, 12))
})

test('#429 hash 撞车不构成例外：内容重复的条目高于水位时照常阻断，只是点名重复次数', () => {
  // 曾想把它降级为告警（理由：库内那行未必属于本条）。但 drizzle 按 `when > watermark`
  // 判重放、**根本不看 hash**，所以本条照样会被重放 —— 降级等于把 42710/42701 放回去。
  const drift = findJournalDrift(
    [entry('0001_a', 200, hash('a')), entry('0002_b', 300, hash('a'))],
    [{ hash: hash('a'), createdAt: 200 }],
  )

  expect(drift).toEqual([
    {
      kind: 'replay-hazard',
      tag: '0002_b',
      when: 300,
      watermark: 200,
      hash: hash('a'),
      hashEntries: 2,
      appliedRows: 1,
      swallowedPending: [],
    },
  ])
  expect(blockingDrift(drift)).toHaveLength(1)

  const text = formatJournalDrift(drift)
  expect(text).toContain('出现 2 次')
  expect(text).toContain('不看 hash')
})

test('#429 撞 hash 但两条都已落在水位之下 → 零漂移', () => {
  const drift = findJournalDrift(
    [entry('0001_a', 200, hash('a')), entry('0002_b', 300, hash('a'))],
    [
      { hash: hash('a'), createdAt: 200 },
      { hash: hash('a'), createdAt: 300 },
    ],
  )
  expect(drift).toEqual([])
})

test('#429 两项前置检查都通过时才给出可执行的 UPDATE（并保留只读核对）', () => {
  // 水位 100；只有 `0002_b`（when=200）高于水位且已应用（簿记时间错位）——
  // `(水位, 200]` 之间没有待应用条目，库内该 hash 也只有一行。
  const drift = findJournalDrift(
    [entry('0001_a', 100, hash('a')), entry('0002_b', 200, hash('b'))],
    [
      { hash: hash('a'), createdAt: 100 },
      { hash: hash('b'), createdAt: 50 },
    ],
  )
  const hazard = drift[0]
  if (hazard?.kind !== 'replay-hazard') throw new Error('应判为 replay-hazard')
  expect(hazard.swallowedPending).toEqual([])
  expect(hazard.appliedRows).toBe(1)

  const text = formatJournalDrift(drift)
  // 只读定位 SQL 给**完整 hash**，让人能直接粘而不是自己拼前缀匹配。
  expect(text).toContain(
    `SELECT hash, created_at FROM drizzle.__drizzle_migrations WHERE hash = '${hash('b')}';`,
  )
  expect(text).toContain('UPDATE drizzle.__drizzle_migrations SET created_at = 200')
})

test('#429 复审反例：抬水位会沉掉中间未应用的迁移 → 指引不得给出任何 UPDATE', () => {
  // 水位 100；`0002_b`（when=120）还没应用；`0003_c`（when=150）早已应用、簿记停在 100。
  // 按旧指引把 c 的 created_at 改成 150 ⇒ 水位跳到 150 ⇒ b 从此永远不会执行（永久漏迁移）。
  const entries = [
    entry('0001_a', 100, hash('a')),
    entry('0002_b', 120, hash('b')),
    entry('0003_c', 150, hash('c')),
  ]
  const drift = findJournalDrift(entries, [
    { hash: hash('a'), createdAt: 100 },
    { hash: hash('c'), createdAt: 100 },
  ])

  const hazard = drift[0]
  if (hazard?.kind !== 'replay-hazard') throw new Error('应判为 replay-hazard')
  expect(hazard.tag).toBe('0003_c')
  expect(hazard.swallowedPending).toEqual([{ tag: '0002_b', when: 120 }])

  const text = formatJournalDrift(drift)
  // 既要点名会被沉掉的是哪条，也不能出现任何可照抄的 UPDATE。
  expect(text).toContain('0002_b')
  expect(text).toContain('when=120')
  expect(text).not.toContain('UPDATE drizzle.__drizzle_migrations')
  // 该告警仍然阻断：drizzle 下一步必然重放 0003_c。
  expect(blockingDrift(drift)).toHaveLength(1)
})

test('#429 库内同 hash 多行时不得给出按 hash 定位的 UPDATE', () => {
  // `WHERE hash = …` 会一次改掉两行簿记，而只凭 hash 分不清哪一行属于本条。
  const drift = findJournalDrift(
    [entry('0001_a', 100, hash('a')), entry('0002_b', 200, hash('b'))],
    [
      { hash: hash('a'), createdAt: 100 },
      { hash: hash('b'), createdAt: 50 },
      { hash: hash('b'), createdAt: 60 },
    ],
  )

  const hazard = drift[0]
  if (hazard?.kind !== 'replay-hazard') throw new Error('应判为 replay-hazard')
  expect(hazard.appliedRows).toBe(2)

  const text = formatJournalDrift(drift)
  expect(text).not.toContain('UPDATE drizzle.__drizzle_migrations')
  expect(text).toContain('有 2 行')
})
