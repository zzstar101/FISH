/**
 * 品牌资产唯一出口（#513）：页面只从这里取，不直接 import png。
 *
 * 四张图都由 `tools/brand/build.ts` 从唯一母版 `tools/brand/lockup-master.png` 派生
 * （`bun run --filter @fish/miniapp brand`），不要手改或另存新图。
 * - `lockup`：鱼形标 + 「鱼小应 / YUXIAOYING」横排（首页顶栏、我的页脚）
 * - `mark`：鱼形标（登录页、关于页）
 * - `wordmark`：「鱼小应 / YUXIAOYING」（登录页）
 * - `share`：5:4 分享封面（首页 `useShareAppMessage` 的 `imageUrl`）
 */
import lockup from './lockup.png'
import mark from './mark.png'
import share from './share.png'
import wordmark from './wordmark.png'

export const BRAND: Readonly<Record<'lockup' | 'mark' | 'wordmark' | 'share', string>> = {
  lockup,
  mark,
  wordmark,
  share,
}
