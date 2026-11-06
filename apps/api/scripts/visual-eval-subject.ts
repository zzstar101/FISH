/**
 * #584 主体框检索的 **live 对比评测**：同一批查询图，分别按「整图」与「主体裁剪」向量化，
 * 在同一个商品库里排序，报 Recall@1 / Recall@K / MRR / NDCG@K 的差。
 *
 * ## 为什么不是 `visual:eval` / `visual:eval:db`
 *
 * - `visual:eval`（离线腿）的相似度是人工给定的，测不出"向量是从哪块像素来的"；
 * - `visual:eval:db` 默认 stub 向量（字节哈希铺开），同款不同图彼此正交，主体裁剪与否没有可比性。
 *
 * 本脚本只做一件事：用**真实上游**（向量化 + 解析各一个 live 模型）回答"先裁主体再搜，排得更准吗"。
 * 查询图走的是线上同一个函数 `analyzeQueryImage`（`../src/modules/visual-search/crop.ts`），
 * 所以量到的就是线上那条路；商品库按线上回填的口径**整图**向量化（回填本来就只看封面整图）。
 * 不连库、不连对象存储：排序用内存里的余弦相似度，召回下限与混合排序不参与（那两层与本票无关）。
 *
 * ## 不进 CI
 *
 * CI 不出网也没有密钥；数据集是本机文件（可能是真人拍的照片），**不进仓库**。
 *
 * ## 用法
 *
 * ```bash
 * VISUAL_EMBEDDING_TRANSPORT=live VISUAL_EMBEDDING_BASE_URL=… VISUAL_EMBEDDING_API_KEY=… VISUAL_EMBEDDING_MODEL=… \
 * VISUAL_PARSE_TRANSPORT=live VISUAL_PARSE_BASE_URL=… VISUAL_PARSE_API_KEY=… VISUAL_PARSE_MODEL=… \
 *   bun run apps/api/scripts/visual-eval-subject.ts --dataset=/path/to/dataset [--k=5]
 * ```
 *
 * 数据集目录下放 `manifest.json`（路径相对于该目录）：
 *
 * ```json
 * {
 *   "catalog": [{ "id": "imac-blue", "file": "catalog/imac-blue.jpg" }],
 *   "queries": [{ "file": "queries/q01.jpg", "relevant": ["imac-blue"] }]
 * }
 * ```
 *
 * 报告只打 id / 文件名与数字，不打解析出的文字（那是图里的内容）。
 */

import { join } from 'node:path'
import type { VisualImageMime } from '@fish/contracts/visual/provider'
import { loadVisualEmbeddingEnv, loadVisualParseEnv } from '@fish/shared/env'
import { sniffImageMime } from '@fish/shared/image-mime'
import { createVisualEmbeddingProvider } from '@fish/visual-embedding/providers/factory'
import { analyzeQueryImage } from '../src/modules/visual-search/crop'
import { mrr, ndcgAtK, recallAtK } from '../src/modules/visual-search/eval/metrics'
import { createVisualParser } from '../src/modules/visual-search/parse'

type Manifest = {
  catalog: Array<{ id: string; file: string }>
  queries: Array<{ file: string; relevant: string[] }>
}

type Scores = { recall1: number; recallK: number; mrr: number; ndcgK: number }

function argOf(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false
  const { catalog, queries } = value as Record<string, unknown>
  return (
    Array.isArray(catalog) &&
    catalog.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).file === 'string',
    ) &&
    Array.isArray(queries) &&
    queries.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).file === 'string' &&
        Array.isArray((item as Record<string, unknown>).relevant),
    )
  )
}

async function readImage(path: string): Promise<{ bytes: Uint8Array; mime: VisualImageMime }> {
  const bytes = await Bun.file(path).bytes()
  const mime = sniffImageMime(bytes)
  if (!mime) throw new Error(`不是 JPEG / PNG / WebP：${path}`)
  return { bytes, mime }
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1)
}

function rank(vector: readonly number[], catalog: ReadonlyMap<string, number[]>): string[] {
  return [...catalog]
    .map(([id, item]) => ({ id, similarity: cosine(vector, item) }))
    .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id))
    .map((entry) => entry.id)
}

function scoresOf(ranked: string[], relevant: readonly string[], k: number): Scores {
  const relevance = Object.fromEntries(relevant.map((id) => [id, 1 as const]))
  return {
    recall1: recallAtK(ranked, relevance, 1),
    recallK: recallAtK(ranked, relevance, k),
    mrr: mrr(ranked, relevance),
    ndcgK: ndcgAtK(ranked, relevance, k),
  }
}

