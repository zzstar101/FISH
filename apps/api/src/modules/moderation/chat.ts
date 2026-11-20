import type {
  ContentModerationProvider,
  ModerationProviderName,
  ModerationSuggestion,
  ModerationTransport,
} from './providers/types'
import type { ModerationDecision } from './types'

/**
 * 聊天内容安全策略（#694 M1）。
 *
 * 这一层夹在「消息业务」与「provider」之间：provider 只回答某个字段怎么判，聊天策略负责
 * **用哪套策略号、按什么字段送审、把结论摊平成可审计的一行**。商品侧不经过这里——
 * 两者共用 provider，但绝不能共用 BizType（聊天与商品的腾讯策略不同）。
 *
 * 结论**只增不减**：provider 必须显式给 ALLOW 才放行；调用方拿到异常时必须 fail-closed，
 * 不要把「没有结论」当通过（provider 层已保证异常不映射到 ALLOW）。
 */
export interface ChatModerationResult {
  decision: ModerationDecision
  provider: ModerationProviderName
  transport: ModerationTransport
  /** 上游 `RequestId`（本地为 null）；聊天记录只记它，不记正文。 */
  providerRequestId: string | null
  /** 腾讯 BizType 或本地规则版本；与消息快照一起入库供审计。 */
  policyVersion: string
  suggestion: ModerationSuggestion
  label: string | null
  subLabel: string | null
  score: number | null
  /** 命中的规则码（本地）或上游子标签（腾讯），去重后写审计表。 */
  matchedRules: string[]
  /** 命中词的脱敏形态；本地词表提供，腾讯侧为空（上游不回带命中原文）。 */
  matchedTermsMasked: string[]
}

export interface ChatModerationPolicy {
  /** 文本送审：只审 `content` 字段，不把正文伪装成商品标题/描述。 */
  moderateText(input: { content: string }): Promise<ChatModerationResult>
}

/**
 * `DataId` 是腾讯侧的请求标识：消息还没落库，用一次随机 uuid 保证「同一次发送的每个字段」
 * 可关联，又不把尚未生成的消息 id 泄漏给上游。白名单 `[A-Za-z0-9_-]` 由 provider 再校验。
 */
function chatDataId(): string {
  return `chat-${crypto.randomUUID()}`
}

export function createChatModerationPolicy(
  provider: ContentModerationProvider,
): ChatModerationPolicy {
  return {
    async moderateText({ content }) {
      const result = await provider.moderateText({
        dataId: chatDataId(),
        fields: [{ field: 'content', value: content }],
      })
      const first = result.fields[0]
      const matchedRules = [
        ...new Set(
          result.fields
            .map((field) => field.subLabel)
            .filter((value): value is string => typeof value === 'string' && value.length > 0),
        ),
      ]
      return {
        decision: result.decision,
        provider: result.provider,
        transport: result.transport,
        providerRequestId:
          result.fields.find((field) => field.requestId !== null)?.requestId ?? null,
        policyVersion: result.policyVersion,
        suggestion: result.suggestion,
        label: first?.label ?? null,
        subLabel: first?.subLabel ?? null,
        score: first?.score ?? null,
        matchedRules,
        matchedTermsMasked: [...new Set(result.fields.flatMap((field) => field.maskedTerms ?? []))],
      }
    },
  }
}
