import { describe, expect, test } from 'bun:test'
import { ListingDescriptionSchema } from '@fish/contracts/listings/schema'
import type { AiPolishEnv } from '@fish/shared/env'
import type { ModerationResult } from '../moderation/types'
import { AiUpstreamError, type PolishProvider } from './provider'
import { AiPolishServiceError, createAiPolishService } from './service'
import type { AiPolishStore } from './store'

const STUB_ENV: AiPolishEnv = { transport: 'stub', baseUrl: 'http://stub.local' }

const INPUT = {
  userId: 'user-1',
  title: '罗技 K380 键盘',
  description: '九成新，自用一年，功能正常',
  category: 'DIGITAL',
} as const

type FinishCall = Parameters<AiPolishStore['finish']>[0]
type PromptCall = { system: string; user: string }

function createHarness(
  options: {
    segments?: string[]
    usage?: { promptTokens?: number; completionTokens?: number }
    error?: Error
    env?: AiPolishEnv
    reserveDenied?: number
    decision?: ModerationResult['decision']
  } = {},
) {
  const finishes: FinishCall[] = []
  const prompts: PromptCall[] = []
  let reserveCalls = 0

  // 假 store：配额口径由 store.test.ts 用真库覆盖（含并发），这里只关心 service 的分支。
  const store: AiPolishStore = {
    async reserve() {
      reserveCalls += 1
      if (options.reserveDenied !== undefined) {
        return { allowed: false, retryAfterSeconds: options.reserveDenied }
      }
      return { allowed: true, requestId: 'req-1' }
    },
    async finish(input) {
      finishes.push(input)
    },
  }

  const provider: PolishProvider = {
    name: (options.env ?? STUB_ENV).transport,
    async complete(prompt) {
      prompts.push(prompt)
      if (options.error) throw options.error
      return { segments: options.segments ?? [], usage: options.usage ?? {} }
    },
  }

  const decision = options.decision
  const service = createAiPolishService({
    store,
    provider,
    env: options.env ?? STUB_ENV,
    ...(decision === undefined
      ? {}
      : {
          moderation: {
            moderate: (): ModerationResult => ({
              decision,
              matches: [],
              reasonCode: null,
              ruleVersion: 'test',
            }),
          },
        }),
  })

  return { service, finishes, prompts, reserveCalls: () => reserveCalls }
}

async function captureError(run: () => Promise<unknown>): Promise<AiPolishServiceError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AiPolishServiceError) return error
    throw error
  }
  throw new Error('预期抛 AiPolishServiceError，但没有抛错')
}

