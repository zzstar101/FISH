import { stripMarkerLiterals } from './redact'

/**
 * "AI 不得新增事实"的**唯一可验证**形式（设计 §5.6c）：原文与候选各自归一化后取
 * "数字 + 紧邻单位"的集合，候选里出现原文没有的 → 该条候选丢弃。
 *
 * 刻意不做的事：
 * - **不做单位换算**（`斤`→`500g` 这类）：第二个会漂移的真相源（设计 §6.3）。
 * - **不养断言词表**（"包邮""正品"）：语义类风险交给 moderation，那是 #74 的迭代。
 *
 * 单位只认 ASCII 字母、`%` 与 `元/块/折/成/新` 五个汉字，且**只取首字符、字母小写**
 * （`128G` 与 `128 GB` 归一化后都是 `128g`，这是设计测试矩阵明确要求不许误杀的一对）。
 * 未列入的字符（`1.5米`、`3个`）退化为只比数字——少判不误杀：`元 ↔ 块` 这类同义改写会被
 * 当成新增事实而丢候选，误杀率待 `filtered_count` 观察（设计 §11-R4）。
 */
export type FactToken = string

/**
 * 中文数字只在**紧跟已识别单位**（或自身含十/百/千/万这类量级字）时才算数字，
 * 否则 `一起` `一共` `一年` 里的 `一` 都会被误当成 1。
 */
const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  贰: 2,
  两: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
}

const CN_SCALE: Record<string, number> = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 }
const CN_SECTION: Record<string, number> = { 万: 10_000, 亿: 100_000_000 }

const UNIT_CHARS = new Set(['%', '元', '块', '折', '成', '新'])

function isAsciiDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isCnNumeral(ch: string): boolean {
  return ch in CN_DIGITS || ch in CN_SCALE || ch in CN_SECTION
}

/** 中文数字序列 → 阿拉伯数字串；含量级字走乘加，纯数字序列按位拼接（`二零二五` → 2025）。 */
function cnToArabic(sequence: string): string {
  const hasScale = [...sequence].some((ch) => ch in CN_SCALE || ch in CN_SECTION)
  if (!hasScale) {
    return [...sequence].map((ch) => String(CN_DIGITS[ch] ?? 0)).join('')
  }

  let total = 0
  let section = 0
  let current = 0
  let seenDigit = false
  for (const ch of sequence) {
    if (ch in CN_DIGITS) {
      current = CN_DIGITS[ch] ?? 0
      seenDigit = true
      continue
    }
    const scale = CN_SCALE[ch]
    if (scale !== undefined) {
      // `十二` 这类没有前导数字的写法，量级前面的系数按 1 算。
      section += (seenDigit ? current : 1) * scale
      current = 0
      seenDigit = true
      continue
    }
    const magnitude = CN_SECTION[ch]
    if (magnitude !== undefined) {
      section = (section + current) * magnitude
      total += section
      section = 0
      current = 0
      seenDigit = true
    }
  }
  return String(total + section + current)
}

/** 紧邻单位：ASCII 字母取小写首字符；`%` 与五个汉字原样；其余不算单位。 */
function unitAt(text: string, index: number): string {
  const ch = text[index]
  if (ch === undefined) return ''
  if (ch >= 'A' && ch <= 'Z') return ch.toLowerCase()
  if (ch >= 'a' && ch <= 'z') return ch
  return UNIT_CHARS.has(ch) ? ch : ''
}

/**
 * 归一化：**先**摘标记（标准与被改写的形态都摘，见 `redact.ts` 的 `stripMarkerLiterals`）——
 * 标记里的序号是我们的计数，不是模型新增的数字，漏摘会让候选在过滤层被误丢；再 NFKC
 * （全角数字/括号归一）、剥空白与千分位逗号。
 */
function normalize(text: string): string {
  return stripMarkerLiterals(text)
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[,，]/g, '')
}

/**
 * 抽取事实令牌。ASCII 数字串一定算数字；中文数字需要紧跟已识别单位、或自身含量级字。
 */
export function extractFacts(text: string): Set<FactToken> {
  const source = normalize(text)
  const tokens = new Set<FactToken>()
  let index = 0

  while (index < source.length) {
    const ch = source[index] ?? ''

    if (isAsciiDigit(ch)) {
      let number = ''
      while (index < source.length && isAsciiDigit(source[index] ?? '')) {
        number += source[index]
        index += 1
      }
      // 小数：`.` 两侧都是数字才算
      if (source[index] === '.' && isAsciiDigit(source[index + 1] ?? '')) {
        number += '.'
        index += 1
        while (index < source.length && isAsciiDigit(source[index] ?? '')) {
          number += source[index]
          index += 1
        }
      }
      tokens.add(`${number}${unitAt(source, index)}`)
      continue
    }

    if (isCnNumeral(ch)) {
      let sequence = ''
      while (index < source.length && isCnNumeral(source[index] ?? '')) {
        sequence += source[index]
        index += 1
      }
      const scale = [...sequence].some((c) => c in CN_SCALE || c in CN_SECTION)
      const unit = unitAt(source, index)
      // 单字中文数字 + 未识别单位（`三件`、`一个月`、`一起`）一律不算：`一起/一切/一共`
      // 这类词里的 `一` 会被当成 1，宁可少判也不误杀（代价见文件头：模型把 `三件` 改写成
      // `3件` 时该候选会被丢）。多字序列（`二零二五`）无歧义，量级字同理。
      if (scale || unit || sequence.length >= 2) tokens.add(`${cnToArabic(sequence)}${unit}`)
      continue
    }

    index += 1
  }

  return tokens
}

/**
 * 候选是否引入了用户**没提供过**的数字/单位事实。`true` → 调用方丢弃该候选（设计 §5.6c）。
 *
 * 基线必须传**模型看到过的全部用户内容**（标题 + 描述）：标题也进了 prompt，模型在候选里引用
 * 标题中的型号（"罗技 K380" → `380`）是合理行为。实测只拿描述当基线会让真实上游三条候选全被
 * 判为"新增事实"、接口返回 `AI_RESULT_EMPTY`。传数组即取并集。
 *
 * 用集合（按字面去重）而不是多重集：候选把同一个数字重复一次不算新增事实，
 * 但数字本身变了（`500元` → `600元`）一定算。
 */
export function addsUnknownFacts(
  original: string | readonly string[],
  candidateText: string,
): boolean {
  const known = new Set<FactToken>()
  for (const source of typeof original === 'string' ? [original] : original) {
    for (const token of extractFacts(source)) known.add(token)
  }

  for (const token of extractFacts(candidateText)) {
    if (!known.has(token)) return true
  }
  return false
}
