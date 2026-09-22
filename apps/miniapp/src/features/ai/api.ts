/**
 * AI 润色 API（#141 后端能力 / #142 客户端接线）。
 *
 * 路径取自契约常量、响应用契约 schema 收口 —— 与其它 `features/<域>/api.ts` 同一形状。
 *
 * **mock 兜底的边界**（设计 §10.2 / §10.4）：只认显式的 `TARO_APP_MOCK=1` 构建
 * （`__DEMO_AI_POLISH__`，见 `config/index.ts`），且只覆盖**传输层失败**
 * （后端没起 / 断网）。服务端一旦给出错误信封（429 / 422 / 502 …），一律上抛走真实
 * 错误 UI —— 否则 429 会一边倒计时、一边在 sheet 里摆着本地假候选。
 */
import '@/lib/zod-jitless'
import { AI_ROUTES } from '@fish/contracts/ai/routes'
import {
  type AiPolishCandidatesRequest,
  type AiPolishCandidatesResponse,
  AiPolishCandidatesResponseSchema,
} from '@fish/contracts/ai/schema'
import { apiRequest, isApiError } from '@/lib/request'
import { polishCandidates } from '@/mock/sell'

/**
 * 构建期注入（`config/index.ts` 的 `defineConstants.__DEMO_AI_POLISH__`）。
 *
 * 与 `features/auth/demo.ts` 的 `__DEMO_AUTH__` 同形：`declare` 在使用处声明，
 * 不集中放 `types/global.d.ts`。
 */
declare const __DEMO_AI_POLISH__: boolean | undefined

const MOCK_FALLBACK_ENABLED = __DEMO_AI_POLISH__ === true

/**
 * 取润色候选。
 *
 * 失败语义：**原样上抛**（`ApiError` 或传输层异常），由页面决定怎么展示 ——
 * 这里不做「失败也返回空数组」这类吞掉错误的转换，那会让「上游挂了」在页面上
 * 表现成「模型没给出文案」。
 */
export async function fetchPolishCandidates(
  input: AiPolishCandidatesRequest,
): Promise<AiPolishCandidatesResponse> {
  const payload = await requestPolishCandidates(input)
  // 解析放在兜底的 try 之外：契约漂移不是「传输层失败」，演示构建也不该拿假候选盖住它。
  return AiPolishCandidatesResponseSchema.parse(payload)
}

async function requestPolishCandidates(input: AiPolishCandidatesRequest): Promise<unknown> {
  try {
    return await apiRequest(AI_ROUTES.polishCandidates, { method: 'POST', body: input })
  } catch (error) {
    // `isApiError` 为真 = 服务端给了信封（含 429 / 422 / 5xx 业务码）：照常上抛。
    if (!MOCK_FALLBACK_ENABLED || isApiError(error)) throw error
    return demoPolishResponse(input.description)
  }
}

/**
 * 演示构建的兜底响应：**形状与真实响应一致**（`provider: 'stub'`），
 * 所以页面只有一条渲染路径，sheet 头部的「演示文案·非真实模型」警告条也会照常出现。
 */
function demoPolishResponse(description: string): AiPolishCandidatesResponse {
  return { provider: 'stub', redacted: false, candidates: polishCandidates(description) }
}
