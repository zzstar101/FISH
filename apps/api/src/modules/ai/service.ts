import type { AiPolishCandidatesResponse, AiPolishErrorCode } from '@fish/contracts/ai/schema'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import { ListingDescriptionSchema } from '@fish/contracts/listings/schema'
import type { AiPolishEnv } from '@fish/shared/env'
import { createModerationService, type ModerationService } from '../moderation/service'
import { addsUnknownFacts } from './facts'
import { buildPolishPrompt, PROMPT_VERSION } from './prompt'
import { AiUpstreamError, type PolishCompletion, type PolishProvider } from './provider'
import { createRedactor } from './redact'
import type { AiPolishStore } from './store'

/**
 * 八步流水线（#141 设计 §5）：鉴权 → 配额占位 → 脱敏 → 调上游 → 解析 → 逐条过滤 → 逐条回填
 * → 落 outcome / 返回。**顺序即语义**，别在这里重排。
 *
 * 鉴权（第 1 步）由路由的 `requireAuth` 承担，service 只收已鉴权的 `userId`。
 */
export class AiPolishServiceError extends Error {
  constructor(
    readonly status: 429 | 502 | 503 | 504,
    /** 类型取自契约的错误码枚举，避免抛出的字面量与契约漂移（§13 的"错误码全落地"）。 */
    readonly code: AiPolishErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
  }
}

export type AiPolishServiceDeps = {
  store: AiPolishStore
  provider: PolishProvider
  env: AiPolishEnv
  /** 默认用 #74 的真实规则；测试注入假实现以构造 BLOCK/REVIEW 分支（同 listings/service.ts 的口径）。 */
  moderation?: ModerationService
}

export type AiPolishService = {
  polishCandidates(input: {
    userId: string
    title: string
    description: string
    category: ListingCategory
  }): Promise<AiPolishCandidatesResponse>
}

/** 模型名用于落表：stub 不是真模型，如实记为 `stub`，免得事后把它当成一次真实调用。 */
function modelFor(env: AiPolishEnv): string {
  return env.transport === 'live' ? env.model : 'stub'
}

/**
 * 运行期兜底：正常路径在装配层启动时就失败了（设计 §3.2），这里只是不把"配置缺失"误报成上游故障。
 */
function isConfigured(env: AiPolishEnv): boolean {
  if (env.baseUrl.trim().length === 0) return false
  if (env.transport === 'live') {
    return env.apiKey.trim().length > 0 && env.model.trim().length > 0
  }
  return true
}

/**
 * 字段名泄露（设计 §5.6b）：服务端硬校验，不能只靠 prompt——实测模型确实照抄过
 * "标题：/分类：/描述："（设计 §9 探针 2），脏候选会直接污染描述框。
 * 只看行首（允许前导空白与 `-` / `1.` 这类列表符号），避免误伤正文里正常提到"描述"二字。
 */
const FIELD_NAME_PREFIX =
  /^[\s\u3000]*(?:[-•*·]|\d{1,2}[.、)])?[\s\u3000]*(?:标题|分类|描述)[\s\u3000]*[:：]/

function hasFieldNamePrefix(text: string): boolean {
  return text.split('\n').some((line) => FIELD_NAME_PREFIX.test(line))
}

/** 两条错误码必须可区分：`UPSTREAM_ERROR` 是"我们或模型出了问题"，`EMPTY` 是"用户内容过不了关"。 */
function describeUpstreamFailure(error: unknown): {
  outcome: 'TIMEOUT' | 'UPSTREAM_ERROR'
  status: 502 | 504
  code: AiPolishErrorCode
  message: string
} {
  if (error instanceof AiUpstreamError && error.reason === 'timeout') {
    return { outcome: 'TIMEOUT', status: 504, code: 'AI_TIMEOUT', message: '润色超时，请稍后再试' }
  }
  if (error instanceof AiUpstreamError) {
    return {
      outcome: 'UPSTREAM_ERROR',
      status: 502,
      code: 'AI_UPSTREAM_ERROR',
      message: '润色服务暂时不可用，请稍后再试',
    }
  }
  // 未知异常交给 app.onError（500）。占位行的 outcome 保持 NULL——按 §5.2 的口径仍计入配额，
  // 不会变成"崩一次就白送一次额度"。
  throw error
}

