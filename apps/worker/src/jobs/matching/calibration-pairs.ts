// ---------------------------------------------------------------------------
// #322 M4 语义锚点重标定用的标注集（**已由 Owner 逐条审核并冻结**，57 条）。
//
// 背景：M3 的 `ranking-fixture.ts` 里 `similarity` 是"人估的真实模型 cos"，12 条样本据此
// 冻结了 FLOOR=0.5 / CEILING=0.95 与 S4 权重，得到 12/12 与人工判断一致。M4 用真实
// `text-embedding-v4` 复测同一批样本后：人估 0.86–0.93 ↔ 实测 0.28–0.67，一致度掉到 7/12
// （v1 基线 8/12），且锚点复估显示 CEILING=0.95 在真实分布上不可达（最高 0.8176）。
//
// 这份表解决的是"**用实测 cos 尺度重新定 anchor 与权重时，ground truth 是什么**"：
//   * Listing/Wish 事实（含分类、预算、acceptSimilar）为**产品语义**，与 M3 一致；
//   * `proposedExpectMatch` 是"这一对在产品上该不该成为有效匹配（score >= 70）"的标注，
//     由实现方给出理由、Owner 逐条裁决（4 条边界行按实现方倾向、其余 53 条同意）；
//   * 实测 cos 由 `bun run embed:eval -- --sections=calibration` 现场测量，不写进本文件
//     （避免把"人估"和"实测"混在一起——M3 踩过的就是这个坑）。
//
// 标签冻结后，参数修改的验收 = `--sections=calibration` 的一致度（现为 53/57，M3 旧参数 39/57）。
// 剩余 4 条标了 `knownDivergence`：结构特征相同而标签相反的可证冲突，或实测 cos 与标签相反，
// 参数不可弥补——它们不计入"参数一致度"，但标签一条都没改（见 M4 文档 §已知分歧）。
//
// 九类样本沿用 M3 的 `RankingSampleClass`，另加三类 M3 没覆盖的：
//   * `unlimited-category`：愿望不限分类（`category = null`，权重会按三维归一化）；
//   * `generic-keyword`：关键词是上位词/泛称（如"键盘"命中"罗技 K380 机械键盘"）；
//   * `boundary-variant`：同品牌不同型号 / 相关但不同商品，属于**必须由 Owner 裁决**的边界。
// ---------------------------------------------------------------------------

import { RANKING_FIXTURE, type RankingSampleClass } from './ranking-fixture'
import type { MatchListingFacts, MatchWishFacts } from './scoring'

export type CalibrationClass =
  | RankingSampleClass
  | 'unlimited-category'
  | 'generic-keyword'
  | 'boundary-variant'

export type CalibrationPair = {
  id: string
  sampleClass: CalibrationClass
  listing: MatchListingFacts
  wish: MatchWishFacts
  /** 我方标注建议：这一对在产品语义上**该不该**匹配（score >= MATCH_SCORE_THRESHOLD）。 */
  proposedExpectMatch: boolean
  /** 边界样本：需要 Owner 明确裁决（实现方给出倾向与理由，但不默认它正确）。 */
  needsOwnerDecision?: boolean
  /**
   * 已裁决、但**锚点/权重/阈值无法满足**的分歧：标签保留 Owner 的裁决，只是这条不参与
   * "参数一致度"的判定。写的是"为什么这不是参数问题"（可证的结构特征冲突或实测 cos 与
   * 标签相反），不是"我们放弃这条"。全部 4 条，见 `docs/design/issue-322-matching-v2-m4.md`
   * §已知分歧。
   */
  knownDivergence?: string
  rationale: string
}

export type CalibrationRow = CalibrationPair & {
  /** `m3-fixture` = 直接来自 M3 冻结 fixture（id 与 M3 相同，便于逐条对照）；`m4-new` = 本次新增。 */
  source: 'm3-fixture' | 'm4-new'
  /** M3 当时的人估 cos（仅 `m3-fixture` 行有），用于和实测值并列展示。 */
  m3Similarity: number | null
}

