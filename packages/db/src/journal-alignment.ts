/**
 * `db:migrate` 的**簿记对齐**判据（#429）。
 *
 * ## 为什么需要它
 *
 * drizzle-orm 0.45 的 pg migrator **只按 `lastDbMigration.created_at < journal.when` 判重放，
 * 完全不比对 hash**（`drizzle-orm/pg-core/dialect.js` 的 `migrate()`）。所以只要库里的簿记
 * `created_at` 与 journal 的 `when` 顺序错位，一条**早已应用**的迁移就会被重放，并以一个
 * 看不懂的驱动错误收场（#401 实测：`enum label "LISTING" already exists`，42710；
 * 同类还有 `column "reply_to_id" already exists`，42701）。
 *
 * 现有门禁 `migrations-journal.test.ts`（#316）是**纯文件断言、不连库**，守的是三类**文件侧**
 * 事故（tag 撞车 / journal 丢条目 / `when` 乱序）。#401 的形状是**文件全对、库里的簿记错了**，
 * 文件侧怎么断都断不出来 —— 本模块补的就是库侧这半。
 *
 * ## 判据
 *
 * 水位取的是 **drizzle 眼里的水位**：它只读 `select … order by created_at desc limit 1` 的**首行**
 * （`drizzle-orm/pg-core/dialect.js` 的 `migrate()`），再按 `Number(created_at) < when` 判重放 ——
 * 不是 `max(created_at)`。因此：
 *
 * - **null-bookkeeping**：库内存在 `created_at IS NULL` 的行。`created_at` 是裸 `bigint`（无 NOT NULL），
 *   Postgres 在 `DESC` 下是 NULLS FIRST，首行就是它，`Number(null) = 0` ⇒ drizzle 的水位变成 0 ⇒
 *   **整份 journal 全部重放**。**阻断项**。
 * - **replay-hazard**：某条 journal 条目 `when > 水位`，但它的 hash **已在库内** —— 这就是 #401
 *   的形状，drizzle 下一步必然重放它。**阻断项**。
 * - **stale-row**：库内某行的 hash 不属于任何 journal 条目 —— 迁移文件被删/改名，而库里记着它。
 *   若它的 `created_at` **高于整份 journal 的每一条 `when`**，drizzle 的水位就高于每一条 ⇒
 *   从此**一条都不执行**（以后新增的迁移也永远不执行）。这一种**阻断**；其余只告警。
 * - **skipped-entry**：某条条目 `when <= 水位`，但 hash **不在**库内 —— 它已落在水位之下，
 *   drizzle **永远不会**再补它（静默漏迁移）。只告警。
 *
 * 只有上面点名的那几类阻断：它们要么让 migrate 崩得没有信息量，要么让 migrate **静默什么都不做**
 * （打印「完成」而新迁移一条都没跑）。skipped-entry 不阻断是为了**不误伤**
 * （尤其 #73 遗留库要走 `recognizeLegacyGovernance` 那条路径）。
 *
 * **hash 撞车（两条条目内容字节相同）不构成例外。** 曾考虑过把它降级为告警，理由是「库内那一行
 * 可能属于重复里的另一条，据 hash 拦截会误报」—— 这个理由站不住：重放与否由 drizzle 按
 * `when > watermark` 判定，**它根本不看 hash**，所以只要本条 `when` 高于水位就一定会被重放，
 * 与库内那行属于哪条无关。降级反而会把本票要消灭的 42710/42701 放回去。
 * 因此撞 hash 时**照常阻断**，只是额外在信息里点名「该 hash 在 journal 里出现 N 次」，
 * 免得动手的人按 hash 定位到错的条目。
 *
 * ## 修法指引自身有一处不对称（「抬水位」不是单向的修好）
 *
 * replay-hazard 的修法是把那行的 `created_at` 抬到 `when`，也就是**抬高水位**。但 drizzle 只执行
 * `when > 水位` 的条目，所以抬高水位会把 `(水位, 本条 when]` 之间**仍未应用**的条目一起沉到水位
 * 之下 —— 那是**永久**的静默漏迁移，而且由本模块自己的指引制造出来，比它要修的 42710 更难发现。
 *
 * 反例（#429 复审）：水位 100，`A`（when=120）未应用，`B`（when=150）已应用但簿记时间错位。
 * 按「把 B 改成 150」修完，水位跳到 150，`A` 从此永远不会执行。
 *
 * 因此 `formatJournalDrift` 对 replay-hazard **不直接给 UPDATE**：先只给只读诊断与两项前置检查
 * （`(水位, when]` 之间有无未应用条目；库内该 hash 是否只有一行），两项都过了才给可执行的语句。
 * 要改的是**指引文本**而不是阻断规则：`swallowedPending` 非空在 #401 式漂移后是常见形状
 * （只要待应用条目落在 hazard 的 `when` 之下才会危险），把它也当成阻断项会误伤正常库。
 *
 * ## 已知盲区（别把本模块当成「42710 全覆盖」）
 *
 * 若某条迁移的内容**已应用但库里根本没有它的行**（hash 不在库内）且 `when > watermark`，
 * 本模块**没有凭据可用**，drizzle 仍会重放它并抛出裸的 42710/42701 —— #401 修复过程中
 * `gray_triathlon` 就是这一种（列已存在、簿记无行）。这段盲区只能靠人核对 schema，
 * 或者让迁移 SQL 自身幂等（`IF NOT EXISTS`）；本模块**刻意不扩大判据**去猜。
 *
 * 推论：指引里**不能**把「hash 不在库内」写成「尚未应用」—— 那正好落在这段盲区里。而且
 * `packages/db/src/migrations/*.sql` 里**没有一条带 `BEGIN`/`COMMIT`**，`psql -f` 默认逐语句自动提交，
 * 照单重跑一条其实已应用的多语句迁移，会在报错之前把前半段**永久**写进库。所以指引要求先用只读
 * SQL / `\d` 核对 schema，并提示用 `psql -1`（单事务）执行。
 */