export function createAiPolishService(deps: AiPolishServiceDeps): AiPolishService {
  const moderation = deps.moderation ?? createModerationService()

  const finish = (
    requestId: string,
    outcome: 'OK' | 'EMPTY' | 'UPSTREAM_ERROR' | 'TIMEOUT' | 'NOT_CONFIGURED' | 'TOKEN_LOST',
    candidateCount: number,
    filteredCount: number,
    latencyMs: number,
  ) => deps.store.finish({ requestId, outcome, candidateCount, filteredCount, latencyMs })

  return {
    async polishCandidates(input) {
      // 2 配额占位：通过检查后立刻落占位行，"上游失败也扣配额"由这一步保证。
      const reserved = await deps.store.reserve({
        userId: input.userId,
        inputChars: input.title.length + input.description.length,
        model: modelFor(deps.env),
        promptVersion: PROMPT_VERSION,
      })

      if (!reserved.allowed) {
        // 429 不复用 RATE_LIMITED：语义不同的拒绝共用一个码，客户端就给不出正确文案与倒计时。
        throw new AiPolishServiceError(
          429,
          'AI_POLISH_QUOTA',
          `润色太频繁，请 ${reserved.retryAfterSeconds} 秒后再试`,
          reserved.retryAfterSeconds,
        )
      }
      const { requestId } = reserved

      // 3 脱敏：只作用于送往上游的文本，映射只活在这个 Redactor 实例里。
      const redactor = createRedactor()
      const titleRedaction = redactor.redact(input.title)
      const descriptionRedaction = redactor.redact(input.description)
      const markedTitle = titleRedaction.text
      const markedDescription = descriptionRedaction.text

      if (!isConfigured(deps.env)) {
        await finish(requestId, 'NOT_CONFIGURED', 0, 0, 0)
        throw new AiPolishServiceError(503, 'AI_NOT_CONFIGURED', '润色功能暂未配置，请联系管理员')
      }

      // 4–5 调上游（8s、无重试）与解析（在 provider 内）。
      const startedAt = performance.now()
      let completion: PolishCompletion
      try {
        completion = await deps.provider.complete(
          buildPolishPrompt({
            title: markedTitle,
            description: markedDescription,
            category: input.category,
          }),
        )
      } catch (error) {
        const latencyMs = Math.round(performance.now() - startedAt)
        const failure = describeUpstreamFailure(error)
        await finish(requestId, failure.outcome, 0, 0, latencyMs)
        throw new AiPolishServiceError(failure.status, failure.code, failure.message)
      }
      const latencyMs = Math.round(performance.now() - startedAt)

      // 6 逐条过滤（丢弃即静默，只累计 filtered_count）+ 7 逐条回填。
      const kept: string[] = []
      let filteredCount = 0
      let tokenLost = false

      for (const segment of completion.segments) {
        // a 超长不截断（截断造半句话，买家会当事实读）；长度上限只在契约定义，这里直接复用契约校验。
        if (!ListingDescriptionSchema.safeParse(segment).success) {
          filteredCount += 1
          continue
        }
        if (hasFieldNamePrefix(segment)) {
          filteredCount += 1
          continue
        }
        // c 事实基线是**模型看到过的全部用户内容**（标题 + 描述）：只拿描述当基线，会在真实上游下
        // 把"引用标题里的型号"误判成新增事实（实测三条候选全丢 → EMPTY）。
        // 数字/单位比较前先摘掉标记：标记里的计数不是模型新增的数字（见 facts.ts）。
        if (addsUnknownFacts([input.title, input.description], segment)) {
          filteredCount += 1
          continue
        }
        // d 跑在**回填前的标记版**上：否则原文自带联系方式者，每条候选都会命中 EXTERNAL_CONTACT
        // → REVIEW，润色对这批用户永久返回空（设计 §5.6d）。BLOCK 与 REVIEW 都丢——REVIEW 会把
        // 商品硬推 OFFLINE，用户在发布页看不出掉线原因，比少一条候选糟得多。
        if (
          moderation.moderate({ title: markedTitle, description: segment }).decision !== 'ALLOW'
        ) {
          filteredCount += 1
          continue
        }

        // 回填只要求**描述那次脱敏**的标记齐全：候选是描述的改写，标题里的标记天然不会出现在
        // 这里（把它也算"丢失"会在标题含可脱敏内容时把用户自己的联系方式换成提示语）。
        const restored = redactor.restore(segment, descriptionRedaction)
        if (restored.lost) tokenLost = true
        // 提示语比标记长，回填后要再测一次长度（设计 §5.7）。
        if (!ListingDescriptionSchema.safeParse(restored.text).success) {
          filteredCount += 1
          continue
        }
        kept.push(restored.text)
      }

      // 8 收口：无论走哪条出口都必须回写 outcome 行。
      const outcome = kept.length === 0 ? 'EMPTY' : tokenLost ? 'TOKEN_LOST' : 'OK'
      await deps.store.finish({
        requestId,
        outcome,
        candidateCount: kept.length,
        filteredCount,
        latencyMs,
        ...(completion.usage.promptTokens === undefined
          ? {}
          : { promptTokens: completion.usage.promptTokens }),
        ...(completion.usage.completionTokens === undefined
          ? {}
          : { completionTokens: completion.usage.completionTokens }),
      })

      if (kept.length === 0) {
        throw new AiPolishServiceError(
          502,
          'AI_RESULT_EMPTY',
          '这次没有生成可用的文案，请换一种描述再试',
        )
      }

      return {
        provider: deps.provider.name,
        redacted: redactor.redacted,
        candidates: kept.map((text, index) => ({ id: `candidate-${index + 1}`, text })),
      }
    },
  }
}
