import type { ModerationField, ModerationMatch, ModerationResult } from './types'

export const MODERATION_RULE_VERSION = '2026-09-15-v3'

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
      // 先去掉**不可见 / 格式类字符**再匹配。
      //
      // 不能手枚举码位（旧写法只列了 `\u200b-\u200f\u202a-\u202e` 十个）：`Cf`（格式字符）与
      // `Mn`（无宽组合记号）里还有大量可用于打断词组的字符，比如 U+2060 word-joiner、
      // U+3164 Hangul filler、U+00AD soft hyphen、U+FE00-FE0F variation selector、U+FFF9-FFA0
      // 等 —— 它们把 `毒品` / `加微信` 拆开就绕过了匹配（评审 D1，实测可发布）。
      //
      // `\p{Cf}` 覆盖全部格式字符，`\p{Mn}`/`\p{Me}` 覆盖组合记号；外加 ASCII 控制字符
      // （`\p{Cc}`，含 TAB/NUL）与零宽空格 U+FEFF。
      //
      // 还有一类**不是** `Cf`/`Mn` 但同样不可见、同样能拆开词组的填充字符：Hangul 填充符
      // （U+115F / U+1160 / U+3164 / U+FFA0）——它们的类别是 `Lo`（字母），所以必须单独列出，
      // 否则 `毒<U+3164>品` 仍会漏过（实测）。
      .replace(/[\p{Cf}\p{Mn}\p{Me}\p{Cc}\uFEFF\u115F\u1160\u3164\uFFA0]/gu, '')
      // 再去掉分隔字符：`毒-品` / `加/微信` / `v.x` / `加·微信` 这类插入式规避
      // 不改词表就能穿过基础匹配（评审 major 3）。
      // 标点用 Unicode 属性类而不是手枚举：`\p{P}` 覆盖中英文标点，`\p{S}` 覆盖 `+`、`·`、`•`、
      // `©` 这类符号；再加上空白（含 U+3000）。
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
          matches.push({
            field,
            ruleCode: rule.code,
            decision: rule.decision,
            maskedTerm: maskTerm(term),
          })
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
