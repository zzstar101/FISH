import { productImage } from './images'
import type { ImageRatio, ListingCategory, ListingCondition, MockListing } from './types'

/**
 * 商品 fixture：24 条，与 `D:\FISH\mock-images` 的 24 组图一一对应
 * （每组 3 张，可当详情页轮播）。分页、搜索、分类过滤都由 `mock/api.ts` 在这份数组上做。
 *
 * 价格一律整数分。设计稿里出现的商品（K380 键盘 ¥160、山地车 ¥420、Kindle ¥330、
 * 吉他 ¥520、羽毛球拍 ¥95 …）优先复用设计稿原文，保证页面对得上稿。
 */

type Spec = {
  slug: string
  title: string
  /** 单位：元。内部会 ×100 成整数分 */
  price: number
  was?: number
  category: ListingCategory
  condition: ListingCondition
  sellerId: string
  ratio: ImageRatio
  badge?: string
  spec: string
  description: string
  views: number
  wants: number
  hoursAgo: number
  urgent?: boolean
  negotiable?: boolean
  free?: boolean
  status?: MockListing['status']
}

const HOUR = 3600 * 1000
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0)

const SPECS: Spec[] = [
  {
    slug: 'digital-headphone',
    title: '索尼 WH-1000XM4 头戴降噪耳机',
    price: 760,
    was: 1299,
    category: 'DIGITAL',
    condition: 'LIKE_NEW',
    sellerId: 'u-chengzi',
    ratio: '1x1',
    badge: '同校',
    spec: '黑色 · 主动降噪 · 附原装收纳盒',
    description:
      '去年双十一买的，通勤和自习室降噪效果很够用。耳罩无开裂、无掉皮，电池健康。因为换了 AirPods Max 所以出，可当面试听。',
    views: 218,
    wants: 34,
    hoursAgo: 2,
  },
  {
    slug: 'digital-laptop',
    title: '联想 ThinkPad X280 轻薄本 8G/256G',
    price: 1580,
    was: 4999,
    category: 'DIGITAL',
    condition: 'GOOD',
    sellerId: 'u-alan',
    ratio: '4x3',
    badge: '急出',
    spec: 'i5-8250U · 8G · 256G SSD · 12.5 寸',
    description:
      '毕业出，成色八五新，键盘无打油（ThinkPad 键盘手感依旧在线）。硬盘已换全新 NVMe，附原装电源适配器。可当面验机、跑分随便看。',
    views: 512,
    wants: 61,
    hoursAgo: 20,
    urgent: true,
    negotiable: true,
  },
  {
    slug: 'digital-phone',
    title: '小米 12 8+128 全网通 成色好',
    price: 890,
    was: 3699,
    category: 'DIGITAL',
    condition: 'GOOD',
    sellerId: 'u-qiqi',
    ratio: '5x6',
    spec: '8+128G · 蓝色 · 无维修史',
    description:
      '自用机，一直戴壳贴膜，屏幕无划痕、无烧屏。电池健康 89%，日常一天一充没问题。附原装充电头和数据线。',
    views: 336,
    wants: 42,
    hoursAgo: 30,
  },
  {
    slug: 'books-textbook',
    title: '高等数学 同济第七版 上下册',
    price: 45,
    was: 89,
    category: 'BOOKS',
    condition: 'LIKE_NEW',
    sellerId: 'u-susu',
    ratio: '4x5',
    badge: '全新',
    spec: '上下册 · 少量笔记 · 含习题解答',
    description:
      '大一时买的，翻过前四章，后面几乎全新。笔记用铅笔写的，可以擦掉。附赠一本习题全解。考研的同学直接拿走更划算。',
    views: 164,
    wants: 28,
    hoursAgo: 5,
  },
  {
    slug: 'books-novel',
    title: '东野圭吾小说合集 共 6 本',
    price: 78,
    was: 180,
    category: 'BOOKS',
    condition: 'GOOD',
    sellerId: 'u-zhou',
    ratio: '1x1',
    spec: '6 本 · 无缺页 · 书脊完好',
    description:
      '《白夜行》《嫌疑人 X 的献身》《解忧杂货店》等 6 本，全部正版。宿舍搬家清书架，打包出更便宜。',
    views: 121,
    wants: 19,
    hoursAgo: 9,
  },
  {
    slug: 'books-comic',
    title: '灌篮高手 完全版 1-24 全集',
    price: 460,
    was: 780,
    category: 'BOOKS',
    condition: 'LIKE_NEW',
    sellerId: 'u-chengzi',
    ratio: '3x4',
    spec: '24 册全 · 带函套 · 无泛黄',
    description:
      '当年一本一本收齐的完全版，函套都在。看过一遍就上架，内页干净无笔记。整套出，单本不拆。',
    views: 288,
    wants: 37,
    hoursAgo: 44,
  },
  {
    slug: 'daily-desklamp',
    title: '米家台灯 Pro 护眼版',
    price: 120,
    was: 249,
    category: 'DAILY',
    condition: 'LIKE_NEW',
    sellerId: 'u-chengzi',
    ratio: '5x6',
    badge: '同栋',
    spec: '三档调光 · USB 供电 · 无线控',
    description: '宿舍用了半个学期，三档色温都能用，无频闪不刺眼。因为换了床头灯所以出，宿舍自提。',
    views: 96,
    wants: 12,
    hoursAgo: 3,
  },
  {
    slug: 'daily-kettle',
    title: '宿舍电热水壶 1.5L 保温款',
    price: 55,
    was: 129,
    category: 'DAILY',
    condition: 'GOOD',
    sellerId: 'u-xiaobei',
    ratio: '4x5',
    spec: '1.5L · 304 内胆 · 自动断电',
    description:
      '烧水快，保温能撑一晚上。内胆无水垢（一直用净水），自动断电正常。毕业清宿舍，便宜出。',
    views: 74,
    wants: 9,
    hoursAgo: 26,
  },
  {
    slug: 'daily-backpack',
    title: '双肩背包 大容量 通勤上课',
    price: 88,
    was: 199,
    category: 'DAILY',
    condition: 'LIKE_NEW',
    sellerId: 'u-linyi',
    ratio: '1x1',
    spec: '30L · 带笔记本隔层 · 防泼水',
    description: '能塞下 16 寸笔记本 + 两本教材 + 水杯。背过一次长途，肩带没有变形。拉链顺滑。',
    views: 143,
    wants: 16,
    hoursAgo: 12,
  },
  {
    slug: 'transport-bicycle',
    title: '捷安特 ATX 山地车 27.5 寸',
    price: 420,
    was: 1580,
    category: 'TRANSPORT',
    condition: 'GOOD',
    sellerId: 'u-chengzi',
    ratio: '5x6',
    badge: '急出',
    spec: '27.5 寸 · 21 速 · 刚换链条',
    description:
      '骑了两年，刚在车店换过链条和刹车皮，变速顺畅。车锁和尾灯一起送。因为要搬出校区所以急出，可小刀。',
    views: 407,
    wants: 58,
    hoursAgo: 7,
    urgent: true,
    negotiable: true,
  },
  {
    slug: 'transport-scooter',
    title: '九号电动滑板车 续航 30km',
    price: 1150,
    was: 2299,
    category: 'TRANSPORT',
    condition: 'LIKE_NEW',
    sellerId: 'u-qiqi',
    ratio: '4x3',
    spec: '续航 30km · 最高 25km/h · 可折叠',
    description:
      '校区到地铁站代步神器，折叠后能进电梯。电池循环次数少，实测续航 27km 左右。附原装充电器。',
    views: 265,
    wants: 31,
    hoursAgo: 52,
  },
  {
    slug: 'transport-helmet',
    title: '电动车头盔 3C 认证 带护目镜',
    price: 45,
    was: 129,
    category: 'TRANSPORT',
    condition: 'LIKE_NEW',
    sellerId: 'u-alan',
    ratio: '1x1',
    spec: 'L 码 · 3C 认证 · 内衬可拆洗',
    description: '买重复了，全新未拆封，吊牌还在。3C 认证标志齐全，内衬可以拆下来洗。',
    views: 58,
    wants: 6,
    hoursAgo: 15,
  },
  {
    slug: 'sports-basketball',
    title: '斯伯丁篮球 7 号 室内外通用',
    price: 89,
    was: 219,
    category: 'SPORTS',
    condition: 'GOOD',
    sellerId: 'u-zhou',
    ratio: '1x1',
    spec: '7 号 · PU 材质 · 附打气筒',
    description: '塑胶场地打过十来次，纹路还很清楚，不滑手。送一个打气筒和气针。',
    views: 87,
    wants: 11,
    hoursAgo: 33,
  },
  {
    slug: 'sports-dumbbell',
    title: '可调节哑铃 20kg 一对',
    price: 180,
    was: 399,
    category: 'SPORTS',
    condition: 'GOOD',
    sellerId: 'u-xiaobei',
    ratio: '4x5',
    spec: '20kg ×2 · 包胶片 · 可加减配重',
    description:
      '宿舍健身用，包胶片落地声音小。配重片齐全（每只 2.5kg 到 10kg 可调）。太重不邮寄，只校区自提。',
    views: 132,
    wants: 21,
    hoursAgo: 60,
  },
  {
    slug: 'sports-yogamat',
    title: '加厚瑜伽垫 10mm 防滑',
    price: 39,
    was: 99,
    category: 'SPORTS',
    condition: 'LIKE_NEW',
    sellerId: 'u-susu',
    ratio: '3x4',
    spec: '183×61cm · 10mm · 附背带',
    description: '买了想练但没坚持下来（笑）。擦干净收在袋子里，无异味。附收纳背带。',
    views: 63,
    wants: 8,
    hoursAgo: 18,
  },
  {
    slug: 'other-guitar',
    title: '雅马哈 F310 民谣吉他 41 寸',
    price: 520,
    was: 999,
    category: 'OTHER',
    condition: 'LIKE_NEW',
    sellerId: 'u-xiaobei',
    ratio: '1x1',
    spec: '41 寸 · 附琴包 · 琴弦刚换',
    description:
      '入门神琴，手感弦距已经调过，新手不会按得手疼。琴弦刚换了一套达达里奥。附琴包、变调夹、拨片。',
    views: 205,
    wants: 24,
    hoursAgo: 40,
  },
  {
    slug: 'other-boardgame',
    title: '桌游 狼人杀 / 大富翁 组合出',
    price: 68,
    was: 168,
    category: 'OTHER',
    condition: 'GOOD',
    sellerId: 'u-linyi',
    ratio: '4x5',
    spec: '2 套 · 卡牌齐全 · 无缺件',
    description: '社团活动玩过几次，卡牌齐全无缺件。两套一起打包，宿舍聚会刚好用得上。',
    views: 79,
    wants: 13,
    hoursAgo: 28,
  },
  {
    slug: 'other-plush',
    title: '宜家小熊玩偶 60cm 干净',
    price: 45,
    was: 129,
    category: 'OTHER',
    condition: 'LIKE_NEW',
    sellerId: 'u-soda',
    ratio: '1x1',
    spec: '60cm · 可机洗 · 无异味',
    description: '抓娃娃机的战利品，一直放在床上当靠枕。洗过一次，干净无破损。',
    views: 52,
    wants: 7,
    hoursAgo: 21,
  },
  {
    slug: 'apparel-sneaker',
    title: '耐克 Air Force 1 白 42 码',
    price: 260,
    was: 799,
    category: 'APPAREL',
    condition: 'GOOD',
    sellerId: 'u-qiqi',
    ratio: '4x5',
    badge: '同校',
    spec: '42 码 · 白色 · 鞋底磨损轻微',
    description:
      '穿了不到十次，中底没发黄，鞋盒还在。鞋底有轻微磨损（见图 3）。因为买大了一码所以出，可以当面试穿。',
    views: 189,
    wants: 26,
    hoursAgo: 6,
  },
  {
    slug: 'apparel-jacket',
    title: '冲锋衣 男 L 码 三合一',
    price: 320,
    was: 899,
    category: 'APPAREL',
    condition: 'LIKE_NEW',
    sellerId: 'u-alan',
    ratio: '3x4',
    spec: 'L 码 · 三合一 · 防水 5000mm',
    description: '冬天回家穿过两次，可拆内胆。防水涂层完好，拉链顺滑。衣长合适 175-180 穿。',
    views: 148,
    wants: 18,
    hoursAgo: 47,
  },
  {
    slug: 'apparel-handbag',
    title: '通勤单肩包 牛皮 米白色',
    price: 168,
    was: 499,
    category: 'APPAREL',
    condition: 'LIKE_NEW',
    sellerId: 'u-susu',
    ratio: '4x5',
    spec: '头层牛皮 · 可放 A4 · 米白',
    description: '容量能装下 A4 和 13 寸笔记本。皮面没有划痕，五金色泽很新。送一条可换肩带。',
    views: 111,
    wants: 15,
    hoursAgo: 36,
  },
  {
    slug: 'beauty-skincare',
    title: '兰蔻小黑瓶精华 50ml 全新未拆',
    price: 520,
    was: 1080,
    category: 'BEAUTY',
    condition: 'NEW',
    sellerId: 'u-soda',
    ratio: '4x5',
    badge: '全新',
    spec: '50ml · 全新未拆 · 有专柜小票',
    description: '生日礼物重复了，包装和封条都完整，未拆封。专柜小票在手，介意可当面对。',
    views: 97,
    wants: 14,
    hoursAgo: 11,
  },
  {
    slug: 'beauty-perfume',
    title: '祖玛珑蓝风铃 30ml 余量 80%',
    price: 380,
    was: 780,
    category: 'BEAUTY',
    condition: 'LIKE_NEW',
    sellerId: 'u-qiqi',
    ratio: '1x1',
    spec: '30ml · 余量约 80% · 无盒',
    description: '喷过十来次，余量还在瓶颈以上。味道是清新的蓝风铃，适合春夏。无外盒，介意勿拍。',
    views: 84,
    wants: 12,
    hoursAgo: 23,
  },
  {
    slug: 'beauty-cosmetic',
    title: '彩妆套装 唇釉 / 眼影 九成新',
    price: 96,
    was: 320,
    category: 'BEAUTY',
    condition: 'GOOD',
    sellerId: 'u-susu',
    ratio: '5x6',
    spec: '唇釉 3 支 · 眼影盘 1 个',
    description: '色号不合适所以转手，每样都只试过一次，已用酒精棉片擦拭过外壳。眼影盘刷子全新。',
    views: 66,
    wants: 9,
    hoursAgo: 55,
  },
  {
    slug: 'daily-desklamp',
    title: '米家台灯 Pro 护眼版 宿舍可用',
    price: 0,
    was: 169,
    category: 'DAILY',
    condition: 'GOOD',
    sellerId: 'u-linyi',
    ratio: '5x6',
    badge: '0元送',
    spec: '三档调光 · USB 供电 · 无频闪',
    description: '毕业清仓，0 元送，只求自提。灯是好的，三档都能用，USB 线有点旧但能用。',
    views: 231,
    wants: 47,
    hoursAgo: 4,
    free: true,
  },
]