/** journal 条目里本模块需要的三个字段。 */
export type JournalEntryRef = { tag: string; when: number; hash: string }

/** `drizzle.__drizzle_migrations` 的一行；`createdAt` 为 `null` 表示该行 `created_at IS NULL`。 */
export type AppliedMigrationRow = { hash: string; createdAt: number | null }

export type JournalDrift =
  | {
      kind: 'null-bookkeeping'
      /** `created_at IS NULL` 的行数。 */
      nullRows: number
      /** journal 条目数（= 会被整份重放的迁移数）。 */
      journalEntries: number
    }
  | {
      kind: 'replay-hazard'
      tag: string
      when: number
      watermark: number
      hash: string
      /** 该 hash 在 journal 里出现的次数（>1 = 有内容重复的迁移，按 hash 定位时要留意）。 */
      hashEntries: number
      /** 库内该 hash 的行数（>1 = 一条 `WHERE hash = …` 会一次改掉多行簿记）。 */
      appliedRows: number
      /**
       * 若把水位抬到本条 `when`，会被**永久沉到水位之下**（drizzle 从此不再执行）的待应用条目。
       *
       * 非空 ⇒ 照旧「把 created_at 改成 when」的修法会亲手制造一次静默漏迁移，指引必须改为
       * 「先应用这些条目」。
       */
      swallowedPending: readonly SwallowedPendingEntry[]
    }
  | { kind: 'skipped-entry'; tag: string; when: number; watermark: number }
  | {
      kind: 'stale-row'
      hash: string
      createdAt: number
      /** `created_at` 高于整份 journal 的每一条 `when` ⇒ drizzle 从此一条都不执行。 */
      aboveJournal: boolean
    }

/** 会被抬高水位沉掉的待应用 journal 条目。 */
export type SwallowedPendingEntry = { tag: string; when: number }

/**
 * 逐条比对 journal 与库内簿记，返回全部漂移。
 *
 * **空库（库内一行都没有）返回空数组**：没有水位就谈不上「高于水位」，那是全新库而不是漂移。
 */
