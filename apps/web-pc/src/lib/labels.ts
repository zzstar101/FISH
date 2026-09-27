import type { ListingCategory } from '@fish/contracts/listings/schema'

/** 契约枚举 → 界面文案。查不到时回退到枚举原值，避免渲染 `undefined`。 */
export const CATEGORY_LABEL: Record<ListingCategory, string> = {
  DIGITAL: '数码电子',
  BOOKS: '图书教材',
  BEAUTY: '美妆个护',
  DAILY: '生活用品',
  SPORTS: '运动健身',
  APPAREL: '服饰鞋包',
  TRANSPORT: '代步工具',
  OTHER: '其他闲置',
}

export function categoryLabel(category: ListingCategory): string {
  return CATEGORY_LABEL[category] ?? category
}
