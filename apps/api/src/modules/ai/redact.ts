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
export type RedactKind = 'id' | 'card' | 'phone' | 'mail' | 'contact' | 'addr' | 'url'

/**
 * 回填失败时的类型化提示语。**注意它并不比标记长**（`phone` 标记 `[fish-phone-1]` 14 字、
 * 提示语 12 字），所以"回填后文本变长"不是提示语造成的——真正的来源是**还原出的原文比标记长**
 * （如 39 字邮箱换掉 13 字 `[fish-mail-1]`）。这就是回填后仍要再测一次长度的原因（设计 §5.7）。
 */
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
  { kind: 'contact', pattern: /\+?\s?v\s*[:：]\s*[A-Za-z0-9_-]{4,}/gi },
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
 * 形状像标记、但严格匹配不上的（模型把 `[fish-phone-1]` 写成 `[fish-phone- 1]`、全角数字，或
 * 漏了括号写成 `fish-phone-1`）。检测与清理共用它：这类半成品既不能当"找回"（内容可能被改过），
 * 也不能原样留在候选里被用户采用（设计 §5.7 要求标记位必须换成提示语）。比对前先剥掉不可见字符
 * （`INVISIBLE_SEPARATORS`）——所以**插了零宽/软连字符的标记会先归一成标准形态，仍算"找回"**
 * 并按原样还原，而不是被当成半成品降级（那才是用户想要的：拿回自己的内容）。
 *
 * 种类必须是**闭集**（`LOST_PROMPTS` 的键，即我们真正会发出的那几个），不能写成任意 `[a-z]+`：
 * `facts.ts` 的基线是用户原文，把正文里的 `Fish K380` 当成标记摘掉会让引用该型号的候选被判
 * "新增事实"而误丢（#141 审查发现）。写成捕获组是因为 `restore` 要靠它取类型化提示语。
 *
 * 两种形态只允许一种"省略"：
 * - 带左括号时，中间的分隔符可以全是空白（`[fish phone 1]`）；
 * - 不带左括号时，`fish` 与种类之间**必须有 `-` 或 `_`**（`fish-phone-1` / `fish_phone_1`）。
 *
 * 这条约束是 #141 二次审查补的：早先两种省略都允许，于是正文里的 `fish mail 3 个`（`mail` 在
 * 闭集里、后面跟着数字）会被当成半成品标记，用户拿到的候选里凭空出现"（你的邮箱已被移除）"。
 */
const LOOSE_MARKER_PATTERN = new RegExp(
  `(?:\\[\\s*fish[-_\\s]*|fish[-_]+)(${Object.keys(LOST_PROMPTS).join('|')})[-_\\s]*[0-9０-９]+\\s*\\]?`,
  'gi',
)

/**
 * 模型可能把标记拆开、用户可能把号码拆开：不可见 / 格式类字符一律在比对与匹配前剥掉。
 *
 * 字符集：
 * - `\p{Cf}` 覆盖全部格式字符（U+200B–U+200F、U+2060–U+2066、**U+00AD 软连字符**、U+FEFF…）；
 * - `\p{Mn}` / `\p{Me}` 覆盖组合记号（**U+034F CGJ**、**U+FE0F 变体选择符**…）；
 * - Hangul 填充符（U+115F / U+1160 / U+3164 / U+FFA0）类别是 `Lo`，必须单独列。
 *
 * 不要再手枚举码位（旧写法只列了 5 个）：`138<U+00AD>12345678`、`138<U+200E>12345678`、
 * `138<U+3164>12345678` 都能整段绕过手机号规则把号码原样送上游（#141 三次审查发现）。
 * 这组是 `moderation/rules.ts` 那份归一化集合去掉 `\p{Cc}` 后的结果：**刻意不含 `\p{Cc}`**，
 * 因为控制字符里有 `\n` / `\t`——moderation 后续会剥掉全部空白所以无所谓，脱敏却必须保留用户
 * 描述里的换行（送上游的是原文的格式）。
 */
const INVISIBLE_SEPARATORS = /[\p{Cf}\p{Mn}\p{Me}\u115F\u1160\u3164\uFFA0]/gu

/**
 * 摘掉标准形态与**被改写过的**标记字面。事实校验（`facts.ts`）用它在抽取数字前做归一化：
 * 标记里的序号是我们自己的计数，不是模型新增的数字；只摘标准形态会让改写后的标记把序号泄漏
 * 成"新增事实"，候选在过滤层就被丢弃，永远走不到 `restore` 的整条降级（#141 审查发现）。
 *
 * 与 `restore` 共用同一套模式——"标记长什么样"只有这一处定义（设计 §6.3）。
 */
export function stripMarkerLiterals(text: string): string {
  return text
    .replace(INVISIBLE_SEPARATORS, '')
    .replace(MARKER_PATTERN, '')
    .replace(LOOSE_MARKER_PATTERN, '')
}

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
      // 匹配前先剥不可见分隔符：`138\u200b12345678` 若原样送上游，手机号就整段漏给第三方——
      // 用户从网页/Word 复制号码时带进零宽字符是现实场景，不能让一个不可见字符变成绕过脱敏的
      // 手段（同仓 moderation 已按同一口径剥 format 字符，两侧不该有差）。返回的文本同样不含
      // 它们，回填还原的是 `mapping` 里存的那份。
      let result = text.replace(INVISIBLE_SEPARATORS, '')
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
