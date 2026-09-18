/**
 * 首页分类横滑的图标表。
 *
 * 图标来自 `D:\index\组件库\SVG图标库` 的「02-商品一级分类」组（8 个矢量图标），
 * 由 `D:\FISH\miniprogram\tools\build-lib-icons.mjs` 光栅化，经 `@/assets/lib-icons` 统一出口。
 *
 * 映射说明：设计稿的分类是「推荐 / 教材书籍 / 数码电子 / 代步出行 / 宿舍好物 / 运动户外 /
 * 服饰鞋包 / 美妆洗护」，图标库的一级分类是「教材书籍 / 数码电子 / 生活用品 / 服装鞋包 /
 * 运动健身 / 代步工具 / 美妆个护 / 其他闲置」——语义一一对应，只有措辞不同。
 */
import { ICONS } from '@/assets/lib-icons'
import type { ListingCategory } from '@/mock/types'

export const HOME_CATEGORY_ICONS: Record<ListingCategory | 'ALL', string> & { camera: string } = {
  ALL: ICONS.rank,
  BOOKS: ICONS.catBooks,
  DIGITAL: ICONS.catDigital,
  TRANSPORT: ICONS.catTransport,
  DAILY: ICONS.catDaily,
  SPORTS: ICONS.catSports,
  APPAREL: ICONS.catApparel,
  BEAUTY: ICONS.catBeauty,
  OTHER: ICONS.catOther,
  camera: ICONS.camera,
}
