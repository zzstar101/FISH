/**
 * AI 润色的假模型服务（#141 设计 §8.1）。真 HTTP 服务，不是进程内桩——所以 `stub` 与 `live`
 * 走的是同一段 provider 代码，只有 base_url 不同。
 *
 * **必须故意返回脏数据**：三条候选里只有第一条干净，第二条超 500 字、第三条带原文没有的新数字。
 * 理想格式的 stub 会让脱敏回填 / 长度 / 数字三层过滤在 CI 里从未被执行过——"全绿骗人"。
 *
 * 本地联调（#142）：
 *   bun apps/api/scripts/ai-polish-stub.ts
 * `.env` 里配 `AI_POLISH_TRANSPORT=stub` + `AI_POLISH_BASE_URL=http://127.0.0.1:8787`。
 */
const STUB_PORT = 8787

/**
 * 超 500 字：长度过滤（不截断）必须丢掉它。
 *
 * 501 个「长」而不是重复一句中文：早先那条句子里的「五百」会被 `facts.ts` 归一化成事实令牌
 * `500`，且整句重复 20 次正好 500 字（`max(500)` 放行）——于是它实际是被**数字层**丢的，长度层
 * 在端到端里从未被执行，删掉长度过滤测试照样全绿（#141 二次审查发现）。现在这条候选不含任何
 * 数字 / 单位 / moderation 命中，唯一的丢弃理由就是长度。
 */
const LONG_CANDIDATE = '长'.repeat(501)

/** 原文没有的数字：事实校验必须丢掉它。 */
const INVENTED_NUMBER = '88888'

/** 第一条候选是唯一"干净"的那条，加个后缀让客户端看得出这是模型改写过的文本。 */
const CLEAN_SUFFIX = '，校内自提优先'

/**
 * 第一条候选拼后缀后必须仍 ≤500，否则描述 494~500 字时三条候选全被丢（另两条分别命中长度层与
 * 事实层），stub 下合法长描述恒返回 `AI_RESULT_EMPTY`，看起来像线上 bug（#141 三次审查发现）。
 * 拼不下就退回原文——stub 的第一条只要"干净"即可，不必非要与原文不同。
 */
function cleanCandidate(description: string): string {
  return description.length + CLEAN_SUFFIX.length <= 500
    ? `${description}${CLEAN_SUFFIX}`
    : description
}

export type StubChatRequest = { messages?: { role: string; content: string }[] }

export type AiPolishStub = {
  fetch(request: Request): Promise<Response>
  /** 收到的请求体，测试用来断言"送上游的文本已经脱敏"。 */
  received: StubChatRequest[]
}

export function createAiPolishStub(): AiPolishStub {
  const received: StubChatRequest[] = []

  return {
    received,

    async fetch(request) {
      const body = (await request.json().catch(() => null)) as StubChatRequest | null
      if (body) received.push(body)

      const user = body?.messages?.find((message) => message.role === 'user')?.content ?? ''
      const description = user.split('原始描述：').at(-1)?.trim() ?? user

      const content = [
        cleanCandidate(description),
        LONG_CANDIDATE,
        `${description}，原价 ${INVENTED_NUMBER} 元`,
      ].join('\n===\n')

      return Response.json({
        choices: [{ message: { content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 120, completion_tokens: 260 },
      })
    },
  }
}

if (import.meta.main) {
  const stub = createAiPolishStub()
  Bun.serve({ port: STUB_PORT, fetch: stub.fetch })
  console.log(
    `[ai-polish-stub] listening on http://127.0.0.1:${STUB_PORT}/chat/completions（返回演示文案，不是真实模型）`,
  )
}
