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

/** 超 500 字：长度过滤（不截断）必须丢掉它。 */
const LONG_CANDIDATE = '这条候选故意超过五百字，用来验证长度过滤真的在跑。'.repeat(20)

/** 原文没有的数字：事实校验必须丢掉它。 */
const INVENTED_NUMBER = '88888'

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
        `${description}，校内自提优先`,
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
