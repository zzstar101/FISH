import { AI_POLISH_CANDIDATE_MAX } from '@fish/contracts/ai/schema'
import type { AiPolishEnv } from '@fish/shared/env'

/**
 * 上游调用（#141 设计 §3.1 / §3.3 / §5.4 / §5.5）。
 *
 * 形状照 `apps/api/src/modules/auth/email-providers.ts`：裸 `fetch`（不加 SDK 依赖）、
 * `AbortSignal.timeout`、**不重试**、绝不把上游响应体写进错误消息——外部响应文本不可信，
 * 可能回显用户原文，而日志与错误响应都不该出现用户文本。
 *
 * stub 与 live 走**同一个实现**，只差配置与本地 stub 服务：少一条分支就少一处两者行为漂移
 * （设计 §3.3 的理由）。
 */
const TIMEOUT_MS = 8000
const MAX_TOKENS = 2000
const TEMPERATURE = 0.7
/** 实测该端点接受 `thinking:{type:'disabled'}` 且 1.3–2.4s 完成（设计 §9）。保留参数位便于换回显式思考。 */
const THINKING = { type: 'disabled' } as const

/** 只用 `[ \t]` 而不是 `\s`：`\s` 会吃掉换行，把上下两段候选粘在一起（`^`/`$` 在 /m 下按行匹配）。 */
const SEPARATOR_LINE = /^[ \t\u3000]*===[ \t\u3000]*$/m

export type UpstreamFailureReason =
  | 'timeout'
  | 'network'
  | 'http_status'
  | 'bad_payload'
  | 'empty_content'
  | 'truncated'
  | 'no_segments'

export class AiUpstreamError extends Error {
  constructor(
    readonly reason: UpstreamFailureReason,
    readonly status?: number,
  ) {
    super(
      status === undefined
        ? `AI 上游调用失败（${reason}）`
        : `AI 上游调用失败（${reason}, status=${status}）`,
    )
  }
}

export type PolishUsage = { promptTokens?: number; completionTokens?: number }

export type PolishCompletion = {
  /** 上游返回的候选分段（已剔除空段、最多 `AI_POLISH_CANDIDATE_MAX` 条）。 */
  segments: string[]
  usage: PolishUsage
}

export type PolishProvider = {
  /** 响应里的 `provider` 字段：让客户端能对 stub 显示"演示文案"角标（设计 §8.2）。 */
  readonly name: 'stub' | 'live'
  complete(prompt: { system: string; user: string }): Promise<PolishCompletion>
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function readContent(payload: unknown): { content: string; finishReason: string | null } {
  if (typeof payload !== 'object' || payload === null) throw new AiUpstreamError('bad_payload')
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) throw new AiUpstreamError('bad_payload')

  const first = choices[0]
  if (typeof first !== 'object' || first === null) throw new AiUpstreamError('bad_payload')
  const { message, finish_reason: finishReason } = first as {
    message?: { content?: unknown }
    finish_reason?: unknown
  }
  const content = message?.content
  const reason = typeof finishReason === 'string' ? finishReason : null

  if (typeof content !== 'string' || content.trim().length === 0) {
    // `finish_reason=length` 而无正文 = 想完了没写（实测过），与"返回了空正文"分开记，便于排障。
    throw new AiUpstreamError(reason === 'length' ? 'truncated' : 'empty_content')
  }
  return { content, finishReason: reason }
}

function splitSegments(content: string): string[] {
  const segments = content
    .split(SEPARATOR_LINE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (segments.length === 0) throw new AiUpstreamError('no_segments')
  return segments.slice(0, AI_POLISH_CANDIDATE_MAX)
}

function readUsage(payload: unknown): PolishUsage {
  if (typeof payload !== 'object' || payload === null) return {}
  const usage = (payload as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) return {}
  const { prompt_tokens: promptTokens, completion_tokens: completionTokens } = usage as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
  }
  return {
    ...(typeof promptTokens === 'number' ? { promptTokens } : {}),
    ...(typeof completionTokens === 'number' ? { completionTokens } : {}),
  }
}

export function createPolishProvider(env: AiPolishEnv): PolishProvider {
  const endpoint = `${env.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    name: env.transport,

    async complete(prompt) {
      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(env.transport === 'live' ? { authorization: `Bearer ${env.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: env.transport === 'live' ? env.model : 'stub',
            messages: [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user },
            ],
            max_tokens: MAX_TOKENS,
            temperature: TEMPERATURE,
            thinking: THINKING,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (error) {
        // 不重试（设计 §5.4）：重试会让"失败扣不扣配额"难以解释，用户再点一次"润色"就是天然重试。
        throw new AiUpstreamError(isAbortError(error) ? 'timeout' : 'network')
      }

      if (!response.ok) {
        await response.body?.cancel()
        throw new AiUpstreamError('http_status', response.status)
      }

      const payload: unknown = await response.json().catch(() => {
        throw new AiUpstreamError('bad_payload', response.status)
      })

      return {
        segments: splitSegments(readContent(payload).content),
        usage: readUsage(payload),
      }
    },
  }
}
