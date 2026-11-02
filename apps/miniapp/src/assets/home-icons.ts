/**
 * 首页分类横滑的图标表。
 *
 * 图标真源是 `tools/icons/glyphs/cat-*.svg`（8 个一级分类字形，品牌蓝单色），
 * 由 `tools/icons/build.ts` 出图，经 `@/assets/lib-icons` 统一出口。
 *
 * 映射说明：设计稿的分类是「推荐 / 教材书籍 / 数码电子 / 代步出行 / 宿舍好物 / 运动户外 /
 * 服饰鞋包 / 美妆洗护」，字形依次是 皇冠 / 书 / 耳机 / 自行车 / 水杯 / 哑铃 / T 恤 / 口红，
 * 「其他闲置」是礼物盒。
 */
import { ICONS } from '@/assets/lib-icons'
import type { ListingCategory } from '@/mock/types'

export const HOME_CATEGORY_ICONS: Record<ListingCategory | 'ALL', string> & { camera: string } = {
  ALL: ICONS.crownBrand,
  BOOKS: ICONS.catBooksBrand,
  DIGITAL: ICONS.catDigitalBrand,
  TRANSPORT: ICONS.catTransportBrand,
  DAILY: ICONS.catDailyBrand,
  SPORTS: ICONS.catSportsBrand,
  APPAREL: ICONS.catApparelBrand,
  BEAUTY: ICONS.catBeautyBrand,
  OTHER: ICONS.catOtherBrand,
  camera: ICONS.cameraMuted,
}
