import { ListingCategorySchema } from '@fish/contracts/listings/schema'
import type { VisualImageMime } from '@fish/contracts/visual/provider'
import {
  type VisualInterpretation,
  VisualInterpretationSchema,
} from '@fish/contracts/visual/schema'
import type { VisualParseEnv } from '@fish/shared/env'

/**
 * 查询图的语义解析（#324 M5，OCR/VLM）。
 *
 * 走 OpenAI 兼容的 `chat/completions`（百炼为 `https://dashscope.aliyuncs.com/compatible-mode/v1`），
 * 要求模型只回一个严格 JSON 对象，再用 `VisualInterpretationSchema` 校验——**解析结果是不可信输入**，
 * 模型可能多回字段、回空串、回不在枚举里的分类。
 *
 * ## 失败一律 fail-open（返回 null），绝不抛
 *
 * 解析是**可选增强**：它能给文本路召回提供关键词，但拍照识图的本体是图片向量。
 * 如果解析失败就让整次搜索 5xx，等于用"一个附加信号"否决了主链路——
 * 上游一抖动，整个拍照搜图功能全挂。这与向量化的失败处理**方向相反**（那个必须 fail-closed），
 * 因为向量是结果的前提，解析只是加分项。
 *
 * ## 日志里绝不出现模型输出
 *
 * 模型回的内容是从用户图片里读出来的（OCR 文本、型号），属于用户数据。
 * 失败时只记**校验错误的形状**，不记 content，也不记图片字节。
 */

/** 解析调用的超时。比向量化宽松：一次 VLM 生成比一次 embedding 慢。 */
export const VISUAL_PARSE_TIMEOUT_MS = 15_000

/** 生成的 token 上限。解析结果是一小段 JSON，给多了只会让模型话多。 */
export const VISUAL_PARSE_MAX_TOKENS = 512

/** 文本路查询串的长度上限：超过这个长度的"关键词"对检索没有帮助，只会推高一次上游调用。 */
export const VISUAL_TEXT_QUERY_MAX_LENGTH = 400

export type VisualParser = {
  /** 解析失败/未启用返回 `null`（调用方据此退化为纯视觉排序）。 */
  parse(image: Uint8Array, mime: VisualImageMime): Promise<VisualInterpretation | null>
}

const CATEGORY_VALUES: readonly string[] = ListingCategorySchema.options

const PROMPT = `你是二手交易平台的图像理解组件。看这张用户拍摄的照片，输出一个 JSON 对象，字段如下：
- "text": 图中清晰可读的文字（书名、型号、品牌标签等），没有则省略
- "category": 商品分类，只能是这些值之一：${CATEGORY_VALUES.join(', ')}；判断不了则省略
- "brand": 品牌名，没有则省略
- "model": 型号，没有则省略
- "keywords": 3 到 8 个用于检索的中文关键词数组
只输出 JSON，不要解释，不要 markdown 代码块。无法识别的字段直接省略，不要编造。`

/**
 * 把解析结果压成一次文本查询。
 *
 * 顺序是刻意的：型号/品牌这类**判别性最强**的词放前面，OCR 全文放最后——
 * 多模态 embedding 的输入长度有限，被截断时应当丢掉最冗长的部分而不是最关键的标识。
 */
export function visualTextQueryOf(interpretation: VisualInterpretation | null): string | null {
  if (!interpretation) return null
  const parts = [
    interpretation.model,
    interpretation.brand,
    ...(interpretation.keywords ?? []),
    interpretation.text,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0)

  if (parts.length === 0) return null
  const query = parts.join(' ').trim().slice(0, VISUAL_TEXT_QUERY_MAX_LENGTH)
  return query.length > 0 ? query : null
}

