// ---------------------------------------------------------------------------
// #694 M8 存量图片盘点 / 进度查看 CLI。
//
// 运行（仓库根目录，Bun 自动读根 `.env`）：
//   bun run legacy:media:inventory   # 只读扫描业务表，把未审对象登记进 legacy_media_audit_items
//   bun run legacy:media:status      # 只读汇总：状态 / 结论 / 来源 / 可见性分布
//   bun run legacy:media:retry-failed [--limit=100] [--before=2026-01-01T00:00:00Z]
//                                    # 把重试耗尽的 FAILED 重置为 PENDING，下一轮 worker 重新处理
//
// 盘点可重复执行：同一 object_key 只更新业务引用与可见性，不覆盖已有补审结论。
// retry-failed 用于修好上游配置（凭证 / 限流 / 网络）后重排历史失败；不指定 --before 时
// 重排所有 FAILED，指定时只重排 last_attempt_at 早于该时刻的行。
// ---------------------------------------------------------------------------

import { createDb } from '@fish/db/client'
import {
  listLegacyMediaAuditCandidates,
  requeueFailedLegacyMediaAudit,
  summarizeLegacyMediaInventory,
  syncLegacyMediaInventory,
} from '@fish/db/legacy-media-audit'

const USAGE = `用法：
  bun run legacy:media:inventory
  bun run legacy:media:status
  bun run legacy:media:retry-failed [--limit=100] [--before=2026-01-01T00:00:00Z]
`

const CLI_MODES = new Set(['inventory', 'status', 'retry-failed'])

function readOption(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`
  const hit = args.find((arg) => arg.startsWith(prefix))
  return hit === undefined ? null : hit.slice(prefix.length)
}

function readLimit(args: readonly string[]): number | undefined {
  const raw = readOption(args, 'limit')
  if (raw === null) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--limit 必须是正整数：${raw}`)
  }
  return value
}

function readBefore(args: readonly string[]): Date | null {
  const raw = readOption(args, 'before')
  if (raw === null) return null
  const value = new Date(raw)
  if (Number.isNaN(value.getTime())) {
    throw new Error(`--before 必须是 ISO 时间：${raw}`)
  }
  return value
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? ''
  if (!CLI_MODES.has(mode)) {
    console.error(USAGE)
    process.exit(1)
  }

  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('缺少 DATABASE_URL：先复制 .env.example 为 .env 并启动 Postgres')
  }
  const db = createDb(databaseUrl)

  try {
    if (mode === 'inventory') {
      const { scanned } = await syncLegacyMediaInventory(db)
      const summary = await summarizeLegacyMediaInventory(db)
      printJson({ scanned, summary })
      return
    }

    if (mode === 'retry-failed') {
      const args = process.argv.slice(3)
      const limit = readLimit(args)
      const before = readBefore(args)
      const result = await requeueFailedLegacyMediaAudit(db, { limit, before })
      printJson({
        requeued: result.requeued,
        limit: limit ?? 100,
        before: before === null ? null : before.toISOString(),
      })
      return
    }

    const summary = await summarizeLegacyMediaInventory(db)
    const pending = await listLegacyMediaAuditCandidates(db, { limit: 100 })
    printJson({
      summary,
      pendingSample: pending,
      note: 'pendingSample 只取前 100 条；完整进度按 summary.byStatus / byDecision 看。',
    })
  } finally {
    await db.$client.close()
  }
}

await main()
