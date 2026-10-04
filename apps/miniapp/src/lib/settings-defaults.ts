/**
 * 设置页的默认值（`SETTINGS`）与主题选项（`THEME_OPTIONS`）。
 *
 * 放在 `@/lib` 而不是 `@/mock/*`：设置页运行期就要用这两份数据，不该为了它们
 * 静态 import 整包 fixture（`mock/account.ts` 仍 re-export，既有路径可用）。
 * 这里只 `import type`，不会把任何 mock 运行期模块拖进生产包。
 */
import type { MockSettings } from '@/mock/types'

export const SETTINGS: MockSettings = {
  theme: 'system',
  notifyChat: true,
  notifyWish: true,
  notifyDeal: true,
  notifyNews: false,
  commentPolicy: '已认证用户',
}

export const THEME_OPTIONS: { key: MockSettings['theme']; label: string; desc: string }[] = [
  { key: 'system', label: '跟随系统', desc: '随手机「深色模式」设置自动切换' },
  { key: 'light', label: '亮色', desc: '始终使用冰蓝亮色主题' },
  { key: 'dark', label: '暗色', desc: '始终使用深色主题，夜间浏览更省电' },
]

// 页面侧的名字（与 `@/mock/api` 既有调用形态一致）：同一份数据，两种命名。
// 设置页只需要从这里 import，不必再为了这两份数据静态拉进整包 fixture。

/** 设置页取默认值（原来是 `@/mock/api` 的同名函数）。 */
export function settings(): MockSettings {
  return SETTINGS
}

export const themeOptions = THEME_OPTIONS
