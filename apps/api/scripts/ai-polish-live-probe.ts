/**
 * 真实上游探针（#141）：把「模型返回了什么」与「四层过滤各自怎么判的」逐条打出来。
 *
 * 用途：设计 §0-2 的质量验收（`thinking` 开/关、`temperature=0.7` 的文案质量）与 §11-R4 的
 * 误杀率观察——只看接口返回的候选数看不出是"模型没写"还是"被我们丢了"。
 *
 * 用法（默认 stub 配置不出网；跑真实上游时用环境变量覆盖两项，key 留在 .env 里不落命令行）：
 *   AI_POLISH_TRANSPORT=live AI_POLISH_BASE_URL=https://api.deepseek.com \
 *     bun --env-file=.env apps/api/scripts/ai-polish-live-probe.ts [descriptions.jsonl]
 *
 * JSONL 每行 `{"title":"...","description":"...","category":"DIGITAL"}`；不给文件则跑内置样例。
 * 注意：每次调用都是真实计费请求，且受接口 5s/30 次日配额约束（这里绕过 HTTP 直连 provider，
 * 不占配额、不落表）。
 *
 * ⚠️ 本脚本会把**原文事实与上游返回的候选正文**打到 stdout，是 §11-R4/R5 观测丢弃原因的唯一手段。
 * 因此**只喂构造样例**（默认 SAMPLES 就是），不要把真实用户描述当输入——服务端的红线是"日志里
 * 不出现用户文本"，这里靠使用者自律，脚本本身不脱敏输出。
 */

import type { ListingCategory } from '@fish/contracts/listings/schema'
import { ListingDescriptionSchema } from '@fish/contracts/listings/schema'
import { loadAiPolishEnv } from '@fish/shared/env'
import { extractFacts } from '../src/modules/ai/facts'
import { buildPolishPrompt } from '../src/modules/ai/prompt'
import { createPolishProvider } from '../src/modules/ai/provider'
import { createRedactor } from '../src/modules/ai/redact'
import { hasFieldNamePrefix } from '../src/modules/ai/service'
import { moderateListingContent } from '../src/modules/moderation/rules'

type Sample = { title: string; description: string; category: ListingCategory }

const SAMPLES: Sample[] = [
  {
    title: '罗技 K380 蓝牙键盘',
    description:
      '九成新，自用一学期，功能一切正常，键帽无油光。原装电池换过一次，包装盒和说明书都在。校内自提，联系 13812345678。',
    category: 'DIGITAL',
  },
]

async function loadSamples(): Promise<Sample[]> {
  const path = Bun.argv[2]
  if (!path) return SAMPLES

  const text = await Bun.file(path).text()
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Sample)
}

const env = loadAiPolishEnv()
const provider = createPolishProvider(env)
const samples = await loadSamples()

console.log(`[probe] transport=${env.transport} 样例数=${samples.length}`)
console.warn('[probe] 本脚本会把原文事实与候选正文打到终端：只喂构造样例，不要用真实用户描述')

for (const [index, input] of samples.entries()) {
  const redactor = createRedactor()
  const markedTitle = redactor.redact(input.title).text
  const markedDescription = redactor.redact(input.description).text
  // 事实基线 = 模型看到过的全部用户内容（标题 + 描述），与 service 的口径一致。
  const baseline = [input.title, input.description]
  const knownFacts = [...new Set(baseline.flatMap((source) => [...extractFacts(source)]))]

  console.log(`\n========== 样例 ${index + 1}：${input.title} ==========`)
  console.log(`[原文事实] ${JSON.stringify(knownFacts)}`)

  const startedAt = performance.now()
  let completion: Awaited<ReturnType<typeof provider.complete>>
  try {
    completion = await provider.complete(
      buildPolishPrompt({
        title: markedTitle,
        description: markedDescription,
        category: input.category,
      }),
    )
  } catch (error) {
    console.log(`[上游失败] ${error instanceof Error ? error.name : 'unknown'}: ${String(error)}`)
    continue
  }
  const latencyMs = Math.round(performance.now() - startedAt)

  let kept = 0
  for (const [candidateIndex, segment] of completion.segments.entries()) {
    const tooLong = !ListingDescriptionSchema.safeParse(segment).success
    const fieldName = hasFieldNamePrefix(segment)
    const newFacts = [...extractFacts(segment)].filter((token) => !knownFacts.includes(token))
    const moderation = moderateListingContent({ title: markedTitle, description: segment })
    const dropped = tooLong || fieldName || newFacts.length > 0 || moderation.decision !== 'ALLOW'
    if (!dropped) kept += 1

    console.log(`\n----- 候选 ${candidateIndex + 1}${dropped ? '（丢弃）' : '（保留）'} -----`)
    console.log(segment)
    console.log(
      `[判定] 长度=${tooLong ? 'DROP' : 'ok'}(${segment.trim().length}字) 字段名=${fieldName ? 'DROP' : 'ok'} ` +
        `事实=${newFacts.length > 0 ? `DROP ${JSON.stringify(newFacts)}` : 'ok'} moderation=${moderation.decision}`,
    )
  }

  console.log(
    `\n[样例汇总] 上游返回 ${completion.segments.length} 段 → 保留 ${kept} 条 / 丢 ${completion.segments.length - kept} 条` +
      `，延迟 ${latencyMs}ms，tokens ${completion.usage.promptTokens ?? '?'}/${completion.usage.completionTokens ?? '?'}`,
  )
}
