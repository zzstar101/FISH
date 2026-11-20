/**
 * 认证徽章资产出口（#534）。页面与组件只从这里取，不直接 import png。
 *
 * 与 `@/assets/lib-icons` 的分工：
 * - `lib-icons` 是**单色语义图标**：字形 × 语义色，由 `tools/icons/build.ts` 从 SVG 生成，
 *   显示尺寸只走 24/32/40/48 的正方形四档，清单外的文件会被生成器删掉；
 * - 这里是**多色横向成品图**（设计稿「认证」3D 徽章整图，比例 3:1），既不是语义色图标、
 *   也不由图标生成器产出 —— 所以独立目录 + 独立出口，**不要**登记进
 *   `tools/icons/manifest.ts`（那边的生成器按清单删除目录外的文件）。
 *
 * 校园认证徽章来自 #687 确认的设计稿（母版 2172×724，宽高比 3:1），由
 * `tools/artwork/build.ts` 按显示尺寸出图（产物 153×51 = 102×34rpx × 1.5）——
 * 别把母版分辨率直接入库：单张 1016 KB 会顶穿小程序主包 2MB 上限。
 * 个人页按 102×34 显示，行内按 72×24 显示，使用 aspectFit 保持比例。
 *
 * **换图必须找 Owner 出手稿重出母版**（`tools/artwork/badge-master.png`），再跑
 * `bun run --filter @fish/miniapp artwork`；手改产物 png 会让 CI 的重跑校验转红。
 * 设计图及来源见 Issue #687；更新资源时同步更新尺寸和一致性测试。
 */
import verifiedBadge from './verified-badge@3x.png'

export type BadgeName = 'verified'

export const BADGE: Readonly<Record<BadgeName, string>> = {
  verified: verifiedBadge,
}
