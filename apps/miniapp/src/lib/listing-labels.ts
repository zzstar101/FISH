/**
 * 商品分类 / 成色的**纯展示文案**（零 fixture 依赖）。
 *
 * 为什么从 `mock/api.ts` 挪出来：首页、商品卡、我的发布这些真实页面只需要一张
 * 「DIGITAL → 数码电子」的映射表，而 `@/mock/api` 会把整包 fixture（catalog / chat /
 * account / contracts 的匹配阈值…）静态拖进它们的模块图。演示构建下那还只是浪费，
 * 真实构建（`__ALLOW_MOCK_FALLBACK__=false`）里则是**冷启动白跑**——首屏 JS 求值里
 * 约九成花在 mock 子图上。
 *
 * 只依赖 `@fish/contracts` 的**类型**（编译期擦除），运行时是纯常量与纯函数。
 * `mock/api.ts` 仍原样 re-export 这些名字，既有 `@/mock/api` 的 import 路径不受影响。
 */
import type { ListingCategory, ListingCondition } from '@fish/contracts/listings/schema'
import type { WishCategory } from '@fish/contracts/wishes/schema'

export const CATEGORY_LABEL: Record<ListingCategory, string> = {
  DIGITAL: '数码电子',
  BOOKS: '教材书籍',
  BEAUTY: '美妆洗护',
  DAILY: '宿舍好物',
  SPORTS: '运动户外',
  APPAREL: '服饰鞋包',
  TRANSPORT: '代步出行',
  OTHER: '其他闲置',
}

/** 设计稿顶部横滑分类（第一项是「推荐」= 全部） */
export const HOME_CATEGORIES: { key: ListingCategory | 'ALL'; label: string }[] = [
  { key: 'ALL', label: '推荐' },
  { key: 'BOOKS', label: '教材书籍' },
  { key: 'DIGITAL', label: '数码电子' },
  { key: 'TRANSPORT', label: '代步出行' },
  { key: 'DAILY', label: '宿舍好物' },
  { key: 'SPORTS', label: '运动户外' },
  { key: 'APPAREL', label: '服饰鞋包' },
  { key: 'BEAUTY', label: '美妆洗护' },
  { key: 'OTHER', label: '其他闲置' },
]

/**
 * 愿望分类的展示顺序：照契约 `wishCategorySchema` 的枚举顺序。
 *
 * 类型取契约的 `WishCategory` 而不是 `ListingCategory`：两者当前逐值相同，
 * 但语义上「许愿的分类」以 `wishes/schema.ts` 为准。
 */
export const WISH_CATEGORIES: WishCategory[] = [
  'DIGITAL',
  'BOOKS',
  'BEAUTY',
  'DAILY',
  'SPORTS',
  'APPAREL',
  'TRANSPORT',
  'OTHER',
]

export function categoryLabel(category: ListingCategory): string {
  return CATEGORY_LABEL[category]
}

export function conditionLabel(condition: ListingCondition): string {
  switch (condition) {
    case 'NEW':
      return '全新'
    case 'LIKE_NEW':
      return '九成新'
    case 'GOOD':
      return '八成新'
    default:
      return '七成新'
  }
}
