import type { ModerationField, ModerationMatch, ModerationResult } from './types'

export const MODERATION_RULE_VERSION = '2026-11-20-v5'

type Rule = {
  code: string
  decision: 'BLOCK' | 'REVIEW'
  terms: readonly string[]
  /**
   * 规则生效的字段。缺省 = 所有字段。
   *
   * `EXTERNAL_CONTACT` 只针对商品文案：商品描述里留微信是引流违规，而私聊里交换联系方式是
   * 正常行为（#694 M1 票面明令「不能把商品本地词表的 EXTERNAL_CONTACT 直接套到私聊」）。
   * 聊天正文只走 `PROHIBITED_CONTENT` 这类通用规则。
   */
  fields?: readonly ModerationField[]
}

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
    fields: ['title', 'description'],
  },
  {
    code: 'PUBLIC_EXTERNAL_CONTACT',
    decision: 'REVIEW',
    terms: ['微信号', '加微信', 'vx', 'v信', '二维码', '外链'],
    // 公开 UGC 正文与用户昵称/签名同属「任何访客都能看到」的内容，引流一律进人工复审；
    // 商品文案有自己更宽的 EXTERNAL_CONTACT，私聊不套这两条（#694 M1）。
    fields: ['publicContent', 'nickname', 'signature'],
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

/**
 * 按字段匹配词表。商品（title/description）与聊天（content）共用同一份规则表，但每条规则
 * 可以用 `fields` 限定生效字段（目前只有 `EXTERNAL_CONTACT` 限定在商品字段）。
 * **不要**把聊天正文拼进 title 送给上游——字段名是审计与原因解释的一部分（#694 M1）。
 */
export function moderateContentFields(
  input: Partial<Record<ModerationField, string>>,
): ModerationResult {
  const matches: ModerationMatch[] = []
  for (const [field, value] of Object.entries(input) as [ModerationField, string][]) {
    const normalized = normalize(value)
    for (const rule of RULES) {
      if (rule.fields && !rule.fields.includes(field)) continue
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

/** 商品文本审核的既有入口（#228）：保留调用方签名，内部走 `moderateContentFields`。 */
export function moderateListingContent(input: {
  title: string
  description: string
}): ModerationResult {
  return moderateContentFields(input)
}
