/**
 * 意见反馈的**本机暂存**形状与解析 —— **Taro-free**，可直接单测。
 *
 * 为什么单独一个文件：解析这段逻辑有三个真实分支（weapp 返回对象 / H5 返回 JSON 字符串 /
 * 存储被外部写坏），而 `Taro.getStorageSync` 只能在端上跑。把纯函数摘出来之后，
 * 页面里只剩「取值 → 解析 → 落 state」三行，分支则被 `tests/feedback-draft.test.ts` 覆盖
 * —— 与 `pages/sell/form.ts` + `tests/sell-form.test.ts` 同一写法。
 *
 * ⚠️ **未定内容页面**：反馈类型的清单本身由 **zzstar** 决策（稿里是初稿）。
 * 定稿时改这个常量即可，页面与暂存格式都不动。
 */

/** 反馈类型键。与 `pages/feedback/index.tsx` 的 `TYPES` 一一对应（那边补 label / 图标 / 引导文案） */
export const FEEDBACK_TYPE_KEYS = ['bug', 'ux', 'dispute', 'report', 'account', 'other'] as const

export type FeedbackTypeKey = (typeof FEEDBACK_TYPE_KEYS)[number]

/** 本机暂存的草稿；`type` 为 `''` = 还没选类型 */
export type FeedbackDraft = {
  type: FeedbackTypeKey | ''
  desc: string
  contact: string
}

/** 本机暂存键（与 `fish:settings` 同一命名风格） */
export const FEEDBACK_DRAFT_KEY = 'fish:feedback:draft'

export function isFeedbackTypeKey(value: unknown): value is FeedbackTypeKey {
  return typeof value === 'string' && (FEEDBACK_TYPE_KEYS as readonly string[]).includes(value)
}

/**
 * 把 `Taro.getStorageSync` 拿到的原始值解析成草稿；**任何一步不对都返回 `null`**。
 *
 * - `string` 与对象两种形态都要认：小程序端 `getStorageSync` 直接返回对象，
 *   H5（预览壳）返回 JSON 字符串；
 * - 单个字段坏掉只丢弃那一个字段（取默认值），不整份丢掉 —— 用户已经写下的正文比类型选择值钱；
 * - **空草稿也算 `null`**：三个字段都空时不该弹「已恢复上次未提交的内容」打扰用户
 *   （稿 `restoreFromDraft` 的同一判据）；
 * - 存储里是坏 JSON / 非对象时返回 `null`，不抛。
 */
export function parseFeedbackDraft(raw: unknown): FeedbackDraft | null {
  try {
    const data: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
    const rec = data as Record<string, unknown>
    const draft: FeedbackDraft = {
      type: isFeedbackTypeKey(rec.type) ? rec.type : '',
      desc: typeof rec.desc === 'string' ? rec.desc : '',
      contact: typeof rec.contact === 'string' ? rec.contact : '',
    }
    return draft.type === '' && draft.desc === '' && draft.contact === '' ? null : draft
  } catch {
    return null
  }
}