describe('八步流水线', () => {
  test('正常路径：三条候选、provider 透出、指标与 outcome 回写', async () => {
    const harness = createHarness({
      segments: ['九成新键盘，功能一切正常', '自用一年，按键手感良好', '轻便好带，宿舍可用'],
      usage: { promptTokens: 120, completionTokens: 258 },
    })

    const response = await harness.service.polishCandidates(INPUT)

    expect(response.provider).toBe('stub')
    expect(response.redacted).toBe(false)
    expect(response.candidates.map((candidate) => candidate.id)).toEqual([
      'candidate-1',
      'candidate-2',
      'candidate-3',
    ])
    const [finish] = harness.finishes
    expect(harness.finishes).toHaveLength(1)
    expect(finish?.requestId).toBe('req-1')
    expect(finish?.outcome).toBe('OK')
    expect(finish?.candidateCount).toBe(3)
    expect(finish?.filteredCount).toBe(0)
    expect(finish?.promptTokens).toBe(120)
    expect(finish?.completionTokens).toBe(258)
    expect(typeof finish?.latencyMs).toBe('number')
  })

  test('脱敏发生在送上游之前，回填把原文还给用户', async () => {
    const harness = createHarness({ segments: ['九成新，联系 [fish-phone-1] 详聊'] })

    const response = await harness.service.polishCandidates({
      ...INPUT,
      description: '九成新，联系 13812345678 详聊',
    })

    // 送上游的是标记版：上游永远看不到手机号。
    expect(harness.prompts[0]?.user).toContain('[fish-phone-1]')
    expect(harness.prompts[0]?.user).not.toContain('13812345678')
    expect(response.redacted).toBe(true)
    // 回填后用户看到的仍是他自己的号码。
    expect(response.candidates[0]?.text).toBe('九成新，联系 13812345678 详聊')
  })

  test('标记被整段删掉 → 无处可插提示语，候选原样返回但 outcome 记 TOKEN_LOST', async () => {
    // §5.7 的"全部标记位换成提示语"只对**还在的**标记位成立：模型整段没写标记时，候选里没有
    // 可替换的位置，用户拿到的就是"没有联系方式"的那版草稿。§12-5 否掉的是"不可逆替换"
    // （模型根本没见过原文），不是模型自己选择不写。
    const harness = createHarness({ segments: ['九成新，看上的话私我'] })

    const response = await harness.service.polishCandidates({
      ...INPUT,
      description: '九成新，联系 13812345678',
    })

    expect(response.candidates[0]?.text).toBe('九成新，看上的话私我')
    expect(harness.finishes[0]?.outcome).toBe('TOKEN_LOST')
  })

  test('标记被模型改写（全角数字）→ 整条降级记 TOKEN_LOST，而不是被事实校验丢弃成 EMPTY', async () => {
    // 摘标记若只认标准形态，改写后的标记会把序号 `1` 泄漏成"模型新增的数字"，候选在事实过滤层
    // 就被丢掉，restore 的整条降级永远走不到（#141 审查发现）。
    const harness = createHarness({
      segments: ['九成新，联系 [fish-phone-１] 详聊'],
      decision: 'ALLOW',
    })

    const response = await harness.service.polishCandidates({
      ...INPUT,
      description: '九成新，联系 13812345678 详聊',
    })

    expect(response.candidates[0]?.text).toBe('九成新，联系 （你的联系方式已被移除） 详聊')
    expect(harness.finishes[0]?.outcome).toBe('TOKEN_LOST')
    expect(harness.finishes[0]?.filteredCount).toBe(0)
  })

  test('标题里也有敏感内容时，描述候选照样还原用户自己的联系方式（不误记 TOKEN_LOST）', async () => {
    // 真实上游踩过：标题含可脱敏内容时，若把标题的标记也算"必须找回"，用户自己的号码会被换成提示语。
    const harness = createHarness({ segments: ['九成新，联系 [fish-phone-1] 详聊'] })

    const response = await harness.service.polishCandidates({
      ...INPUT,
      title: '出 12号楼 的键盘',
      description: '九成新，联系 13812345678 详聊',
    })

    expect(response.candidates[0]?.text).toBe('九成新，联系 13812345678 详聊')
    expect(harness.finishes[0]?.outcome).toBe('OK')
  })

  test('超长候选被丢（不截断）；全被丢 → 502 AI_RESULT_EMPTY 且 outcome 记 EMPTY', async () => {
    const harness = createHarness({ segments: ['啊'.repeat(501)] })

    const error = await captureError(() => harness.service.polishCandidates(INPUT))

    expect(error.status).toBe(502)
    expect(error.code).toBe('AI_RESULT_EMPTY')
    expect(harness.finishes[0]?.outcome).toBe('EMPTY')
    expect(harness.finishes[0]?.filteredCount).toBe(1)
    expect(harness.finishes[0]?.candidateCount).toBe(0)
  })

  test('字段名泄露与新增数字都被丢', async () => {
    const harness = createHarness({
      segments: ['描述：九成新键盘', '九成新键盘，原价500元', '九成新键盘，功能正常'],
    })

    const response = await harness.service.polishCandidates(INPUT)

    expect(response.candidates).toHaveLength(1)
    expect(response.candidates[0]?.text).toBe('九成新键盘，功能正常')
    expect(harness.finishes[0]?.filteredCount).toBe(2)
  })

  test('字段名硬校验挡住 Markdown / 全角括号修饰的写法', async () => {
    // 模型加粗与标题都是最常见的输出形态；只认裸 `描述：` 等于把这道硬校验让给 prompt（#141 审查）。
    const harness = createHarness({
      segments: [
        '**描述：**九成新键盘',
        '### 描述：九成新键盘',
        '【标题】：出键盘',
        '> 描述：九成新键盘',
        '九成新键盘，功能正常',
      ],
    })

    const response = await harness.service.polishCandidates(INPUT)

    expect(response.candidates).toHaveLength(1)
    expect(response.candidates[0]?.text).toBe('九成新键盘，功能正常')
    expect(harness.finishes[0]?.filteredCount).toBe(4)
  })

  test('候选引用标题里的型号数字不算新增事实（真实上游踩过这条）', async () => {
    // 只拿描述当基线时，"罗技 K380 键盘" 里的 380 会被判为新增事实 → 三条候选全丢 → EMPTY。
    const harness = createHarness({ segments: ['罗技 K380 键盘，九成新，自用一年'] })

    const response = await harness.service.polishCandidates(INPUT)

    expect(response.candidates[0]?.text).toBe('罗技 K380 键盘，九成新，自用一年')
    expect(harness.finishes[0]?.outcome).toBe('OK')
  })

  test('moderation 判 BLOCK 或 REVIEW 都丢，且跑在回填前的标记版上', async () => {
    const harness = createHarness({ segments: ['九成新键盘'], decision: 'REVIEW' })

    const error = await captureError(() => harness.service.polishCandidates(INPUT))

    expect(error.code).toBe('AI_RESULT_EMPTY')
    expect(harness.finishes[0]?.outcome).toBe('EMPTY')
  })

  test('原文自带联系方式不会让候选全灭（moderation 跑标记版而非回填后全文）', async () => {
    // 若 moderation 跑在回填后的全文上，这里每条候选都会命中 EXTERNAL_CONTACT → REVIEW，
    // 润色对这批用户永久返回空（设计 §5.6d 的口径）。
    const harness = createHarness({ segments: ['九成新，[fish-contact-1] 详聊'] })

    const response = await harness.service.polishCandidates({
      ...INPUT,
      description: '九成新，微信号 abc_12345 详聊',
    })

    expect(response.candidates[0]?.text).toBe('九成新，微信号 abc_12345 详聊')
  })

  test('配额被拒：429 + retryAfterSeconds，不调上游、不写行', async () => {
    const harness = createHarness({ reserveDenied: 7 })

    const error = await captureError(() => harness.service.polishCandidates(INPUT))

    expect(error.status).toBe(429)
    expect(error.code).toBe('AI_POLISH_QUOTA')
    expect(error.retryAfterSeconds).toBe(7)
    expect(error.message).toContain('7 秒')
    expect(harness.prompts).toHaveLength(0)
    expect(harness.finishes).toHaveLength(0)
  })

  test('超时与上游违约可区分：AI_TIMEOUT / AI_UPSTREAM_ERROR，且分别落 TIMEOUT / UPSTREAM_ERROR', async () => {
    const timeoutHarness = createHarness({
      error: new AiUpstreamError('timeout'),
    })
    const timeoutError = await captureError(() => timeoutHarness.service.polishCandidates(INPUT))
    expect(timeoutError.status).toBe(504)
    expect(timeoutError.code).toBe('AI_TIMEOUT')
    expect(timeoutHarness.finishes[0]?.outcome).toBe('TIMEOUT')

    const upstreamHarness = createHarness({ error: new AiUpstreamError('http_status', 500) })
    const upstreamError = await captureError(() => upstreamHarness.service.polishCandidates(INPUT))
    expect(upstreamError.status).toBe(502)
    expect(upstreamError.code).toBe('AI_UPSTREAM_ERROR')
    expect(upstreamHarness.finishes[0]?.outcome).toBe('UPSTREAM_ERROR')

    // 两个码语义不同：一个是"我们或模型出了问题"，一个是"用户内容过不了关"。
    expect(upstreamError.code).not.toBe('AI_RESULT_EMPTY')
    expect(timeoutHarness.prompts).toHaveLength(1)
    expect(upstreamHarness.prompts).toHaveLength(1)
  })

  test('运行期配置缺失 → 503 AI_NOT_CONFIGURED（正常应在启动即失败）', async () => {
    const harness = createHarness({
      env: { transport: 'live', baseUrl: '', apiKey: '', model: '' },
    })

    const error = await captureError(() => harness.service.polishCandidates(INPUT))

    expect(error.status).toBe(503)
    expect(error.code).toBe('AI_NOT_CONFIGURED')
    expect(harness.finishes[0]?.outcome).toBe('NOT_CONFIGURED')
    expect(harness.prompts).toHaveLength(0)
  })

  test('回填后仍超长（还原出的原文比标记长）的候选被丢', async () => {
    // 标记版 ≤500 **不代表**回填后 ≤500：回填塞回去的是用户原文，39 字邮箱换掉 13 字
    // `[fish-mail-1]`。早先这条用例拿 495 字 + 14 字标记（509）来测，段落早在回填**前**就被
    // 长度层丢了，断言其实没走到这里（#141 二次审查发现）。
    const email = 'verylongemailaddressforfish@example.com'
    const filler = '啊'.repeat(480)
    const marked = `${filler}[fish-mail-1]`
    expect(ListingDescriptionSchema.safeParse(marked).success).toBe(true)

    const harness = createHarness({ segments: [marked] })

    const error = await captureError(() =>
      harness.service.polishCandidates({ ...INPUT, description: `${filler}${email}` }),
    )

    expect(ListingDescriptionSchema.safeParse(`${filler}${email}`).success).toBe(false)
    expect(error.code).toBe('AI_RESULT_EMPTY')
    expect(harness.finishes[0]?.filteredCount).toBe(1)
    expect(harness.finishes[0]?.outcome).toBe('EMPTY')
  })
})
