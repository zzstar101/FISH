/**
 * 意见反馈的本机暂存形状与解析（**Taro-free，可直接单测**）。
 *
 * ## 相比旧版，多了 `ownerId` 与 `submitId`
 *
 * 草稿 key 仍是 `fish:feedback:draft`（隐私政策的数据清单照旧），但记录里带：
 * - `ownerId`：同一台手机上换账号后，上一个账号未提交的内容不能被下一个账号恢复出来 ——
 *   反馈内容与联系方式可能包含个人信息，草稿也是私有的。页面据此只恢复归属当前账号的草稿
 *   （`parseFeedbackDraft` 不做归属判断，归属判定由纯函数 `acceptDraft` 做）。
 * - `submitId`：上一次提交用的幂等键（`clientRequestId`）。**必须跟着草稿一起持久化**：
 *   请求超时 / 页面在响应落地前被卸载时，服务端可能已经落库；恢复草稿后若换一个新键再提交，
 *   服务端会当成另一条反馈，用户就在「我的反馈」里看到两条一模一样的记录。沿用旧键重放，
 *   服务端按 `(user_id, client_request_id)` 唯一约束命中同一行。
 *
 * **没有 `ownerId` 的旧格式草稿一律不恢复**（`acceptDraft` 对 `ownerId: null` 返回 `null`）：
 * 旧版本的 key 是设备级的，无法判断它属于谁；宁可让用户重打一遍，也不把上一个账号写的内容
 * 展示给当前账号。
 *
 * ## 类型值来自契约
 *
 * `type` 存的是契约枚举（`BUG` / `UX` / …），不是旧版的小写键（`bug` / `ux` / …）。
 * 旧格式同时也没有 `ownerId`，所以不需要做键值兼容 —— 整条都会被丢弃（见上）。
 *
 * ## 容错口径
 *
 * 存储里的东西可能来自更早的版本、也可能被外部工具写坏：
 * 字段级容错（类型不对 → 该字段按空处理）、超长截断、坏 JSON → `null`、空草稿 → `null`。
 * 解析永远不抛，页面拿到 `null` 就当没有草稿。
 */
import { type FeedbackType, FeedbackTypeSchema } from '@fish/contracts/feedback/schema'

export const FEEDBACK_DRAFT_KEY = 'fish:feedback:draft'

/** 草稿形状：三种输入 + 归属账号 + 上次提交的幂等键（两者都可能缺省） */
export type FeedbackDraft = {
  /** `null` = 旧格式 / 无法判断归属；`acceptDraft` 会拒绝这类草稿 */
  ownerId: string | null
  /** 上次提交用的 `clientRequestId`；`null` = 没提交过 / 旧格式 */
  submitId: string | null
  type: FeedbackType | ''
  desc: string
  contact: string
}

/** 描述最多存 600 字（输入框 maxlength；上限 500 由页面在提交时判） */
const DRAFT_DESC_MAX = 600
/** 联系方式最多存 100 字（契约上限） */
const DRAFT_CONTACT_MAX = 100
/** 幂等键的形状（契约 `FeedbackCreateInputSchema` 的 `z.uuid()`）；坏值当没有 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

function readType(value: unknown): FeedbackType | '' {
  const parsed = FeedbackTypeSchema.safeParse(value)
  return parsed.success ? parsed.data : ''
}

function readOwnerId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function readSubmitId(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value : null
}

/**
 * 解析本机暂存的反馈草稿。
 *
 * 接受两种存储形态（与 `features/reports` 等模块的容错口径一致）：
 * - 对象（`Taro.setStorageSync` 直接存对象时读回来的就是对象）；
 * - JSON 字符串（某些运行环境 / 旧版本会序列化后再存）。
 *
 * 全空草稿返回 `null`：页面据此不显示「已恢复」提示条。
 */
export function parseFeedbackDraft(raw: unknown): FeedbackDraft | null {
  if (raw === null || raw === undefined) return null
  let source: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null
    try {
      source = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (typeof source !== 'object' || source === null) return null

  const record = source as Record<string, unknown>
  const type = readType(record.type)
  const desc = readText(record.desc, DRAFT_DESC_MAX)
  const contact = readText(record.contact, DRAFT_CONTACT_MAX)
  const ownerId = readOwnerId(record.ownerId)
  const submitId = readSubmitId(record.submitId)
  if (type === '' && desc === '' && contact === '') return null
  return { ownerId, submitId, type, desc, contact }
}

/**
 * 页面恢复判定：**只接受属于当前账号的草稿**。
 *
 * - 解析失败（`null`）→ 没有草稿；
 * - `ownerId` 与当前账号不同，或为 `null`（旧格式）→ 不恢复 —— 旧版本的 key 是设备级的，
 *   无法判断内容属于谁，不能把它展示给当前账号（见文件头说明）。
 */
export function acceptDraft(parsed: FeedbackDraft | null, ownerId: string): FeedbackDraft | null {
  if (parsed === null) return null
  return parsed.ownerId === ownerId ? parsed : null
}
