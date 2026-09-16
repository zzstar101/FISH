/**
 * 演示用图片资源表（单色图块版）。
 *
 * 历史：这里曾 import 80 张 JPEG（合计 2.45MB），导致 miniapp 主包 2.93MB、
 * 超过微信主包 2MB 上限而无法上传。现改为**单色图块**：
 * 全部用 1×1 纯色 PNG 的 data URI（见 `./blocks.ts`），磁盘上零图片文件。
 *
 * 为什么 data URI 而不是「生成 80 张小 PNG」：
 *   `<Image src>` 支持 base64 data URI，配 `mode="aspectFill"` 即纯色块；
 *   好处是不产生任何图片文件、不依赖打包器处理、不占包体。
 *   颜色取自 `src/styles/_tokens.scss` 品牌色系，未新增色值（DESIGN.md 硬约束）。
 *
 * 与真实数据的边界：这些只是**演示占位**。接真实 API 后
 * `coverUrl` / `avatarUrl` 会来自服务端，本文件随之退役。
 *
 * 生成器：`D:\FISH\miniprogram\tools\build-color-blocks.mjs`
 */
import { AVATAR_BLOCKS, LISTING_BLOCKS } from './blocks'

/**
 * 商品 slug -> 分类。用于把 fixture 里的商品映射到对应分类的色块，
 * 而不是「所有商品一个色」——保住瀑布流的视觉层次。
 */
const SLUG_CATEGORY: Record<string, string> = {
  'apparel-handbag': 'APPAREL',
  'apparel-jacket': 'APPAREL',
  'apparel-sneaker': 'APPAREL',
  'beauty-cosmetic': 'BEAUTY',
  'beauty-perfume': 'BEAUTY',
  'beauty-skincare': 'BEAUTY',
  'books-comic': 'BOOKS',
  'books-novel': 'BOOKS',
  'books-textbook': 'BOOKS',
  'daily-backpack': 'DAILY',
  'daily-desklamp': 'DAILY',
  'daily-kettle': 'DAILY',
  'digital-headphone': 'DIGITAL',
  'digital-laptop': 'DIGITAL',
  'digital-phone': 'DIGITAL',
  'other-boardgame': 'OTHER',
  'other-guitar': 'OTHER',
  'other-plush': 'OTHER',
  'sports-basketball': 'SPORTS',
  'sports-dumbbell': 'SPORTS',
  'sports-yogamat': 'SPORTS',
  'transport-bicycle': 'TRANSPORT',
  'transport-helmet': 'TRANSPORT',
  'transport-scooter': 'TRANSPORT',
}

/** 兜底色块（slug 未登记时用）；用非空断言是因为 blocks.ts 由生成器保证有 OTHER 键 */
const FALLBACK = LISTING_BLOCKS.OTHER as [string, string, string]

/** 商品图：slug -> 3 张（下标 0 = 封面，同一商品用 3 档明度） */
export const PRODUCT_IMAGES: Record<string, [string, string, string]> = Object.fromEntries(
  Object.keys(SLUG_CATEGORY).map((slug) => {
    const cat = SLUG_CATEGORY[slug] as string
    return [slug, (LISTING_BLOCKS[cat] ?? FALLBACK) as [string, string, string]]
  }),
)

/** 头像 8 张，按用户顺序分配 */
export const AVATARS: string[] = AVATAR_BLOCKS

/** 取某商品第 index 张图（缺省封面；越界回落到封面） */
export function productImage(slug: string, index = 0): string {
  const set = PRODUCT_IMAGES[slug]
  if (!set) return FALLBACK[0]
  return set[index] ?? set[0]
}
