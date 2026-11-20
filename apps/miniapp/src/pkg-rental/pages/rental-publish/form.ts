/**
 * 出租发布页的纯判定（无 Taro、无网络依赖，测试可直接 import）。
 *
 * 与 `pages/sell/form.ts` 同一取舍：只放「屏幕该显示什么」与「该发什么字段」，
 * 网络调用在 `features/rental/api.ts`。这样「本地校验」「服务端字段级错误落位」两件事
 * 都能被单测覆盖，不必读 1500 行的组件。
 */
import type { ListingCondition } from '@fish/contracts/listings/schema'
import { RENTAL_MAX_DAYS, RENTAL_MIN_DAYS } from '@fish/contracts/rentals/schema'

/** 字段级错误。键与页面输入区一一对应（`objectKeys` 对应图片区，与契约字段名一致）。 */
export type RentalFieldErrors = Partial<
  Record<
    'title' | 'description' | 'images' | 'dailyPrice' | 'deposit' | 'rules' | 'minDays' | 'maxDays',
    string
  >
>

/** 整数或最多两位小数，避免 `Number('abc')` 变 NaN 后提交出 `NaN` 分。 */
const MONEY_PATTERN = /^\d+(\.\d{1,2})?$/

/**
 * 金额字符串 → 整数分。空串 / 非法格式返回 `null`。
 *
 * 押金允许 0（不收押金），所以这里不能用「0 视为未填」的判据 —— 调用方靠 `null` 区分。
 */
export function parseMoneyToCents(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (!MONEY_PATTERN.test(trimmed)) return null
  return Math.round(Number(trimmed) * 100)
}

/** 天数输入 → 整数。空串 / 非正整数返回 `null`。 */
export function parseDays(value: string): number | null {
  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const days = Number(trimmed)
  return Number.isSafeInteger(days) && days > 0 ? days : null
}

/**
 * 提交前的本地校验，返回**第一条**错误（页面用 toast 展示）。
 *
 * 服务端仍会独立校验（契约 + service + DB CHECK 三层），这里只是少打一次注定失败的请求。
 * 顺序刻意与页面从上到下的字段顺序一致 —— 报第一个错才符合用户视线。
 */
export function validateRentalForm(input: {
  title: string
  description: string
  dailyPriceCents: number | null
  depositCents: number | null
  minDays: number | null
  maxDays: number | null
  imageCount: number
}): string | null {
  if (input.title.trim().length < 2) return '标题至少 2 个字'
  if (input.description.trim().length < 1) return '请填写描述'
  if (input.imageCount < 1) return '至少上传 1 张图片'
  if (input.dailyPriceCents === null || input.dailyPriceCents <= 0) return '请填写正确的日租价'
  if (input.depositCents === null) return '请填写押金（不收押金填 0）'
  if (input.minDays === null) return '请填写最短租期'
  if (input.maxDays === null) return '请填写最长租期'
  if (input.minDays < RENTAL_MIN_DAYS) return `最短租期不得少于 ${RENTAL_MIN_DAYS} 天`
  if (input.maxDays > RENTAL_MAX_DAYS) return `最长租期不得超过 ${RENTAL_MAX_DAYS} 天`
  if (input.maxDays < input.minDays) return '最长租期不能短于最短租期'
  return null
}

/**
 * 服务端 `error.details` → 出租发布页字段级错误。
 *
 * 契约的 `field` 是输入 schema 的字段名；`objectKeys` 对应图片区、`dailyPriceCents`
 * 对应日租价输入框。认不出的字段直接丢弃（不猜），页面另有整块提示条兜底。
 * **同字段只留第一条**：一屏多条会互相打架。
 */
export function fieldErrorsFromDetails(
  details: readonly { field?: string; message: string }[] | undefined,
): RentalFieldErrors {
  const errors: RentalFieldErrors = {}
  for (const detail of details ?? []) {
    const field = detail.field
    if (!field) continue
    const key = FIELD_ALIASES[field]
    if (!key || errors[key]) continue
    errors[key] = detail.message
  }
  return errors
}

/** 契约字段名 → 页面字段。没有映射的字段（例如 `condition`）不落位到任何输入框。 */
const FIELD_ALIASES: Record<string, keyof RentalFieldErrors | undefined> = {
  title: 'title',
  description: 'description',
  objectKeys: 'images',
  dailyPriceCents: 'dailyPrice',
  depositCents: 'deposit',
  rules: 'rules',
  minDays: 'minDays',
  maxDays: 'maxDays',
}

/**
 * 出租发布是否被资格门挡住（403 `RENTAL_NOT_ELIGIBLE`）。
 *
 * 单独抽出来是因为页面要对它做**不同的**事：不是「改表单」，而是引导去教育邮箱认证。
 * 与其它 403（治理限制 / 未绑手机号）区分开，后两者各有自己的文案。
 */
export function isRentalEligibilityError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { status?: unknown; code?: unknown }
  return candidate.status === 403 && candidate.code === 'RENTAL_NOT_ELIGIBLE'
}

/** 出租发布的服务端拒绝文案（按错误码给固定说法，不透传服务端 message）。 */
export function rentalPublishErrorText(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  switch (code) {
    case 'RENTAL_NOT_ELIGIBLE':
      return '发布出租需先完成教育邮箱认证'
    case 'RENTAL_CONTENT_BLOCKED':
      return '内容未通过审核，请修改后重试'
    case 'PHONE_REQUIRED':
      return '发布前请先绑定手机号'
    case 'USER_RESTRICTED':
      return '账号被限制发布，暂不能发布出租'
    case 'VALIDATION_FAILED':
      return '填写内容有误，请检查后重试'
    default:
      return '发布失败，请稍后重试'
  }
}

/** 表单默认值（新建态）。 */
export const RENTAL_FORM_DEFAULTS = {
  title: '',
  description: '',
  dailyPrice: '',
  deposit: '',
  rules: '',
  minDays: String(RENTAL_MIN_DAYS),
  maxDays: '7',
  condition: 'GOOD' as ListingCondition,
} as const
