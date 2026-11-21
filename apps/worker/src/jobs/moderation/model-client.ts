import type { ModerationReviewEnv } from '@fish/shared/env'

/**
 * 模型复核的上游调用（#751）。
 *
 * 形状照 `apps/api/src/modules/ai/provider.ts` 与 `apps/api/src/modules/auth/email-providers.ts`：
 * 裸 `fetch`、`AbortSignal.timeout`、**不重试**（重试交给 job 队列，避免一次审核里叠加重试把
 * 3 分钟预算耗光）、**绝不把上游响应体写进错误消息**——外部文本不可信，可能回显用户原文。
 *
 * 与润色的差别是这里要**多模态**：user 消息的 content 是一个分段数组，文本一段 + 每张图一段
 * （openai 兼容的 `image_url` 形状；data URL 直接内联，不依赖对象存储的公开可读性）。
 */
const TIMEOUT_MS = 25_000
const MAX_TOKENS = 600
/** 判定不需要创造力；给 0 又会让部分 relay 的采样参数校验报错，0.1 是折中。 */
const TEMPERATURE = 0.1

export type ModerationModelFailureReason =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'bad_payload'
  | 'empty_content'

export class ModerationModelError extends Error {
  constructor(
    readonly reason: ModerationModelFailureReason,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `模型复核调用失败（${reason}）`
        : `模型复核调用失败（${reason}, status=${status}）`,
    )
    this.name = 'ModerationModelError'
  }
}

export type ModerationModelResponse = {
  content: string
  promptTokens: number | null
  completionTokens: number | null
}

export type ModerationModelClient = {
  /** 上游模型名，落库用（换模型后旧记录仍能解释当时的行为）。 */
  readonly model: string
  review(input: {
    system: string
    text: string
    images: string[]
  }): Promise<ModerationModelResponse>
}

type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function readContent(payload: unknown): { content: string; finishReason: string | null } {
  if (typeof payload !== 'object' || payload === null) throw new ModerationModelError('bad_payload')
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ModerationModelError('bad_payload')
  }
  const first = choices[0]
  if (typeof first !== 'object' || first === null) throw new ModerationModelError('bad_payload')
  const { message, finish_reason: finishReason } = first as {
    message?: { content?: unknown }
    finish_reason?: unknown
  }
  const content = message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new ModerationModelError('empty_content')
  }
  return { content, finishReason: typeof finishReason === 'string' ? finishReason : null }
}

function readUsage(payload: unknown): {
  promptTokens: number | null
  completionTokens: number | null
} {
  if (typeof payload !== 'object' || payload === null) {
    return { promptTokens: null, completionTokens: null }
  }
  const usage = (payload as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) {
    return { promptTokens: null, completionTokens: null }
  }
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
  }
  return {
    promptTokens: typeof promptTokens === 'number' ? promptTokens : null,
    completionTokens: typeof completionTokens === 'number' ? completionTokens : null,
  }
}

export function createModerationModelClient(
  env: Extract<ModerationReviewEnv, { mode: 'shadow' | 'enforce' }>,
): ModerationModelClient {
  const endpoint = `${env.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    model: env.model,

    async review(input) {
      const parts: ChatContentPart[] = [{ type: 'text', text: input.text }]
      for (const url of input.images) parts.push({ type: 'image_url', image_url: { url } })

      const body = {
        model: env.model,
        messages: [
          { role: 'system', content: input.system },
          { role: 'user', content: parts },
        ],
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
      }

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        throw new ModerationModelError(isAbortError(error) ? 'timeout' : 'network')
      }

      if (!response.ok) throw new ModerationModelError('http_status', response.status)

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        throw new ModerationModelError('bad_payload')
      }

      const { content } = readContent(payload)
      const usage = readUsage(payload)
      return { content, ...usage }
    },
  }
}
