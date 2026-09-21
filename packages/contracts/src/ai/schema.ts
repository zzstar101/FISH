import { z } from 'zod'
import {
  ListingCategorySchema,
  ListingDescriptionSchema,
  ListingTitleSchema,
} from '../listings/schema'

/**
 * AI 润色 Domain Contract（Issue #141，2026-09-21）。
 *
 * 端点的入参与出参**不存在**价格/成色/分类/0 元送的写回路径：候选只是文本草稿，结构化事实
 * 一律由用户在发布页自行确认（设计 §1）。协议细节见 `docs/design/issue-75-ai-polish.md`。
 */

/** 单次返回 1~3 条；"换一条"由客户端轮播，不重新请求上游（设计 §12-3）。 */
export const AI_POLISH_CANDIDATE_MIN = 1
export const AI_POLISH_CANDIDATE_MAX = 3

/**
 * `title` / `description` 复用商品域契约（长度上限只在契约定义，DB 侧是裸 `text`）。
 * `category` 只收枚举值——中文标签由服务端解析，不接受客户端传标签文本，
 * 堵住"伪造上下文诱导模型"的口子（设计 §4.1）。
 */
export const AiPolishCandidatesRequestSchema = z.strictObject({
  title: ListingTitleSchema,
  description: ListingDescriptionSchema,
  category: ListingCategorySchema,
})

export type AiPolishCandidatesRequest = z.infer<typeof AiPolishCandidatesRequestSchema>

/** `id` 只保证**每次响应内**稳定（客户端轮播与列表 key 用），不是数据库主键，不落库。 */
export const AiPolishCandidateSchema = z.object({ id: z.string(), text: z.string() })

export type AiPolishCandidate = z.infer<typeof AiPolishCandidateSchema>

/** 上游真伪：`stub` 时客户端必须显示"演示文案"角标（设计 §8.2）。 */
export const AiPolishProviderSchema = z.enum(['stub', 'live'])

export type AiPolishProvider = z.infer<typeof AiPolishProviderSchema>

export const AiPolishCandidatesResponseSchema = z.object({
  provider: AiPolishProviderSchema,
  /** 送上游前是否命中过脱敏规则；说明口径用，与候选文本是否含标记无关。 */
  redacted: z.boolean(),
  candidates: z
    .array(AiPolishCandidateSchema)
    .min(AI_POLISH_CANDIDATE_MIN)
    .max(AI_POLISH_CANDIDATE_MAX),
})

export type AiPolishCandidatesResponse = z.infer<typeof AiPolishCandidatesResponseSchema>

/**
 * 本模块的失败码。401 的 `UNAUTHENTICATED` 与 422 的 `VALIDATION_FAILED` 复用全仓既有码，
 * 不在这里重复定义（设计 §4.2）。
 */
export const AiPolishErrorCodeSchema = z.enum([
  /** 429：触发最小间隔（5s）或滚动 24h 配额（30 次）；带 `retryAfterSeconds`，不复用 `RATE_LIMITED`。 */
  'AI_POLISH_QUOTA',
  /** 503：`transport=live` 但配置不全（运行期兜底，正常应在启动即失败）。 */
  'AI_NOT_CONFIGURED',
  /** 504：上游超过 8s。 */
  'AI_TIMEOUT',
  /** 502：上游违约——`content` 为空、分段 <1、或 `finish_reason=length` 且无正文。 */
  'AI_UPSTREAM_ERROR',
  /** 502：上游正常返回，但候选被过滤层全部丢弃（对用户无损，不计配额）。 */
  'AI_RESULT_EMPTY',
])

export type AiPolishErrorCode = z.infer<typeof AiPolishErrorCodeSchema>