function mean(rows: readonly Scores[]): Scores {
  const total = rows.reduce(
    (sum, row) => ({
      recall1: sum.recall1 + row.recall1,
      recallK: sum.recallK + row.recallK,
      mrr: sum.mrr + row.mrr,
      ndcgK: sum.ndcgK + row.ndcgK,
    }),
    { recall1: 0, recallK: 0, mrr: 0, ndcgK: 0 },
  )
  const count = Math.max(1, rows.length)
  return {
    recall1: total.recall1 / count,
    recallK: total.recallK / count,
    mrr: total.mrr / count,
    ndcgK: total.ndcgK / count,
  }
}

const fixed = (value: number) => value.toFixed(3)

async function main(): Promise<void> {
  const dataset = argOf('dataset')
  const k = Number(argOf('k') ?? 5)
  if (!dataset || !Number.isInteger(k) || k <= 0) {
    throw new Error(
      '用法：bun run apps/api/scripts/visual-eval-subject.ts --dataset=<目录> [--k=5]',
    )
  }

  const embeddingEnv = loadVisualEmbeddingEnv()
  const parseEnv = loadVisualParseEnv()
  // stub 向量 / 关掉的解析下"主体 vs 整图"没有可比性，跑出来的数字只会误导。
  if (embeddingEnv.transport !== 'live' || parseEnv.transport !== 'live') {
    throw new Error('本评测要求 VISUAL_EMBEDDING_TRANSPORT=live 且 VISUAL_PARSE_TRANSPORT=live')
  }
  const provider = createVisualEmbeddingProvider(embeddingEnv)
  const parser = createVisualParser(parseEnv)

  const manifest: unknown = await Bun.file(join(dataset, 'manifest.json')).json()
  if (!isManifest(manifest)) throw new Error('manifest.json 形状不对（见脚本头注释）')

  const catalog = new Map<string, number[]>()
  for (const item of manifest.catalog) {
    const { bytes, mime } = await readImage(join(dataset, item.file))
    catalog.set(item.id, await provider.embedImage(bytes, mime))
  }

  const whole: Scores[] = []
  const subject: Scores[] = []
  const analyzeMs: number[] = []
  let boxed = 0
  console.log(`| 查询图 | 有主体框 | 整图首位 | 主体首位 | 整图 RR | 主体 RR |`)
  console.log(`| --- | --- | --- | --- | --- | --- |`)
  for (const query of manifest.queries) {
    const { bytes, mime } = await readImage(join(dataset, query.file))
    const wholeVector = await provider.embedImage(bytes, mime)

    const startedAt = performance.now()
    const analyzed = await analyzeQueryImage(bytes, mime, parser)
    analyzeMs.push(performance.now() - startedAt)
    // 没检测到主体时线上就是整图检索：主体一栏照实记成与整图相同，而不是剔除这条样本。
    const subjectVector = analyzed.subjectBox
      ? await provider.embedImage(analyzed.image, analyzed.mime)
      : wholeVector
    if (analyzed.subjectBox) boxed += 1

    const wholeRanked = rank(wholeVector, catalog)
    const subjectRanked = rank(subjectVector, catalog)
    const wholeScores = scoresOf(wholeRanked, query.relevant, k)
    const subjectScores = scoresOf(subjectRanked, query.relevant, k)
    whole.push(wholeScores)
    subject.push(subjectScores)
    console.log(
      `| ${query.file} | ${analyzed.subjectBox ? '是' : '否'} | ${wholeRanked[0] ?? '-'} | ${subjectRanked[0] ?? '-'} | ${fixed(wholeScores.mrr)} | ${fixed(subjectScores.mrr)} |`,
    )
  }

  const wholeMean = mean(whole)
  const subjectMean = mean(subject)
  const sortedMs = [...analyzeMs].sort((left, right) => left - right)
  const median = sortedMs[Math.floor(sortedMs.length / 2)] ?? 0
  console.log('')
  console.log(
    `商品库 ${catalog.size} 件，查询 ${manifest.queries.length} 张，检出主体框 ${boxed} 张；` +
      `解析 + 裁剪耗时中位数 ${Math.round(median)} ms`,
  )
  console.log('')
  console.log(`| 口径 | Recall@1 | Recall@${k} | MRR | NDCG@${k} |`)
  console.log(`| --- | --- | --- | --- | --- |`)
  for (const [label, scores] of [
    ['整图', wholeMean],
    ['主体裁剪', subjectMean],
  ] as const) {
    console.log(
      `| ${label} | ${fixed(scores.recall1)} | ${fixed(scores.recallK)} | ${fixed(scores.mrr)} | ${fixed(scores.ndcgK)} |`,
    )
  }
}

await main()