export function findJournalDrift(
  entries: readonly JournalEntryRef[],
  applied: readonly AppliedMigrationRow[],
): JournalDrift[] {
  if (applied.length === 0) return []

  // 水位必须与 drizzle 同构：它读的是 `order by created_at desc limit 1` 的**首行**，不是 max。
  // Postgres 在 DESC 下是 NULLS FIRST，只要库里有一行 `created_at IS NULL`，首行就是它，
  // `Number(null) = 0`，于是整份 journal 都会被重放 —— 而 `Math.max` 会忽略 NULL、报「无漂移」。
  const nullRows = applied.filter((row) => row.createdAt === null)
  if (nullRows.length > 0) {
    return [{ kind: 'null-bookkeeping', nullRows: nullRows.length, journalEntries: entries.length }]
  }
  const dated = applied.filter(
    (row): row is AppliedMigrationRow & { createdAt: number } => row.createdAt !== null,
  )

  const watermark = Math.max(...dated.map((row) => row.createdAt))
  const appliedHashes = new Set(dated.map((row) => row.hash))
  const journalHashes = new Set(entries.map((entry) => entry.hash))
  const maxJournalWhen = entries.reduce(
    (max, entry) => Math.max(max, entry.when),
    Number.NEGATIVE_INFINITY,
  )

  // 同一个 hash 出现在多条条目里时，光凭 hash 分不清库里的记录属于哪一条。
  const hashCounts = new Map<string, number>()
  for (const entry of entries) hashCounts.set(entry.hash, (hashCounts.get(entry.hash) ?? 0) + 1)
  // 库内同一 hash 的行数同理：>1 时按 hash 定位的 UPDATE 会一次改掉多行。
  const appliedCounts = new Map<string, number>()
  for (const row of dated) appliedCounts.set(row.hash, (appliedCounts.get(row.hash) ?? 0) + 1)

  const drift: JournalDrift[] = []
  for (const entry of entries) {
    if (entry.when > watermark) {
      if (appliedHashes.has(entry.hash)) {
        drift.push({
          kind: 'replay-hazard',
          tag: entry.tag,
          when: entry.when,
          watermark,
          hash: entry.hash,
          hashEntries: hashCounts.get(entry.hash) ?? 1,
          appliedRows: appliedCounts.get(entry.hash) ?? 0,
          // 抬水位前必须先看这一段：`when` 落在 (水位, 本条 when] 且库里没有记录的条目，
          // 一旦水位抬到本条 when 就会被永久跳过 —— 那正是本模块要防的静默漏迁移，
          // 不能由本模块自己的修法制造出来。
          swallowedPending: entries
            .filter(
              (other) =>
                other.when > watermark &&
                other.when <= entry.when &&
                !appliedHashes.has(other.hash),
            )
            .map((other) => ({ tag: other.tag, when: other.when })),
        })
      }
      continue
    }
    // `when <= watermark`：按序应用的话它一定已经落库；没落库说明被静默跳过。
    if (!appliedHashes.has(entry.hash)) {
      drift.push({ kind: 'skipped-entry', tag: entry.tag, when: entry.when, watermark })
    }
  }
  for (const row of dated) {
    if (!journalHashes.has(row.hash)) {
      drift.push({
        kind: 'stale-row',
        hash: row.hash,
        createdAt: row.createdAt,
        // 陈旧行的 created_at 高于整份 journal ⇒ drizzle 的水位高于每一条 when ⇒ 一条都不执行。
        // 这是迁移系统最静默的失败方式（打印「完成」而新迁移一条都没跑），必须阻断。
        aboveJournal: entries.length > 0 && row.createdAt > maxJournalWhen,
      })
    }
  }
  return drift
}

/**
 * 阻断项：null 簿记（水位被读成 0 ⇒ 整份重放）、replay-hazard（下一步必崩）、
 * 以及 created_at 高于整份 journal 的陈旧行（从此一条都不执行）。另几类只告警（理由见文件头）。
 */
export function blockingDrift(drift: readonly JournalDrift[]): JournalDrift[] {
  return drift.filter(
    (item) =>
      item.kind === 'null-bookkeeping' ||
      item.kind === 'replay-hazard' ||
      (item.kind === 'stale-row' && item.aboveJournal),
  )
}

