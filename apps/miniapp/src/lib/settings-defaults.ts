/**
 * 设置页的默认值（`SETTINGS`）。
 *
 * 放在 `@/lib` 而不是 `@/mock/*`：设置页运行期就要用这份数据，不该为了它
 * 静态 import 整包 fixture（`mock/account.ts` 仍 re-export，既有路径可用）。
 * 这里只 `import type`，不会把任何 mock 运行期模块拖进生产包。
 *
 * 历史上这里还有主题三档（`THEME_OPTIONS` / `theme` 字段）—— 该开关从未有过
 * 消费方（暗色主题未实现），2026-10-05 按 Owner 拍板整组撤掉，需求单另行跟踪。
 */
import type { MockSettings } from '@/mock/types'

export const SETTINGS: MockSettings = {
  notifyChat: true,
  notifyWish: true,
  notifyDeal: true,
  notifyNews: false,
  commentPolicy: '已认证用户',
}

// 页面侧的名字（与 `@/mock/api` 既有调用形态一致）：同一份数据，两种命名。
// 设置页只需要从这里 import，不必再为了这份数据静态拉进整包 fixture。

/** 设置页取默认值（原来是 `@/mock/api` 的同名函数）。 */
export function settings(): MockSettings {
  return SETTINGS
}
