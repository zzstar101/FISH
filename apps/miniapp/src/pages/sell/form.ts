/**
 * 发布页的纯判定（无 Taro、无 mock 依赖：`tests/sell-form.test.ts` 直接 import）。
 *
 * 这里只放**屏幕该显示什么**与**该发什么字段**的判定，不放网络调用：
 * 「本地校验」「服务端 BLOCK 的字段级错误落位」「提交后落地」三件事各有明确口径，
 * 混在组件里就只能靠人肉 review 保证（与 `pages/home/list-state.ts` 同一取舍）。
 */
import type { ListingCategory, ListingModerationStatus } from '@fish/contracts/listings/schema'

/** 发布页的字段级错误。键与页面输入区一一对应。 */
export type SellFieldErrors = Partial<
  Record<'title' | 'description' | 'images' | 'price' | 'category', string>
>

/** 整数或最多两位小数，避免 `Number('abc')` 变成 NaN 后提交出 `NaN` 分。 */
const PRICE_PATTERN = /^\d+(\.\d{1,2})?$/

/**
 * 价格字符串 → 整数分。
 *
 * `free`（0 元送）恒为 0：契约 `ListingCreateInputSchema` 的单向约束要求
 * 「勾了 0 元送 ⟹ priceCents === 0」，页面上价格框此时是锁定的，不该再读它的值。
 */
export function parsePriceToCents(price: string, free: boolean): number | null {
  if (free) return 0
  const trimmed = price.trim()
  if (!PRICE_PATTERN.test(trimmed)) return null
  return Math.round(Number(trimmed) * 100)
}

/**
 * 提交前的本地校验，返回**第一条**错误文案（页面用 toast 展示）。
 * 服务端仍会独立校验一遍：这里只是少打一次注定失败的请求。
 */
export function validateSellForm(input: {
  title: string
  description: string
  priceCents: number | null
  category: ListingCategory | null
  imageCount: number
}): string | null {
  if (input.title.trim().length < 2) return '标题至少 2 个字'
  if (input.description.trim().length < 1) return '请填写描述'
  if (input.priceCents === null) return '请填写正确价格'
  if (!input.category) return '请选择分类'
  if (input.imageCount < 1) return '至少上传 1 张图片'
  return null
}

/**
 * 服务端 `error.details` → 发布页字段级错误（#74）。
 *
 * 契约的 `field` 是输入 schema 的字段名，与页面的输入区不是一一对应：
 * `objectKeys` 对应图片区、`priceCents` 对应价格。认不出的字段直接丢弃（不猜），
 * 页面另有整块提示条兜底。**同字段只留第一条**：一屏展示多条会互相打架。
 */
export function sellFieldErrorsFromDetails(
  details: readonly { field: string; message: string }[] | undefined,
): SellFieldErrors {
  const errors: SellFieldErrors = {}
  for (const detail of details ?? []) {
    let key: keyof SellFieldErrors | null = null
    if (detail.field === 'title' || detail.field === 'description') key = detail.field
    else if (detail.field === 'priceCents') key = 'price'
    else if (detail.field === 'objectKeys') key = 'images'
    if (key === null) continue
    if (errors[key] === undefined) errors[key] = detail.message
  }
  return errors
}

/**
 * BLOCK 的页头提示文案。
 *
 * **点名字段**（「描述中有违规内容」）而不是只给计数：用户要知道的是「改哪里」，
 * 「N 处需要修改」对他是零信息量，还得自己把两个输入框来回扫一遍。
 * 两个内容字段都命中时说「标题和描述中有违规内容」；都认不出来时退到通用文案。
 */
export function sellBlockMessage(errors: SellFieldErrors): string {
  const hit = (['title', 'description'] as const).filter((key) => errors[key] !== undefined)
  if (hit.length === 2) return '标题和描述中有违规内容'
  if (hit.length === 1) return hit[0] === 'title' ? '标题中有违规内容' : '描述中有违规内容'
  return '商品内容未通过审核'
}

/**
 * 提交中遮罩的文案。
 *
 * 图片是**选中即上传**的，提交阶段只剩一次 create / PATCH 请求：
 * 这里不再有「上传第几张」的分支，只区分保存与发布。
 */
export function sellBusyText(input: { editing: boolean }): string {
  return input.editing ? '正在保存…' : '正在发布…'
}

/**
 * 提交成功后的落地判定。
 *
 * `moderationStatus === 'REVIEW'` 表示**已受理但商品是 OFFLINE、不在公开列表**：
 * 这种情况必须留在发布页说「已提交审核」，不能跳详情让人以为已经公开，也不能
 * 显示「发布成功」。其余（ALLOW / 编辑后 APPROVED）跳商品详情。
 *
 * 只在**本人视角**的响应上成立：公开/他人视角该字段恒 `null`，而发布/编辑响应的
 * `viewerId` 就是本人（`isOwner = true`）。
 */
export function sellSubmitOutcome(detail: {
  moderationStatus: ListingModerationStatus | null
}): 'pending-review' | 'detail' {
  return detail.moderationStatus === 'REVIEW' ? 'pending-review' : 'detail'
}
