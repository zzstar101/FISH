import type { ModerationField, ModerationMatch, ModerationResult } from './types'

export const MODERATION_RULE_VERSION = '2026-09-15-v2'

type Rule = { code: string; decision: 'BLOCK' | 'REVIEW'; terms: readonly string[] }

/** 词库只存在服务端；新增规则只改本文件并提升版本号。 */
const RULES: readonly Rule[] = [
  {
    code: 'PROHIBITED_CONTENT',
    decision: 'BLOCK',
    terms: ['毒品', '枪支', '赌博', '色情', '假证', '违禁品'],
  },
  {
    code: 'EXTERNAL_CONTACT',
    decision: 'REVIEW',
    terms: ['微信号', '加微信', 'vx', 'v信', '二维码', '外链'],
  },
]

function normalize(value: string): string {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase('zh-CN')
      .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
      // 先去掉分隔字符再匹配：`毒-品` / `加/微信` / `v.x` / `加·微信` 这类插入式规避
      // 不改词表就能穿过基础匹配（评审 major 3）。
      // 标点用 Unicode 属性类而不是手枚举：`\p{P}` 覆盖中英文标点，`\p{S}` 覆盖 `+`、`·`、`•`、
      // `©` 这类符号；再加上它们之间的空白/零宽字符与下划线/连字符（下划线是 `\p{Pc}`，本就在 `\p{P}`）。
      // 注意：不能顺手把数字/字母也去掉 —— 那会把 `vx`、`v.x` 全归一成同一个短串，误伤正常文案。
      .replace(/[\p{P}\p{S}\s\u3000]+/gu, '')
  )
}

function maskTerm(term: string): string {
  if (term.length <= 1) return '*'
  return `${term[0]}${'*'.repeat(Math.max(1, term.length - 2))}${term.at(-1)}`
}

export function moderateListingContent(input: {
  title: string
  description: string
}): ModerationResult {
  const matches: ModerationMatch[] = []
  for (const [field, value] of Object.entries(input) as [ModerationField, string][]) {
    const normalized = normalize(value)
    for (const rule of RULES) {
      for (const term of rule.terms) {
        if (normalized.includes(normalize(term)))
          matches.push({ field, ruleCode: rule.code, maskedTerm: maskTerm(term) })
      }
    }
  }
  const decision = matches.some((match) => match.ruleCode === 'PROHIBITED_CONTENT')
    ? 'BLOCK'
    : matches.length > 0
      ? 'REVIEW'
      : 'ALLOW'
  return {
    decision,
    matches,
    reasonCode:
      decision === 'BLOCK'
        ? 'PROHIBITED_CONTENT'
        : decision === 'REVIEW'
          ? 'CONTENT_REQUIRES_REVIEW'
          : null,
    ruleVersion: MODERATION_RULE_VERSION,
  }
}
