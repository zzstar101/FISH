import type { ListingCategory, ListingCondition } from '@fish/contracts/listings/schema'

/**
 * 契约枚举 → 界面文案的映射。
 *
 * API 侧（#6 冻结契约）只传输枚举值；中文文案是前端展示层的事。
 * 两张映射表都以枚举为键：查不到时回退到枚举原值，宁可显示 `BOOKS`
 * 也不能显示 `undefined`。
 */

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

export const CONDITION_LABEL: Record<ListingCondition, string> = {
  NEW: '全新',
  LIKE_NEW: '99新',
  GOOD: '9成新',
  FAIR: '8成新',
}

export function categoryLabel(category: ListingCategory): string {
  return CATEGORY_LABEL[category] ?? category
}

export function conditionLabel(condition: ListingCondition): string {
  return CONDITION_LABEL[condition] ?? condition
}

/** 分类页导航的 id（路由参数）→ 契约枚举；顺序与首页快捷入口一致。 */
export const CATEGORY_IDS: Record<string, ListingCategory> = {
  digital: 'DIGITAL',
  books: 'BOOKS',
  daily: 'DAILY',
  apparel: 'APPAREL',
  sports: 'SPORTS',
  transport: 'TRANSPORT',
  beauty: 'BEAUTY',
  other: 'OTHER',
}