/**
 * replay-hazard 的修法指引。
 *
 * **不能只给一条 UPDATE**：把 `created_at` 抬到 `when` 就是**抬高水位**，而 drizzle 只执行
 * `when > 水位` 的条目 —— 抬高水位会把 `(水位, 本条 when]` 之间**仍未应用**的条目一起沉到水位
 * 之下，那是**永久**的静默漏迁移（#429 复审的反例）。
 *
 * 所以先只给只读诊断 + 两项前置检查，两项都过了才给可执行的语句；任一项没过就明确写
 * 「不要执行任何 UPDATE」。只读 SQL 给**完整 hash**，让人能直接粘一条定位 SQL，
 * 而不是自己拼前缀匹配。
 */
function formatReplayHazard(item: Extract<JournalDrift, { kind: 'replay-hazard' }>): string[] {
  const lines = [
    `[db] 迁移簿记漂移：\`${item.tag}\`（when=${item.when}）高于库内水位 ${item.watermark}，` +
      `但它的内容早已应用（hash ${item.hash.slice(0, 12)}… 已在 drizzle.__drizzle_migrations）。`,
    '[db] drizzle 0.45 不比对 hash，只按水位判重放 —— 它会把这条迁移再跑一遍，' +
      '并以 42710/42701 这类「对象已存在」的驱动错误收场。',
    '[db] 先做只读诊断（下面两条都只读，不要照抄任何 UPDATE）：',
    `[db]   SELECT hash, created_at FROM drizzle.__drizzle_migrations WHERE hash = '${item.hash}';`,
    '[db]   SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 10;',
  ]

  if (item.swallowedPending.length > 0) {
    lines.push(
      `[db] 不要执行任何 UPDATE：把这条的 created_at 抬到 ${item.when} 会把水位抬到 ${item.when}，` +
        '而下面这些条目的 hash 不在库内、when 又不高于它 —— 水位一旦越过去，drizzle 永远不会再执行' +
        '它们（永久漏迁移）：',
      ...item.swallowedPending.map(
        (pending) => `[db]   - \`${pending.tag}\`（when=${pending.when}）`,
      ),
      '[db] 但「hash 不在库内」**不等于**「它们没应用过」：内容已应用、只是簿记缺行正是 issue #401 的' +
        '形状（`gray_triathlon`）。而这些 .sql 里没有任何 BEGIN/COMMIT，`psql -f` 默认逐语句自动' +
        '提交 —— 照单重跑一条其实已应用的多语句迁移，会在报错之前把前半段永久写进库。',
      '[db] 正确顺序：先用只读 SQL / `\\d` 逐条核对 schema 与迁移定义是否一致 → 只对确认未应用的' +
        '那几条执行（用 `psql -1` 或自带事务，避免半途落库）→ 再回来对齐本条簿记。',
    )
  }
  if (item.appliedRows !== 1) {
    lines.push(
      `[db] 不要执行任何 UPDATE：库内这个 hash 有 ${item.appliedRows} 行，` +
        '`WHERE hash = …` 会一次改掉多条簿记，而只凭 hash 无法区分它们。请逐行核对后手写条件。',
    )
  }

  if (item.swallowedPending.length === 0 && item.appliedRows === 1) {
    lines.push(
      '[db] 两项前置检查已通过：① journal 里 `(水位, when]` 之间没有未应用的条目；' +
        '② 库内这个 hash 只有 1 行（上面第一条 SELECT 会证实这一点）。',
      '[db] 与上面 SELECT 的结果核对无误后（先 pg_dump 备份，再逐条核对对象与迁移定义一致）可执行：',
      '[db]   UPDATE drizzle.__drizzle_migrations SET created_at = ' +
        `${item.when} WHERE hash = '${item.hash}';`,
      '[db] 若某条迁移的内容已应用但库里根本没有它的行，则补记一行 created_at = when' +
        '（见 issue #401 的修复记录）。',
    )
  }

  if (item.hashEntries > 1) {
    lines.push(
      `[db] 注意：这个 hash 在 journal 里出现 ${item.hashEntries} 次（有内容重复的迁移），` +
        '库内那一行未必属于本条 —— 但 drizzle 按水位判重放、**不看 hash**，' +
        '所以本条照样会被重放。定位时请一并核对这些重复条目。',
    )
  }
  return lines
}

