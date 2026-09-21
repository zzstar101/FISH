/**
 * 送上游前的脱敏（设计 §6.1）与回填（设计 §5.7）。
 *
 * 三条边界：中文姓名不做（正则不可靠，误伤正文的收益为负）；不反向修改 `EXTERNAL_CONTACT`
 * 审核规则（那是审核语义，动它要升 `MODERATION_RULE_VERSION` 并影响 #74 的既有结果）；
 * **映射不可导出**——不落库、不落日志、不进错误消息，只存活在请求生命周期内。
 *
 * 标记字面为什么是 ASCII：中文方括号标签会被模型改写或删掉（"（联系方式）"），删掉就回填不上；
 * `[fish-phone-1]` 短、非自然语言，且标记内只有数字与短横，不会被本文件任何规则二次命中。
 */
export const REDACT_RULE_VERSION = '2026-09-21-v1'

export type RedactKind = 'id' | 'card' | 'phone' | 'mail' | 'contact' | 'addr' | 'url'

/** 回填失败时的类型化提示语。比标记长，所以回填后要重新测一次长度（设计 §5.7）。 */
const LOST_PROMPTS: Record<RedactKind, string> = {
  id: '（你的证件号已被移除）',
  card: '（你的银行卡号已被移除）',
  phone: '（你的联系方式已被移除）',
  mail: '（你的邮箱已被移除）',
  contact: '（你的联系方式已被移除）',
  addr: '（你的地址已被移除）',
  url: '（你填写的链接已被移除）',
}

/**
 * 规则顺序即优先级，**不是随便排的**：
 * - 身份证 18 位里含形如 `1990030712…` 的片段（`1[3-9]` 规则会咬上），银行卡 16–19 位同理，
 *   所以 `id` / `card` 必须排在 `phone` 之前，否则先被手机号规则切走一段、两者都还原不回来。
 * - 邮箱与微信号里都含域名样式，`url` 的兜底规则放最后。
 * - `addr` 是设计里明说的弱信号：只认"数字 + 栋/幢/号楼/单元/宿舍"，允许漏，不允许大面积误伤
 *   正文（因此 `号`/`室`/`层` 这类过于常见的后缀不进规则）。
 */
