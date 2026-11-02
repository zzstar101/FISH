/**
 * 认证徽章资产出口（#534）。页面与组件只从这里取，不直接 import png。
 *
 * 与 `@/assets/lib-icons` 的分工：
 * - `lib-icons` 是**单色语义图标**：字形 × 语义色，由 `tools/icons/build.ts` 从 SVG 生成，
 *   显示尺寸只走 24/32/40/48 的正方形四档，清单外的文件会被生成器删掉；
 * - 这里是**多色横向成品图**（设计稿「认证」3D 徽章整图，275×108，比例 2.546），既不是
 *   语义色图标、也不由生成器产出 —— 所以独立目录 + 独立出口，**不要**登记进
 *   `tools/icons/manifest.ts`（那边的生成器按清单删除目录外的文件）。
 *
 * 显示尺寸按原图比例缩放（高度压在昵称字号之下）：我的页 87×34、详情卖家行 / 订单卡 61×24。
 * 交付的是设计稿原始像素，不做重采样 —— 换图请找设计稿原图，不要缩图后覆盖。
 */
import verifiedBadge from './verified-badge@3x.png'

export type BadgeName = 'verified'

export const BADGE: Readonly<Record<BadgeName, string>> = {
  verified: verifiedBadge,
}
