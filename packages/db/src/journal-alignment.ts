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
 * 令 `watermark = max(库内 created_at)`（drizzle 眼里「已应用到哪」的水位）：
 *
 * - **replay-hazard**：某条 journal 条目 `when > watermark`，但它的 hash **已在库内**
 *   —— 这就是 #401 的形状，drizzle 下一步必然重放它。**唯一阻断项**。
 * - **skipped-entry**：某条条目 `when <= watermark`，但 hash **不在**库内 —— 它已落在水位之下，
 *   drizzle **永远不会**再补它（静默漏迁移）。只告警。
 * - **stale-row**：库内某行的 hash 不属于任何 journal 条目 —— 迁移文件被删/改名，而库里记着它。
 *   只告警。
 *
 * 只有 replay-hazard 阻断：它当下就会让 migrate 崩且崩得没有信息量；另几类不阻断是为了**不误伤**
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
 */

/** journal 条目里本模块需要的三个字段。 */
export type JournalEntryRef = { tag: string; when: number; hash: string }

/** `drizzle.__drizzle_migrations` 的一行。 */
export type AppliedMigrationRow = { hash: string; createdAt: number }

export type JournalDrift =
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
  | { kind: 'stale-row'; hash: string; createdAt: number }

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

  const watermark = Math.max(...applied.map((row) => row.createdAt))
  const appliedHashes = new Set(applied.map((row) => row.hash))
  const journalHashes = new Set(entries.map((entry) => entry.hash))

  // 同一个 hash 出现在多条条目里时，光凭 hash 分不清库里的记录属于哪一条。
  const hashCounts = new Map<string, number>()
  for (const entry of entries) hashCounts.set(entry.hash, (hashCounts.get(entry.hash) ?? 0) + 1)
  // 库内同一 hash 的行数同理：>1 时按 hash 定位的 UPDATE 会一次改掉多行。
  const appliedCounts = new Map<string, number>()
  for (const row of applied) appliedCounts.set(row.hash, (appliedCounts.get(row.hash) ?? 0) + 1)

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
  for (const row of applied) {
    if (!journalHashes.has(row.hash)) {
      drift.push({ kind: 'stale-row', hash: row.hash, createdAt: row.createdAt })
    }
  }
  return drift
}

/** 只有 replay-hazard 阻断；另几类只告警（理由见文件头）。 */
export function blockingDrift(drift: readonly JournalDrift[]): JournalDrift[] {
  return drift.filter((item) => item.kind === 'replay-hazard')
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
        '而下面这些条目**尚未应用**且 when 不高于它 —— 水位一旦越过去，drizzle 永远不会再执行它们' +
        '（永久漏迁移）：',
      ...item.swallowedPending.map(
        (pending) => `[db]   - \`${pending.tag}\`（when=${pending.when}）`,
      ),
      '[db] 正确顺序：先按 when 升序把这些条目真正应用（每应用一条水位自然抬升），再回来对齐本条簿记。',
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
 */
export function formatJournalDrift(drift: readonly JournalDrift[]): string {
  const lines: string[] = []
  for (const item of drift) {
    if (item.kind === 'replay-hazard') {
      lines.push(...formatReplayHazard(item))
    }
    if (item.kind === 'skipped-entry') {
      lines.push(
        `[db] 告警：\`${item.tag}\`（when=${item.when}）已落在水位 ${item.watermark} 之下，` +
          '但库内没有它的记录 —— drizzle 不会再补这条迁移（静默漏迁移）。请人工核对。',
      )
    }
    if (item.kind === 'stale-row') {
      lines.push(
        `[db] 告警：库内有一行 hash ${item.hash.slice(0, 12)}…（created_at=${item.createdAt}）` +
          '不属于任何 journal 条目 —— 迁移文件被删或改名了？请人工核对。',
      )
    }
  }
  return lines.join('\n')
}
