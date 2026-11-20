import type { ContentModerationProvider, TextModerationResult } from './providers/types'

/**
 * 公开 UGC 文本审核策略（#694 M6）：商品留言、回复、交易评价正文。
 *
 * 与聊天（`chat.ts`）共用 provider 抽象，但**不共用策略号**：公开内容在装配处换成
 * `TENCENT_TMS_UGC_BIZ_TYPE`（见 `app.ts`），聊天走 `tmsChatBizType`。本地 transport 下公开
 * 场景使用独立字段 `publicContent`：联系方式类灰区规则（`PUBLIC_EXTERNAL_CONTACT`）只作用于
 * 公开内容，不把商品或私聊的 `EXTERNAL_CONTACT` 判定混进来。
 *
 * 字段固定为 `publicContent`：不把正文伪装成商品标题/描述 —— 字段名会进上游判定与审计，
 * 伪装会让「受限字段」的解释失真。
 *
 * 结论**只增不减**：只有 ALLOW 放行；调用方必须把 BLOCK / REVIEW / 异常分别映射成
 * 「违规拒绝 / 待人工确认 / 可重试失败」，不得默默当 ALLOW。
 */
export type PublicUgcTextKind = 'comment' | 'reply' | 'review'

/**
 * `DataId` 只用于上游追踪与日志关联：内容还没落库，用一次随机 uuid 保证同一次提交可关联，
 * 又不把尚未生成的资源 id 泄漏给上游。白名单 `[A-Za-z0-9_-]` 由 provider 再校验。
 */
export async function moderatePublicUgcText(
  provider: ContentModerationProvider,
  input: { kind: PublicUgcTextKind; content: string },
): Promise<TextModerationResult> {
  const result = await provider.moderateText({
    dataId: `${input.kind}-${crypto.randomUUID()}`,
    fields: [{ field: 'publicContent', value: input.content }],
  })

  if (result.decision !== 'ALLOW') {
    // 结构化审计线索：只记结论、策略与请求标识，不记正文（maskedTerms 已由 provider 脱敏）。
    console.warn('[moderation] 公开 UGC 文本未通过', {
      kind: input.kind,
      dataId: result.dataId,
      provider: result.provider,
      transport: result.transport,
      policyVersion: result.policyVersion,
      decision: result.decision,
      subLabels: [
        ...new Set(
          result.fields
            .map((field) => field.subLabel)
            .filter((value): value is string => value !== null && value.length > 0),
        ),
      ],
      requestId: result.fields.find((field) => field.requestId !== null)?.requestId ?? null,
    })
  }

  return result
}