// --- 商品侧事实 -------------------------------------------------------------

const AIRPODS_PRO2: MatchListingFacts = {
  title: '苹果 AirPods Pro 2 降噪耳机',
  description: '主动降噪，通透模式，续航 6 小时。',
  priceCents: 129000,
  category: 'DIGITAL',
}
const TENT: MatchListingFacts = {
  title: '迪卡侬 双人帐篷',
  description: '防雨，带地钉，搭建简单。',
  priceCents: 29900,
  category: 'SPORTS',
}
const POT: MatchListingFacts = {
  title: '小熊 电煮锅 1.5L',
  description: '宿舍可用，煮面方便。',
  priceCents: 8900,
  category: 'DAILY',
}
const PILLOW: MatchListingFacts = {
  title: '网易严选 乳胶枕',
  description: '护颈椎，回弹好。',
  priceCents: 12900,
  category: 'DAILY',
}
const GUITAR: MatchListingFacts = {
  title: '雅马哈 F310 民谣吉他',
  description: '41 寸，初学者够用。',
  priceCents: 59900,
  category: 'OTHER',
}
const BLANKET: MatchListingFacts = {
  title: '南极人 电热毯 双人款',
  description: '定时，三档温度。',
  priceCents: 15900,
  category: 'DAILY',
}
const DSLR: MatchListingFacts = {
  title: '佳能 EOS 200D 单反相机',
  description: '含套机镜头，拍人像好看。',
  priceCents: 199000,
  category: 'DIGITAL',
}
const SHAVER: MatchListingFacts = {
  title: '飞科 电动剃须刀',
  description: '可水洗，充电快。',
  priceCents: 9900,
  category: 'DAILY',
}
const LAMP_MI: MatchListingFacts = {
  title: '小米 台灯 Pro',
  description: '无频闪，可调色温。',
  priceCents: 8900,
  category: 'DAILY',
}
const XM4: MatchListingFacts = {
  title: '索尼 WH-1000XM4 头戴耳机',
  description: '降噪旗舰。',
  priceCents: 159900,
  category: 'DIGITAL',
}
const BIKE: MatchListingFacts = {
  title: '美利达 勇士 500 山地车',
  description: '27.5 寸，24 速。',
  priceCents: 89900,
  category: 'TRANSPORT',
}
const MOUSE: MatchListingFacts = {
  title: '罗技 G304 无线鼠标',
  description: '轻量，续航长。',
  priceCents: 12900,
  category: 'DIGITAL',
}
const POCKET3: MatchListingFacts = {
  title: '大疆 Osmo Pocket 3 口袋云台相机',
  description: '4K 拍摄，续航好。',
  priceCents: 249900,
  category: 'DIGITAL',
}
const CTS300: MatchListingFacts = {
  title: '卡西欧 CT-S300 电子琴',
  description: '61 键，含琴架。',
  priceCents: 39900,
  category: 'OTHER',
}
const DESK_LAMP_PLAIN: MatchListingFacts = {
  title: '台灯',
  description: '护眼款，三档色温，适合长时间阅读。',
  priceCents: 5900,
  category: 'DAILY',
}
const MISC_BOOKS: MatchListingFacts = {
  title: '闲置物品',
  description: '考研数学全套资料，含真题与笔记。',
  priceCents: 8000,
  category: 'BOOKS',
}
const MONITOR: MatchListingFacts = {
  title: '二手显示器',
  description: '27 寸 2K 144Hz，适合打游戏与剪辑。',
  priceCents: 79900,
  category: 'DIGITAL',
}
const WASHER: MatchListingFacts = {
  title: '宿舍神器',
  description: '小型洗衣机，能洗 3 公斤衣物。',
  priceCents: 39900,
  category: 'DAILY',
}
const K380: MatchListingFacts = {
  title: '罗技 K380 机械键盘',
  description: '自用一年，键帽无打油。',
  priceCents: 16000,
  category: 'DIGITAL',
}
const K580: MatchListingFacts = {
  title: '罗技 K580 无线键盘',
  description: '轻薄静音，蓝牙双模。',
  priceCents: 12900,
  category: 'DIGITAL',
}
const AIRPODS3: MatchListingFacts = {
  title: '苹果 AirPods 3 无线耳机',
  description: '空间音频，续航 6 小时。',
  priceCents: 89900,
  category: 'DIGITAL',
}
const CUP: MatchListingFacts = {
  title: '保温杯 500ml',
  description: '不锈钢，保温 12 小时。',
  priceCents: 6900,
  category: 'DAILY',
}
const PHONE: MatchListingFacts = {
  title: '国产安卓手机',
  description: '8+256G，成色好。',
  priceCents: 89900,
  category: 'DIGITAL',
}
const SHOES: MatchListingFacts = {
  title: '耐克 跑步鞋 42 码',
  description: '穿过几次。',
  priceCents: 29900,
  category: 'SPORTS',
}
const POWERBANK: MatchListingFacts = {
  title: '罗马仕 充电宝 20000mAh',
  description: '双向快充，带数显。',
  priceCents: 9900,
  category: 'DIGITAL',
}

