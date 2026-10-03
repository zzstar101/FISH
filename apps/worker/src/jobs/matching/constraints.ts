import type { MatchListingFacts, MatchSemanticInput, MatchWishFacts } from './scoring'
import { scoreMatch } from './scoring'

export const CONSTRAINT_POLICY_VERSION = 1
export type ConstraintState = 'unconstrained' | 'satisfied' | 'contradicted' | 'unknown'
export type ConstraintReason = 'excluded_literal_present' | 'required_literal_denied'
type Requirement = { kind: 'exclude' | 'require'; literal: string }

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

function clauses(text: string): string[] {
  return (
    text
      // 保留问号，不能在分句时抹掉“X吗？”的不确定极性。
      .split(/[，,。.;；!！\n]/u)
      .map(normalize)
      .filter(Boolean)
  )
}

/** 只解释完整、单对象的显式句式；不解释偏好、备选、复杂从句或商品/品牌别名。 */
function parseRequirements(text: string): { requirements: Requirement[]; unsupported: boolean } {
  const requirements: Requirement[] = []
  let unsupported = false
  for (const clause of clauses(text)) {
    // “不要求”以“不要”开头，但表示取消条件，不是排除“求…”这个对象。
    if (/^(?:我)?(?:不要求|不介意|不需要|不用|不一定|不要紧)/u.test(clause)) continue
    const match = /^(?:我)?(不要|不接受|只要|必须支持)\s*(.+)$/u.exec(clause)
    if (!match?.[1] || !match[2]) continue
    const literal = match[2].replace(/的$/u, '').trim()
    // “不要 X 或 Y”“只要不是 X”等不是一个简单字面约束；保持 unknown，不猜测其逻辑。
    if (
      literal.length < 2 ||
      /[“”"'‘’?？]|或者|或|以及|但是|而是|的话|只支持|不是|不支持|不兼容/u.test(literal)
    ) {
      unsupported = true
      continue
    }
    requirements.push({
      kind: match[1] === '不要' || match[1] === '不接受' ? 'exclude' : 'require',
      literal,
    })
  }
  return { requirements, unsupported }
}

/**
 * 商品原文中的字面证据。标题与描述使用同一完整声明语法；不从任意标题子串推断属性。
 * 引用、请求、假设、双重否定、未能判定作用范围的否定和相互矛盾的声明均不是确定性证据。
 * 这不是完整中文解析器：unsupported/别名/无提及都保持 unknown，未知不拦截。
 */
function literalEvidence(texts: string[], literal: string): 'affirmed' | 'denied' | 'unknown' {
  let affirmed = false
  let denied = false
  let ambiguous = false
  for (const text of texts) {
    for (const clause of clauses(text)) {
      let start = 0
      for (;;) {
        const index = clause.indexOf(literal, start)
        if (index < 0) break
        start = index + literal.length
        // 英文型号必须是词边界，避免 ipad 命中 ipados 之类更长的词。
        if (/^[a-z0-9]/u.test(literal) && /[a-z0-9_]$/u.test(clause.slice(0, index))) continue
        if (/[a-z0-9]$/u.test(literal) && /^[a-z0-9_]/u.test(clause.slice(start))) continue
        const before = clause.slice(0, index)
        const after = clause.slice(start)
        const directNegativePrefix =
          /^(?:本品|本产品|商品|产品|设备|该设备)?\s*(?:不支持|不兼容|不能|不是|并非|没有|不带|不含|不提供|不具备|不适用|非|无)\s*$/u.test(
            before,
          )
        const directPositivePrefix =
          /^(?:本品|本产品|商品|产品|设备|该设备)?(?:是|为|有|支持|兼容|采用|具备|配备|提供|含有|带有|自带)\s*$/u.test(
            before,
          )
        if (
          // 简单谓词须覆盖完整分句。任意未解释的对象后缀都保持未知，而非补条件词黑名单。
          ((directNegativePrefix || directPositivePrefix) && after !== '') ||
          /[“”"'‘’?？]|是否|可能|也许|或许|应该|大概|估计|貌似|好像|似乎|疑似|待确认|待验证|待测试|未确认|未核实|未验证|未测试|待核实|不确定|未知|不清楚|听说|据说/u.test(
            clause,
          ) ||
          // 没写问号的疑问/推测助词也不是声明证据。
          /(?:吗|么|呢|吧)\s*$/u.test(after) ||
          // 后置否定尚不在支持语法内；不能把“X不支持”里的 X 当肯定声明。
          /(?:不|没|非|无|未)/u.test(after) ||
          /^(?:我)?(?:不要|不接受|只要|必须|如果|假如|建议|最好|优先)/u.test(clause) ||
          /(?:不是|并非|并不|没有)\s*(?:不|非|无)/u.test(before)
        ) {
          ambiguous = true
        } else if (directNegativePrefix) {
          // 只接受直接陈述，不能从“不知道是不是X”等复杂前缀中截出“不是X”。
          denied = true
        } else if (
          /(?:不|没|非|无|未)/u.test(before) &&
          !/(?:不仅|不但|不光)/u.test(before) &&
          !/(?:但是|但|而是|不过)/u.test(before)
        ) {
          // 否定离对象较远时不擅自猜作用域，比如“不支持有线或无线”的第二个对象。
          ambiguous = true
        } else if (
          // 标题与描述都须完整声明；裸对象/有限肯定后缀之外的任意上下文不升级为肯定证据。
          directPositivePrefix ||
          (before === '' &&
            (after === '' || /^(?:功能)?(?:正常|可用|存在|支持|兼容)$/u.test(after)))
        ) {
          affirmed = true
        } else {
          ambiguous = true
        }
      }
    }
  }
  if (ambiguous || affirmed === denied) return 'unknown'
  return affirmed ? 'affirmed' : 'denied'
}

export function checkExplicitConstraints(
  listing: Pick<MatchListingFacts, 'title' | 'description'>,
  wish: { keyword: string; description?: string | null },
): { state: ConstraintState; reasons: ConstraintReason[] } {
  const parsed = parseRequirements(`${wish.keyword}\n${wish.description ?? ''}`)
  if (parsed.requirements.length === 0) {
    return { state: parsed.unsupported ? 'unknown' : 'unconstrained', reasons: [] }
  }
  let unknown = parsed.unsupported
  const reasons = new Set<ConstraintReason>()
  for (const requirement of parsed.requirements) {
    const evidence = literalEvidence([listing.title, listing.description], requirement.literal)
    if (evidence === 'unknown') unknown = true
    else if (requirement.kind === 'exclude' && evidence === 'affirmed')
      reasons.add('excluded_literal_present')
    else if (requirement.kind === 'require' && evidence === 'denied')
      reasons.add('required_literal_denied')
  }
  return {
    state: reasons.size > 0 ? 'contradicted' : unknown ? 'unknown' : 'satisfied',
    reasons: [...reasons],
  }
}

/** 同一入口约束 v1 fallback 和 v2；零分会使既有高分行在原 score-only 读接口中隐藏。 */
export function scoreConstrainedMatch(
  listing: MatchListingFacts,
  wish: MatchWishFacts & { description?: string | null },
  semantic: MatchSemanticInput | null,
) {
  const raw = scoreMatch(listing, wish, semantic)
  const constraint = checkExplicitConstraints(listing, wish)
  return {
    ...raw,
    score: constraint.state === 'contradicted' ? 0 : raw.score,
    rawScore: raw.score,
    constraint,
    constraintPolicyVersion: CONSTRAINT_POLICY_VERSION,
  }
}
