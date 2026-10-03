import { expect, test } from 'bun:test'

const repoRoot = Bun.fileURLToPath(new URL('../../../../../', import.meta.url))
type Event = {
  event: string
  rows?: { id: string; proposedExpectMatch: boolean; liveMatch: boolean }[]
  samples?: number
  liveAgreements?: number
  falsePositiveIds?: string[]
  falseNegativeIds?: string[]
  liveAgreementRate?: number
  liveAgreementRateAdjustable?: number
  distinctVectors?: number
  rowCount?: number
  index?: string
  plan?: string[]
  returned?: number
  recallAtK?: number
}

async function runScript(name: string, args: string[]) {
  const child = Bun.spawn(['bun', `apps/worker/scripts/${name}.ts`, ...args], {
    cwd: repoRoot,
    env: { ...process.env, NODE_ENV: 'test', EMBEDDING_TRANSPORT: 'stub' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const events = stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Event)
  return { code, stderr, events }
}

test('calibration 主报告保留全部 57 条并直接报告 FP/FN，不输出排除后的全对口径', async () => {
  const result = await runScript('embed-eval', ['--sections=calibration'])
  expect(result.code).toBe(0)
  const summary = result.events.find((event) => event.event === 'eval.calibration.summary')
  const rows = result.events.find((event) => event.event === 'eval.calibration.samples')?.rows
  if (!summary || !rows) throw new Error('缺少 calibration 结果')
  expect(summary.samples).toBe(57)
  expect(summary.falsePositiveIds).toEqual(
    rows.filter((row) => row.liveMatch && !row.proposedExpectMatch).map((row) => row.id),
  )
  expect(summary.falseNegativeIds).toEqual(
    rows.filter((row) => !row.liveMatch && row.proposedExpectMatch).map((row) => row.id),
  )
  expect(summary.liveAgreements).toBe(
    rows.filter((row) => row.liveMatch === row.proposedExpectMatch).length,
  )
  expect(summary.liveAgreementRateAdjustable).toBeUndefined()
})

test('新独立集不允许复用 H baseline，参数冲突必须在配置/DB/HTTP之前拒绝', async () => {
  const result = await runScript('embed-holdout', ['--independent', '--reuse-baseline'])
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('新独立集不能复用 H 组 baseline，未出网')
  expect(result.events).toHaveLength(0)
})

test('backfill 不接受删除旧模型向量的开关（包括 dry-run）', async () => {
  const result = await runScript('backfill-embeddings', ['--purge-other-models', '--dry-run'])
  expect(result.code).toBe(2)
  expect(result.stderr).toContain('未知参数')
  expect(result.events).toHaveLength(0)
})

test('ANN 有索引对照显式记录返回行数和 recall，不能只报延迟', async () => {
  const result = await runScript('ann-probe', [
    '--source=synthetic',
    '--sizes=60',
    '--queries=1',
    '--k=50',
  ])
  expect(result.code).toBe(0)
  const indexed = result.events.find(
    (event) => event.event === 'ann.probe.measured' && event.index === 'hnsw',
  )
  if (!indexed) throw new Error('缺少 indexed 测量')
  expect(indexed.plan?.[0]).toContain('rows=50')
  expect(indexed.returned).toBe(50)
  expect(typeof indexed.recallAtK).toBe('number')
})

test('ANN 合成向量逐行独立，两个递增档位都报告去重后的真实数量', async () => {
  const result = await runScript('ann-probe', [
    '--source=synthetic',
    '--sizes=10,20',
    '--queries=1',
    '--no-index',
  ])
  expect(result.code).toBe(0)
  const diversity = result.events.filter((event) => event.event === 'ann.probe.corpus')
  expect(diversity.map((row) => [row.rowCount, row.distinctVectors])).toEqual([
    [10, 10],
    [20, 20],
  ])
})