const RULES: readonly { kind: RedactKind; pattern: RegExp }[] = [
  {
    kind: 'id',
    pattern:
      /(?<!\d)[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[0-9Xx](?![\dA-Za-z])/g,
  },
  {
    kind: 'id',
    pattern: /(?<!\d)[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g,
  },
  { kind: 'card', pattern: /(?<!\d)[1-9]\d{15,18}(?!\d)/g },
  {
    kind: 'card',
    pattern: /(?<!\d)\d{4}[-\s]\d{4}[-\s]\d{4}[-\s]\d{4}(?:[-\s]\d{1,3})?(?!\d)/g,
  },
  { kind: 'phone', pattern: /[1１][3-9３-９](?:[-‐‑–—\s　.·]?[0-9０-９]){9}/g },
  { kind: 'mail', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g },
  {
    kind: 'contact',
    pattern: /(?:微信|weixin|wechat|vx|v信|威信|微信同号)\s*(?:号)?\s*[:：]?\s*[A-Za-z0-9_-]{4,}/gi,
  },
  { kind: 'contact', pattern: /(?:qq|Qq|QQ)\s*(?:号)?\s*[:：]?\s*\d{5,11}/g },
  { kind: 'contact', pattern: /\+?\s?v\s*[:：]\s*[A-Za-z0-9_-]{4,}/g },
  { kind: 'addr', pattern: /\d{1,4}\s*(?:栋|幢|号楼|单元|宿舍)/g },
  { kind: 'url', pattern: /https?:\/\/[^\s"'，。；、）)】]+/gi },
  { kind: 'url', pattern: /www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s]*)?/gi },
  {
    kind: 'url',
    pattern: /[A-Za-z0-9-]+\.(?:com|cn|net|org|edu|top|xyz|vip|icu|shop|club)(?:\/[^\s]*)?/gi,
  },
]

const MARKER_PATTERN = /\[fish-([a-z]+)-(\d+)\]/g

/**
 * 形状像标记、但严格匹配不上的（模型把 `[fish-phone-1]` 写成 `[fish-phone- 1]`、全角数字或
 * 插了零宽字符）。检测与清理共用它：这类半成品既不能当"找回"（内容可能被改过），也不能原样
 * 留在候选里被用户采用（设计 §5.7 要求标记位必须换成提示语）。
 */
/**
 * 形状像标记、但严格匹配不上的（模型把 `[fish-phone-1]` 写成 `[fish-phone- 1]` 或全角数字）。
 * 检测与清理共用它：这类半成品既不能当"找回"（内容可能被改过），也不能原样留在候选里被用户
 * 采用（设计 §5.7 要求标记位必须换成提示语）。比对前先剥掉不可见分隔符（`INVISIBLE_SEPARATORS`）。
 */
const LOOSE_MARKER_PATTERN = /\[?\s*fish[-_\s]*([a-z]+)[-_\s]*[0-9０-９]+\s*\]?/gi

/**
 * 模型可能把标记拆开（零宽空格/零宽连接符/BOM 插在中间）：比对与清理前先剥掉它们。
 * 写成 alternation 而不是字符类——biome 的 `noMisleadingCharacterClass` 会拦含 ZWJ 的字符类
 * （ZWJ 用于拼 emoji，放进类里容易被误读）。
 */
const INVISIBLE_SEPARATORS = /\u200b|\u200c|\u200d|\u2060|\ufeff/g

function hasMangledMarker(text: string): boolean {
  const strictCount = (text.match(MARKER_PATTERN) ?? []).length
  const looseCount = (text.match(LOOSE_MARKER_PATTERN) ?? []).length
  return looseCount !== strictCount
}

function promptFor(kind: string): string {
  return LOST_PROMPTS[kind as RedactKind] ?? '（已移除的内容）'
}

/** 一次脱敏的产物：`markers` 是回填时**必须原样找回来**的那些标记。 */
export type Redaction = {
  text: string
  markers: readonly string[]
}

export type Redactor = {
  /** 脱敏一段文本。同一实例内计数与映射跨字段共享（title 与 description 一起送上游）。 */
  redact(text: string): Redaction
  /**
   * 回填。整条降级而非逐标记混合（设计 §5.7）：`redaction.markers` 里任一标记没原样回来，
   * 或出现本实例没发出过的标记（模型自造）、形状被改写过的标记，该条全部标记位都换成类型化
   * 提示语——绝不按顺序猜，猜错等于把 A 的电话接到 B 的位置。
   *
   * **只要求 `redaction.markers` 齐全**：候选是这段文本的改写，别的字段（标题）的标记只是
   * 上下文——标题里的标记天然不会出现在描述候选里，把它也算"丢失"会把用户自己的联系方式
   * 换成提示语并错记 `TOKEN_LOST`（真实上游踩过）。标题的标记若真被模型带进候选，照样能还原。
   */
  restore(text: string, redaction: Redaction): { text: string; lost: boolean }
  /** 是否发生过脱敏（响应里的 `redacted` 字段）。 */
  readonly redacted: boolean
}

export function createRedactor(): Redactor {
  const counters = new Map<RedactKind, number>()
  const mapping = new Map<string, string>()
  let hits = 0

  return {
    redact(text) {
      const markers: string[] = []
      let result = text
      for (const rule of RULES) {
        result = result.replace(rule.pattern, (match) => {
          const next = (counters.get(rule.kind) ?? 0) + 1
          counters.set(rule.kind, next)
          const marker = `[fish-${rule.kind}-${next}]`
          mapping.set(marker, match)
          markers.push(marker)
          hits += 1
          return marker
        })
      }
      return { text: result, markers }
    },

    restore(text, redaction) {
      // 统一在"剥掉不可见分隔符"的形式上比对与清理：模型把标记拆开时也能识别，且不会把
      // 不可见字符留在用户拿到的候选里。
      const source = text.replace(INVISIBLE_SEPARATORS, '')
      const present = new Set(source.match(MARKER_PATTERN) ?? [])
      const foreign =
        [...present].some((marker) => !mapping.has(marker)) || hasMangledMarker(source)
      const missing = redaction.markers.some((marker) => !present.has(marker))
      if (foreign || missing) {
        return {
          text: source
            .replace(MARKER_PATTERN, (_match, kind: string) => promptFor(kind))
            // 半成品标记不能原样留给用户：换成同类型的提示语。
            .replace(LOOSE_MARKER_PATTERN, (_match, kind: string) => promptFor(kind)),
          lost: true,
        }
      }
      return {
        text: source.replace(
          MARKER_PATTERN,
          (marker, kind: string) => mapping.get(marker) ?? promptFor(kind),
        ),
        lost: false,
      }
    },

    get redacted() {
      return hits > 0
    },
  }
}
