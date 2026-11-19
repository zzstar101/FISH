/**
 * 认证徽章资产出口（#534）。页面与组件只从这里取，不直接 import png。
 *
 * 与 `@/assets/lib-icons` 的分工：
 * - `lib-icons` 是**单色语义图标**：字形 × 语义色，由 `tools/icons/build.ts` 从 SVG 生成，
 *   显示尺寸只走 24/32/40/48 的正方形四档，清单外的文件会被生成器删掉；
 * - 这里是多色横向成品图，独立于图标生成器。
 *
 * 校园认证徽章来自 #687 确认的设计稿（2172×724，宽高比 3:1）。
 * 个人页按 102×34 显示，行内按 72×24 显示，使用 aspectFit 保持比例。
 * 设计图及来源见 Issue #687；更新资源时同步更新尺寸和一致性测试。
 */
import verifiedBadge from './verified-badge@3x.png'

export type BadgeName = 'verified'

export const BADGE: Readonly<Record<BadgeName, string>> = {
  verified: verifiedBadge,
}
