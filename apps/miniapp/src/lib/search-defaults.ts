/**
 * 搜索页的默认文案数据（热门搜索 / 初始历史 / 筛选项 / 占位符）。
 *
 * 放在 `@/lib` 而不是 `@/mock/*`：这些是**页面运行期就要用的常量**，页面不该为了
 * 几行文案静态 import 整包 fixture（`mock/discover.ts` 仍 re-export，既有路径可用）。
 * 这里只 `import type`，不会把任何 mock 运行期模块拖进生产包。
 */
import type { HotSearchItem, SearchFilter } from '@/mock/types'

export const HOT_SEARCHES: HotSearchItem[] = [
  { term: '考研教材', count: 1284 },
  { term: '机械键盘', count: 976 },
  { term: '山地车', count: 812 },
  { term: 'Kindle', count: 604 },
  { term: '羽毛球拍', count: 537 },
  { term: '宿舍台灯', count: 449 },
  { term: '民谣吉他', count: 318 },
  { term: '无线鼠标', count: 276 },
]

/** 默认搜索历史（真实实现应持久化到 storage，这里给初始值） */
export const DEFAULT_SEARCH_HISTORY: string[] = [
  '机械键盘',
  '考研教材',
  '山地车',
  'Kindle',
  '羽毛球拍',
  '台灯',
]

export const SEARCH_FILTERS: SearchFilter[] = ['综合', '最新', '价格', '成色']

export const SEARCH_PLACEHOLDER = '搜索「机械键盘」「考研教材」'

// 页面侧的名字（与 `@/mock/api` 既有调用形态一致）：同一份数据，两种命名。
// 页面只需要从这里 import，不必再为了四行文案静态拉进整包 fixture。

/** 页面取热门搜索（原来是 `@/mock/api` 的同名函数）。 */
export function hotSearches(): HotSearchItem[] {
  return HOT_SEARCHES
}

export const searchFilters = SEARCH_FILTERS

export const searchPlaceholder = SEARCH_PLACEHOLDER

export const defaultSearchHistory = DEFAULT_SEARCH_HISTORY
