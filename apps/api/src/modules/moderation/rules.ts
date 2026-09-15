import type { ModerationField, ModerationMatch, ModerationResult } from './types'

export const MODERATION_RULE_VERSION = '2026-09-15-v1'

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
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\u200b-\u200f\u202a-\u202e]/g, '')
    .replace(/[\s\u3000]+/g, '')
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