function readMessageContent(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (typeof first !== 'object' || first === null) return null
  const message = (first as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : null
}

/**
 * 上游已知的**包装差异**：百炼 `qwen3-vl-plus` 在 `response_format: json_object` 下会把
 * `text` 回成字符串**数组**（实测 `["EPSON","GD-420S","MADE IN TAIWAN"]`），
 * 而契约里 `text` 是「图中识别到的完整文字」这**一个**字符串。
 *
 * 在校验**之前**只归一这一个字段，而不是把契约放宽成 `string | string[]`：
 * 契约是所有调用方（客户端、M9 回放脚本、`visualTextQueryOf`）共用的形状，
 * 不该为了一个上游怪癖让每个消费者都去处理数组。同理也不放宽 `strictObject`——
 * 只认这一条有实测证据的差异，其余形状不符照样整段拒绝。
 *
 * 数组里的每一项 trim 后拼接（分隔符用单个空格：这些项本来就是被上游按行切开的同一段文字）；
 * 非字符串项（`null` / 数字）与空白项一并丢弃。若一项都不剩，则**删掉这个字段**而不是给空串：
 * 契约是 `min(1)`，「没识别出文字」的表示法就是"字段缺席"。
 */
function normalizeInterpretationPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload
  const source = payload as Record<string, unknown>
  if (!Array.isArray(source.text)) return payload

  const text = source.text
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')

  const rest: Record<string, unknown> = { ...source }
  delete rest.text
  return text.length > 0 ? { ...rest, text } : rest
}

/**
 * 从模型输出里取出解析结果。
 *
 * `response_format: json_object` 之下**不应该**有代码块围栏，但真实模型偶尔还是会加，
 * 所以剥一层 ```json 围栏再解析：这不是"宽容地接受坏数据"，而是接受一种已知的、
 * 内容仍然要过严格 schema 的包装差异（多出来的字段照样被 strictObject 拒掉）。
 */
function parseInterpretation(content: string): VisualInterpretation | null {
  const trimmed = content.trim()
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')
    : trimmed

  let payload: unknown
  try {
    payload = JSON.parse(unfenced)
  } catch {
    console.warn('[visual-search] 语义解析返回的不是合法 JSON')
    return null
  }

  const parsed = VisualInterpretationSchema.safeParse(normalizeInterpretationPayload(payload))
  if (!parsed.success) {
    // 只记校验错误的形状：模型输出含用户图片里的文字，不能进日志。
    console.warn('[visual-search] 语义解析结果不符合契约', parsed.error.message)
    return null
  }
  return parsed.data
}

export function createVisualParser(env: VisualParseEnv): VisualParser {
  if (env.transport === 'off') {
    // `off` 是 CI 与本机默认：不产生"看起来合理的假结果"，只是少做一步可选增强，
    // 所以返回 null 而不是造一个空壳解析结果（后者会让文本路以为自己有输入）。
    return { parse: async () => null }
  }

  const endpoint = `${env.baseUrl.replace(/\/+$/, '')}/chat/completions`

  return {
    async parse(image, mime) {
      const body = JSON.stringify({
        model: env.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: PROMPT },
              {
                type: 'image_url',
                image_url: {
                  // 查询图在私有对象存储里，上游拿不到我们的地址，只能传字节。
                  url: `data:${mime};base64,${Buffer.from(image).toString('base64')}`,
                },
              },
            ],
          },
        ],
        response_format: { type: 'json_object' },
        max_tokens: VISUAL_PARSE_MAX_TOKENS,
      })

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.apiKey}`,
          },
          body,
          signal: AbortSignal.timeout(VISUAL_PARSE_TIMEOUT_MS),
        })

        if (!response.ok) {
          // 丢弃响应体：既不解析也不记日志（可能回显请求细节，含图片的 base64）。
          await response.body?.cancel()
          console.warn(`[visual-search] 语义解析上游返回 status=${response.status}`)
          return null
        }

        const content = readMessageContent(await response.json())
        if (content === null) {
          console.warn('[visual-search] 语义解析上游响应里没有 message.content')
          return null
        }
        return parseInterpretation(content)
      } catch (error) {
        const detail = error instanceof Error ? error.name : 'unknown'
        console.warn(`[visual-search] 语义解析调用失败：${detail}`)
        return null
      }
    },
  }
}