// --- 新增候选对 -------------------------------------------------------------

const NEW_PAIRS: CalibrationPair[] = [
  // 中文同义（分类一致、预算内、acceptSimilar=true）：词法 0 命中，只能靠语义。
  {
    id: 'cal-syn-airpods',
    sampleClass: 'chinese-synonym',
    listing: AIRPODS_PRO2,
    wish: {
      keyword: '听歌耳塞',
      category: 'DIGITAL',
      budgetMaxCents: 150000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '“听歌耳塞”与降噪耳机同用途，同分类且预算内；语义召回必须能连上（Issue 点名场景）。',
  },
  {
    id: 'cal-syn-tent',
    sampleClass: 'chinese-synonym',
    listing: TENT,
    wish: { keyword: '露营帐篷', category: 'SPORTS', budgetMaxCents: 40000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '“露营帐篷”是同义上位表达，同分类预算内，靠语义应能召回。',
  },
  {
    id: 'cal-syn-pot',
    sampleClass: 'chinese-synonym',
    listing: POT,
    wish: {
      keyword: '宿舍煮面的小锅',
      category: 'DAILY',
      budgetMaxCents: 12000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '“煮面小锅”↔“电煮锅”是同义改写，同分类预算内。',
  },
  {
    id: 'cal-syn-pillow',
    sampleClass: 'chinese-synonym',
    listing: PILLOW,
    wish: {
      keyword: '护颈椎的枕头',
      category: 'DAILY',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '“护颈椎枕头”↔“乳胶枕（护颈椎）”，同分类预算内，语义应召回。',
  },
  {
    id: 'cal-syn-guitar',
    sampleClass: 'chinese-synonym',
    listing: GUITAR,
    wish: { keyword: '入门木吉他', category: 'OTHER', budgetMaxCents: 70000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '“入门木吉他”↔“民谣吉他 初学者够用”，同分类预算内。',
  },
  {
    id: 'cal-syn-blanket',
    sampleClass: 'chinese-synonym',
    listing: BLANKET,
    wish: {
      keyword: '冬天保暖的毯子',
      category: 'DAILY',
      budgetMaxCents: 20000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '“冬天保暖毯子”↔“双人电热毯”，同分类预算内，属同用途近义。',
  },
  {
    id: 'cal-syn-dslr',
    sampleClass: 'chinese-synonym',
    listing: DSLR,
    wish: {
      keyword: '拍人像的相机',
      category: 'DIGITAL',
      budgetMaxCents: 250000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '“拍人像相机”↔“单反 拍人像好看”（“拍人像”在描述里整词不命中关键词），同分类预算内。',
  },
  {
    id: 'cal-syn-shaver',
    sampleClass: 'chinese-synonym',
    listing: SHAVER,
    wish: { keyword: '刮胡刀', category: 'DAILY', budgetMaxCents: 15000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '“刮胡刀”是“电动剃须刀”的常用同义表达，同分类预算内。',
  },

  // 品牌型号表达：口语/连写/大小写差异。
  {
    id: 'cal-brand-lamp',
    sampleClass: 'brand-model',
    listing: LAMP_MI,
    wish: { keyword: '小米台灯Pro', category: 'DAILY', budgetMaxCents: 10000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '仅空格差异的品牌型号对，任何实现都必须判匹配（下限用例）。',
  },
  {
    id: 'cal-brand-xm4',
    sampleClass: 'brand-model',
    listing: XM4,
    wish: {
      keyword: 'WH1000XM4',
      category: 'DIGITAL',
      budgetMaxCents: 200000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '型号去连字符写法的品牌型号对（子串命中）。',
  },
  {
    id: 'cal-brand-bike',
    sampleClass: 'brand-model',
    listing: BIKE,
    wish: {
      keyword: '勇士500',
      category: 'TRANSPORT',
      budgetMaxCents: 100000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '型号“勇士500”与标题“勇士 500”只差空格。',
  },
  {
    id: 'cal-brand-mouse',
    sampleClass: 'brand-model',
    listing: MOUSE,
    wish: { keyword: 'g304', category: 'DIGITAL', budgetMaxCents: 15000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '型号小写查询 ↔ 标题大写 G304（大小写不敏感）。',
  },
  {
    id: 'cal-brand-pocket',
    sampleClass: 'brand-model',
    listing: POCKET3,
    wish: { keyword: 'Pocket3', category: 'DIGITAL', budgetMaxCents: 300000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '型号“Pocket3”与标题“Pocket 3”只差空格。',
  },
  {
    id: 'cal-brand-cts',
    sampleClass: 'brand-model',
    listing: CTS300,
    wish: {
      keyword: 'CTS300 电子琴',
      category: 'OTHER',
      budgetMaxCents: 50000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '型号 + 品类混写的品牌型号对。',
  },

  // 描述命中（关键词不在标题里）。
  {
    id: 'cal-desc-lamp',
    sampleClass: 'description-only',
    listing: DESK_LAMP_PLAIN,
    wish: { keyword: '护眼台灯', category: 'DAILY', budgetMaxCents: 8000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '标题只有“台灯”，“护眼”在描述里；keywordScore 已把描述算进 haystack。',
  },
  {
    id: 'cal-desc-misc',
    sampleClass: 'description-only',
    listing: MISC_BOOKS,
    wish: {
      keyword: '考研数学资料',
      category: 'BOOKS',
      budgetMaxCents: 10000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '标题“闲置物品”无信息，卖点全在描述里。',
  },
  {
    id: 'cal-desc-monitor',
    sampleClass: 'description-only',
    listing: MONITOR,
    wish: {
      keyword: '2K 高刷显示器',
      category: 'DIGITAL',
      budgetMaxCents: 90000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '“2K 高刷”只在描述（“27 寸 2K 144Hz”）中出现。',
  },
  {
    id: 'cal-desc-washer',
    sampleClass: 'description-only',
    listing: WASHER,
    wish: {
      keyword: '宿舍小洗衣机',
      category: 'DAILY',
      budgetMaxCents: 50000,
      acceptSimilar: true,
    },
    proposedExpectMatch: true,
    rationale: '标题“宿舍神器”不可检索，商品实体在描述里。',
  },

  // 分类不符（语义强但愿望要的是别的分类）⇒ 不应匹配。
  {
    id: 'cal-cat-k380-books',
    sampleClass: 'semantic-category-mismatch',
    listing: K380,
    wish: { keyword: '机械键盘', category: 'BOOKS', budgetMaxCents: 20000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '愿望要书、商品是数码：语义再高也不该仅凭语义越过阈值（M3 冻结行为）。',
  },
  {
    id: 'cal-cat-textbook-digital',
    sampleClass: 'semantic-category-mismatch',
    listing: {
      title: '高等数学上册（同济第七版）',
      description: '有少量笔记。',
      priceCents: 2000,
      category: 'BOOKS',
    },
    wish: { keyword: '高数教材', category: 'DIGITAL', budgetMaxCents: 3000, acceptSimilar: false },
    proposedExpectMatch: false,
    rationale:
      '分类不符且 acceptSimilar=false（只有关键词/分类能支撑语义，分类为 0 但仍有关键词）。',
  },
  {
    id: 'cal-cat-shoes-apparel',
    sampleClass: 'semantic-category-mismatch',
    listing: SHOES,
    wish: { keyword: '鞋子', category: 'APPAREL', budgetMaxCents: 40000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '“鞋子”确实命中商品，但愿望分类填的是服饰（商品是运动）：分类等值不成立。',
  },
  {
    id: 'cal-cat-lamp-books',
    sampleClass: 'semantic-category-mismatch',
    listing: LAMP_MI,
    wish: { keyword: '台灯', category: 'BOOKS', budgetMaxCents: 10000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '关键词命中但分类不符，用于确认“结构命中也不能抵消分类不符”。',
  },

  // 超预算（同分类、语义强）⇒ 不应匹配。
  {
    id: 'cal-budget-k380',
    sampleClass: 'semantic-over-budget',
    listing: K380,
    wish: { keyword: '静音键盘', category: 'DIGITAL', budgetMaxCents: 8000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '价格 2× 预算（priceScore 0）：超预算 2 倍的产品规则本身就把候选排除。',
  },
  {
    id: 'cal-budget-airpods',
    sampleClass: 'semantic-over-budget',
    listing: AIRPODS_PRO2,
    wish: { keyword: '听歌耳塞', category: 'DIGITAL', budgetMaxCents: 60000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '1290 元 vs 600 元预算（2.15×），已越过 2 倍收窄边界。',
  },
  {
    id: 'cal-budget-lamp',
    sampleClass: 'semantic-over-budget',
    listing: LAMP_MI,
    wish: { keyword: '护眼台灯', category: 'DAILY', budgetMaxCents: 4000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '89 元 vs 40 元预算（2.2×），越过 2 倍边界。',
  },

  // acceptSimilar=false：语义不得单独成立。
  {
    id: 'cal-acceptfalse-airpods',
    sampleClass: 'accept-similar-false',
    listing: AIRPODS_PRO2,
    wish: {
      keyword: '听歌耳塞',
      category: 'DIGITAL',
      budgetMaxCents: 150000,
      acceptSimilar: false,
    },
    proposedExpectMatch: false,
    rationale: '与 cal-syn-airpods 只差 acceptSimilar：false 时语义分记 0，结构只有分类+价格。',
  },
  {
    id: 'cal-acceptfalse-tent',
    sampleClass: 'accept-similar-false',
    listing: TENT,
    wish: {
      keyword: '露营帐篷',
      category: 'SPORTS',
      budgetMaxCents: 40000,
      acceptSimilar: false,
    },
    proposedExpectMatch: false,
    rationale: 'acceptSimilar=false 且词法 0 命中：语义不得单独召回。',
  },
  {
    id: 'cal-acceptfalse-guitar',
    sampleClass: 'accept-similar-false',
    listing: GUITAR,
    wish: {
      keyword: '入门木吉他',
      category: 'OTHER',
      budgetMaxCents: 70000,
      acceptSimilar: false,
    },
    proposedExpectMatch: false,
    rationale: 'acceptSimilar=false 的同义对，与 cal-syn-guitar 构成对照。',
  },

  // 不限分类（category = null，权重按三维归一化）。
  {
    id: 'cal-unlimited-tent',
    sampleClass: 'unlimited-category',
    listing: TENT,
    wish: { keyword: '帐篷', category: null, budgetMaxCents: 40000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '不限分类但词法命中“帐篷”，价格在预算内：不限分类不应让结构命中的对掉出匹配。',
  },
  {
    id: 'cal-unlimited-lamp',
    sampleClass: 'unlimited-category',
    listing: LAMP_MI,
    wish: { keyword: '台灯', category: null, budgetMaxCents: 10000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '不限分类 + 词法命中，价格在预算内。',
  },
  {
    id: 'cal-unlimited-cup',
    sampleClass: 'unlimited-category',
    listing: CUP,
    wish: { keyword: '水杯', category: null, budgetMaxCents: 10000, acceptSimilar: true },
    proposedExpectMatch: true,
    needsOwnerDecision: true,
    rationale:
      '不限分类 + 词法 0 命中（“水杯”不是“保温杯”的子串）+ 预算内：只有语义能连上。语义召回是否该单独成立，请 Owner 明确（M3 冻结口径要求 cos ≥ 0.87，实测可能达不到）。',
  },
  {
    id: 'cal-unlimited-phone',
    sampleClass: 'unlimited-category',
    listing: PHONE,
    wish: { keyword: '手机', category: null, budgetMaxCents: 100000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '不限分类 + 上位词命中（“手机”是“国产安卓手机”子串）+ 预算内。',
  },

  // 泛称 / 上位词（同分类、词法命中）。
  {
    id: 'cal-generic-keyboard',
    sampleClass: 'generic-keyword',
    listing: K380,
    wish: { keyword: '键盘', category: 'DIGITAL', budgetMaxCents: 20000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '上位词“键盘”命中标题，同分类预算内：泛称查询也必须能召回具体型号。',
  },
  {
    id: 'cal-generic-monitor',
    sampleClass: 'generic-keyword',
    listing: MONITOR,
    wish: { keyword: '显示器', category: 'DIGITAL', budgetMaxCents: 90000, acceptSimilar: true },
    proposedExpectMatch: true,
    rationale: '标题“二手显示器”直接命中上位词，同分类预算内。',
  },

  // 无关对（跨领域）：任何权重集都必须判不匹配。
  {
    id: 'cal-unrel-airpods-lipstick',
    sampleClass: 'unrelated',
    listing: AIRPODS_PRO2,
    wish: { keyword: '口红', category: 'BEAUTY', budgetMaxCents: 5000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域且分类不符、预算不符。',
  },
  {
    id: 'cal-unrel-bike-english',
    sampleClass: 'unrelated',
    listing: BIKE,
    wish: { keyword: '考研英语真题', category: 'BOOKS', budgetMaxCents: 5000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域无关对。',
  },
  {
    id: 'cal-unrel-tent-ricecooker',
    sampleClass: 'unrelated',
    listing: TENT,
    wish: { keyword: '电饭煲', category: 'DAILY', budgetMaxCents: 10000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域无关对（愿望分类与商品分类也不同）。',
  },
  {
    id: 'cal-unrel-mouse-yoga',
    sampleClass: 'unrelated',
    listing: MOUSE,
    wish: { keyword: '瑜伽垫', category: 'SPORTS', budgetMaxCents: 10000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域无关对。',
  },
  {
    id: 'cal-unrel-xm4-down',
    sampleClass: 'unrelated',
    listing: XM4,
    wish: { keyword: '羽绒服', category: 'APPAREL', budgetMaxCents: 20000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域无关对。',
  },
  {
    id: 'cal-unrel-cup-gpu',
    sampleClass: 'unrelated',
    listing: CUP,
    wish: { keyword: '显卡', category: 'DIGITAL', budgetMaxCents: 20000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域无关对（预算内但仍不该匹配）。',
  },
  {
    id: 'cal-unrel-shoes-politics',
    sampleClass: 'unrelated',
    listing: SHOES,
    wish: { keyword: '考研政治资料', category: 'BOOKS', budgetMaxCents: 5000, acceptSimilar: true },
    proposedExpectMatch: false,
    rationale: '跨领域无关对。',
  },
  {
    id: 'cal-unrel-dslr-bike',
    sampleClass: 'unrelated',
    listing: DSLR,
    wish: {
      keyword: '山地自行车',
      category: 'TRANSPORT',
      budgetMaxCents: 100000,
      acceptSimilar: true,
    },
    proposedExpectMatch: false,
    rationale: '跨领域无关对（金额接近，防止“价格相近即相似”这种伪相关）。',
  },

  // 边界：同品牌不同型号 / 相关但不同商品 —— 必须 Owner 裁决。
  {
    id: 'cal-bound-k580-keyboard',
    sampleClass: 'boundary-variant',
    listing: K580,
    wish: { keyword: '机械键盘', category: 'DIGITAL', budgetMaxCents: 20000, acceptSimilar: true },
    proposedExpectMatch: false,
    needsOwnerDecision: true,
    knownDivergence:
      'Owner 已裁决"不匹配"，但实测 cos = 0.665（同分类、预算内、词法 0 命中），与 cal-syn-pillow（0.713、裁决为匹配）的结构特征几乎相同 ⇒ 锚点/权重/阈值无法把两者分开。',
    rationale:
      '同品牌不同型号：K580 是薄膜键盘，愿望要的是“机械键盘”。我方倾向不匹配（品类不同），但“同品牌键盘”是否算可接受替代品应由 Owner 定。',
  },
  {
    id: 'cal-bound-airpods3',
    sampleClass: 'boundary-variant',
    listing: AIRPODS3,
    wish: {
      keyword: '苹果降噪耳机',
      category: 'DIGITAL',
      budgetMaxCents: 150000,
      acceptSimilar: true,
    },
    proposedExpectMatch: false,
    needsOwnerDecision: true,
    knownDivergence:
      'Owner 已裁决"不匹配"，但实测 cos = 0.716 是整张表最高之一（同分类、预算内），与 cal-syn-pillow（0.713、裁决为匹配）方向相反、数值几乎相同 ⇒ 参数不可分。',
    rationale:
      '同品牌不同型号：AirPods 3 无主动降噪，愿望明确要降噪。我方倾向不匹配（关键功能不同），请 Owner 确认。',
  },
  {
    id: 'cal-bound-powerbank-charger',
    sampleClass: 'boundary-variant',
    listing: POWERBANK,
    wish: { keyword: '充电器', category: 'DIGITAL', budgetMaxCents: 15000, acceptSimilar: true },
    proposedExpectMatch: false,
    needsOwnerDecision: true,
    knownDivergence:
      'Owner 已裁决"不匹配"，但实测 cos = 0.605 高于 cal-syn-airpods（0.566、裁决为匹配）⇒ 参数不可分（这是"同一对结构特征、标签相反"的可证冲突）。',
    rationale:
      '相关但不同商品：充电宝 vs 充电器。语义相近、同分类、预算内，但产品不是同一个东西；请 Owner 定这条线。',
  },
]

const fromFixture: CalibrationRow[] = RANKING_FIXTURE.map((sample) => ({
  id: sample.id,
  sampleClass: sample.sampleClass,
  listing: sample.listing,
  wish: sample.wish,
  proposedExpectMatch: sample.expectMatch,
  // M3 人估 cos = 0.9，实测 0.433：真实模型认为这对"不限分类的相似愿望 ↔ 商品"只是弱相关，
  // 而 Owner 的裁决是"该匹配"。标签保留，分歧记录在案（任何锚点组合都够不到 70 分）。
  knownDivergence:
    sample.id === 'any-category-similar-true'
      ? 'Owner 裁决"匹配"，但实测 cos = 0.433 是整张表最低的真匹配（M3 人估 0.9）⇒ 真实模型认为它不相似，与标签相反的模型证据，参数不可弥补。'
      : undefined,
  rationale: sample.rationale,
  source: 'm3-fixture',
  m3Similarity: sample.similarity,
}))

const newRows: CalibrationRow[] = NEW_PAIRS.map((pair) => ({
  ...pair,
  source: 'm4-new',
  m3Similarity: null,
}))

/** M3 冻结样本 + M4 新增候选：`embed:eval --sections=calibration` 会对全表实测 cos。 */
export const CALIBRATION_ROWS: CalibrationRow[] = [...fromFixture, ...newRows]
