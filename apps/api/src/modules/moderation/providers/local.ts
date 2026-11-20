/**
 * 本地词表 provider（#228 的 `CONTENT_MODERATION_TRANSPORT=local`）。
 *
 * 只用于开发/测试：文本复用现有 `rules.ts` 词表（与 `ModerationService` 同一份规则，避免两处漂移），
 * 图片**不做内容审核**——判不了就返回 REVIEW（进人工队列，不可公开），绝不返回 ALLOW。
 * 生产用 `CONTENT_MODERATION_TRANSPORT=local` 会在启动期直接失败（见 `@fish/shared/env`）。
 */
import { MODERATION_RULE_VERSION, moderateContentFields } from '../rules'
import type { ModerationDecision, ModerationField } from '../types'
import {
  aggregateModerationDecision,
  ContentModerationError,
  type ContentModerationProvider,
  type FieldModerationResult,
  suggestionFromDecision,
} from './types'

/** 本地 transport 不审图片内容时的 `reasonCode`，调用方可据此区分「人工队列」的原因。 */
export const LOCAL_IMAGE_NOT_AUDITED = 'LOCAL_IMAGE_NOT_AUDITED'

export function createLocalContentModerationProvider(): ContentModerationProvider {
  return {
    transport: 'local',

    async moderateText(input) {
      const auditable = input.fields.filter((item) => item.value.trim().length > 0)
      if (auditable.length === 0) {
        // 与腾讯 provider 同一口径：没有可审内容不等于通过。
        throw new ContentModerationError({ reason: 'invalid_input', detail: 'no_content' })
      }
      // 逐字段匹配词表：商品（title/description）与聊天（content）走同一份规则。
      // 旧实现只取 title/description，导致 #694 的聊天正文恒 ALLOW——这正是聊天不能
      // 直接复用商品通道的原因。
      const result = moderateContentFields(
        Object.fromEntries(auditable.map((item) => [item.field, item.value])) as Partial<
          Record<ModerationField, string>
        >,
      )
      const fields: FieldModerationResult[] = auditable.map((item) => {
        const matches = result.matches.filter((match) => match.field === item.field)
        // 该字段没有命中任何规则 = 这个字段无风险（是结论，不是「没有结论」），显式给 ALLOW。
        const decision: ModerationDecision =
          matches.length === 0
            ? 'ALLOW'
            : aggregateModerationDecision(matches.map((match) => match.decision))
        return {
          field: item.field,
          decision,
          suggestion: suggestionFromDecision(decision),
          // 本地词表没有腾讯的 Label/Score：label 留空，用 subLabel 回带命中的规则码。
          label: null,
          subLabel: matches[0]?.ruleCode ?? null,
          score: null,
          requestId: null,
          maskedTerms: matches.map((match) => match.maskedTerm),
        }
      })
      const decision = aggregateModerationDecision(fields.map((item) => item.decision))
      return {
        provider: 'LOCAL',
        transport: 'local',
        dataId: input.dataId,
        policyVersion: MODERATION_RULE_VERSION,
        decision,
        suggestion: suggestionFromDecision(decision),
        fields,
      }
    },

    async moderateImage(input) {
      return {
        provider: 'LOCAL',
        transport: 'local',
        dataId: input.dataId,
        objectKey: input.objectKey,
        policyVersion: MODERATION_RULE_VERSION,
        decision: 'REVIEW',
        suggestion: 'Review',
        label: null,
        subLabel: null,
        score: null,
        requestId: null,
        contentDigest: null,
        reasonCode: LOCAL_IMAGE_NOT_AUDITED,
      }
    },
  }
}