/** 生成 ISO 时间（相对 NOW 往前推 hoursAgo 小时） */
function isoAt(hoursAgo: number): string {
  return new Date(NOW - hoursAgo * HOUR).toISOString()
}

export const LISTINGS: MockListing[] = SPECS.map((spec, index) => {
  const images = [0, 1, 2].map((i) => productImage(spec.slug, i)).filter((url) => url !== '')
  const cover = images[0] ?? ''
  return {
    id: `l-${String(index + 1).padStart(3, '0')}`,
    title: spec.title,
    priceCents: Math.round(spec.price * 100),
    originalPriceCents: spec.was === undefined ? null : Math.round(spec.was * 100),
    category: spec.category,
    condition: spec.condition,
    status: spec.status ?? 'ACTIVE',
    urgent: spec.urgent ?? false,
    negotiable: spec.negotiable ?? false,
    free: spec.free ?? false,
    coverUrl: cover,
    images,
    ratio: spec.ratio,
    badge: spec.badge ?? null,
    description: spec.description,
    spec: spec.spec,
    sellerId: spec.sellerId,
    views: spec.views,
    wants: spec.wants,
    createdHoursAgo: spec.hoursAgo,
    createdAt: isoAt(spec.hoursAgo),
  }
})

export const LISTING_BY_ID: Record<string, MockListing> = Object.fromEntries(
  LISTINGS.map((listing) => [listing.id, listing]),
)

export function getListing(id: string): MockListing | undefined {
  return LISTING_BY_ID[id]
}

/**
 * 「同校相似闲置」：同分类优先，不足用一种简单的稳定排序补齐（不与自身重复）。
 * 设计稿详情页底部就是这么一组 4 个卡片。
 */
export function similarListings(id: string, limit = 4): MockListing[] {
  const self = getListing(id)
  if (!self) return LISTINGS.slice(0, limit)
  const sameCategory = LISTINGS.filter((l) => l.id !== id && l.category === self.category)
  const others = LISTINGS.filter((l) => l.id !== id && l.category !== self.category)
  return [...sameCategory, ...others].slice(0, limit)
}