/**
 * 把漂移渲染成一段能照着做的话。
 *
 * 失败信息是这条校验的全部价值所在：它替换掉的是一个没有信息量的驱动错误
 * （#401 里人只能看到 `enum label "LISTING" already exists`），所以必须点名
 * 「哪条迁移、水位多少、为什么会重放、改哪一行为什么值」。
 *
 * 但对 replay-hazard 有一处**刻意的不对称**：修法会抬高水位，因此可能顺带沉掉中间未应用的
 * 迁移 —— 指引改为「先只读诊断 → 两面前置检查 → 才给 UPDATE」，见 `formatReplayHazard`。
 *
 * `legacyPreMigrationWhen`：本库已判定为 #73 遗留库（`recognizeLegacyGovernance`）时，传入生成阶段
 * 首条迁移的 `when`。低于它的条目在遗留库里**本来**就没有簿记行，逐条喷「静默漏迁移」是假警报，
 * 会把真正的漂移埋掉 —— 那一段改成一条汇总提示。
 */
export function formatJournalDrift(
  drift: readonly JournalDrift[],
  options: { legacyPreMigrationWhen?: number } = {},
): string {
  const lines: string[] = []
  let legacySkipped = 0
  for (const item of drift) {
    if (item.kind === 'null-bookkeeping') {
      lines.push(
        `[db] 迁移簿记漂移：drizzle.__drizzle_migrations 里有 ${item.nullRows} 行 \`created_at IS NULL\`。`,
        '[db] drizzle 0.45 只把 `order by created_at desc limit 1` 的**首行**当水位，而 Postgres 在' +
          ' DESC 下是 NULLS FIRST —— 首行就是这些 NULL 行，`Number(null) = 0`，它眼里的水位是 0：',
        `[db] 整份 journal（${item.journalEntries} 条）会被**全部重放**，并以 42710/42701 这类` +
          '「对象已存在」的驱动错误收场。',
        '[db] 先只读确认：SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ' +
          'ORDER BY created_at DESC LIMIT 10;',
        '[db] 再修这些行（补上真实的 created_at，或确认多余后删除），然后重跑 `bun run db:migrate`。',
      )
    }
    if (item.kind === 'replay-hazard') {
      lines.push(...formatReplayHazard(item))
    }
    if (item.kind === 'skipped-entry') {
      if (
        options.legacyPreMigrationWhen !== undefined &&
        item.when < options.legacyPreMigrationWhen
      ) {
        legacySkipped += 1
        continue
      }
      lines.push(
        `[db] 告警：\`${item.tag}\`（when=${item.when}）已落在水位 ${item.watermark} 之下，` +
          '但库内没有它的记录 —— drizzle 不会再补这条迁移（静默漏迁移）。请人工核对。',
      )
    }
    if (item.kind === 'stale-row' && item.aboveJournal) {
      lines.push(
        `[db] 迁移簿记漂移：库内有一行 hash ${item.hash.slice(0, 12)}…（created_at=${item.createdAt}）` +
          '不属于任何 journal 条目，而它的 created_at **高于 journal 里每一条 when** ——' +
          'drizzle 的水位因此高于整份 journal，**从此一条迁移都不会执行**（以后新增的也一样），' +
          '而 `db:migrate` 仍会打印成功。',
        '[db] 先只读确认这行是否属于某个已删除/改名的迁移；确认后删除它，或把 created_at 改回真实值，' +
          '再重跑 `bun run db:migrate`。',
      )
    }
    if (item.kind === 'stale-row' && !item.aboveJournal) {
      lines.push(
        `[db] 告警：库内有一行 hash ${item.hash.slice(0, 12)}…（created_at=${item.createdAt}）` +
          '不属于任何 journal 条目 —— 迁移文件被删或改名了？请人工核对。',
      )
    }
  }
  if (legacySkipped > 0) {
    lines.push(
      `[db] 提示：本库是 #73 遗留库（走 recognizeLegacyGovernance），另有 ${legacySkipped} 条条目没有` +
        '簿记行 —— 那批迁移的内容由遗留路径建立，本来就不会有簿记行，不是漏迁移。',
    )
  }
  return lines.join('\n')
}
