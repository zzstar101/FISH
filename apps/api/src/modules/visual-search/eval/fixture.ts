import type { ListingCategory } from '@fish/contracts/listings/schema'
import type { VisualInterpretation } from '@fish/contracts/visual/schema'

/**
 * 拍照识图搜索（#324 M9）的离线评测 fixture。
 *
 * ## 为什么分数是人工给的，而不是跑 provider 算出来的
 *
 * 与 #322 的 `apps/worker/src/jobs/matching/ranking-fixture.ts` 完全同一取舍：
 * **CI 不出网**，而本单的两路召回来路不同（图片路要真实多模态 embedding，文本路要 OCR/VLM），
 * 在本机跑一次真实上游既不可复现（模型会变、延迟会变、额度会烧），又会把
 * 「排序公式对不对」与「模型语义好不好」两件事混成一个分数。
 *
 * stub provider 更给不出可比较的余弦尺度：它的图片向量是**字节哈希铺开**的，两张视觉上
 * 几乎相同的商品图（同款不同角度）在 stub 空间里彼此正交。拿它算 Recall / NDCG 只会得到
 * "随机数"级别的结论，然后被误当成模型质量问题。
 *
 * 所以这里把**每一路召回的相似度当输入**（`visualScore` / `textScore`），只评测**排序与度量**
 * 这一层——正是 `ranking.ts` 的 `scoreVisualCandidate` 负责的那一层，也是唯一能用确定性
 * 离线样本钉死的部分。模型语义质量由 M9 的 DB 端到端腿（`visual:eval:db`）与 live 考核覆盖。
 *
 * 于是本文件：**不碰数据库、不出网、不需要任何环境变量**，只导出纯数据。
 *
 * ## 标注口径：三路必须**分出高低**，否则这个 fixture 什么也证明不了
 *
 * 全部正确的样本会让三路指标都是 1.000——第一版 fixture 就是这样，什么也没测出来。
 * 所以这里的样本按两路各自的**失误模式**设计，并且两类失误数量刻意接近：
 *
 * - `visual-only` 的失误模式：**外形相似但语义不同**。包装盒、配件、耗材、同系列旧款、
 *   只差颜色的同款、同品类异商品——多模态模型在纯外观上给它们很高的分，
 *   因为它看的是"像不像"，分不出"能不能用"。
 * - `text-only` 的失误模式：**只有文字对得上，图不对**。标题写着型号的空盒、
 *   通用关键词撞上的无关品类、以及根本解析不出文本的查询（此时文本路完全失去判别力）。
 * - `hybrid` 应当同时避开这两类失误——这就是它存在的唯一理由，也是本 Issue 要验证的命题。
 *
 * ## 当前的实测结果（改样本前先读这段）
 *
 * `bun run visual:eval` 在 12 条样本上得到：**首选与人工判断一致率** visual-only 10/12、
 * text-only 12/12、hybrid 12/12；**排序倒置数**（至少一条不相关项压过相关项）
 * 分别是 3 / 2 / 1 条。也就是说：hybrid 的优势是**真实但很小**——它只在"倒置"这一项上
 * 严格胜出（1 < 2 < 3），首选命中与 text-only 打平，
 * 而 `Recall@5` / `Recall@10` / `Top-5 人工相关率` 三路**完全一样**
 * （候选池每样本只有 4–5 条，Top-5 覆盖全池；Recall 的分母是标注出的相关项，
 * 只要不漏就都是 1.000）。这不是脚本的缺陷，而是这个 fixture 分辨率的真实上限——
 * 想知道线上召回率与空结果率，必须跑 `visual:eval:db`。
 *
 * 第一版 fixture 只有 3–4 个候选、且每条样本的相关项视觉分都比不相关项高，
 * 于是三路指标全部饱和；这不是"评测通过"，是"评测失效"。改动样本时请守住这条：
 * **任何一条样本都不应该让三路同时满分**，除非它刻意是冒烟测试（如 `exact-camera-reorder`）。
 *
 * ## 每条 rationale 里的排序结论都是**实测**的
 *
 * rationale 末尾给出三路各自的排序（从高到低）与随之而来的失败模式。这些数字不是估算：
 * 它们出自 `scoreVisualCandidate` 的加权平均（visual .5 / text .2 / category .15 /
 * freshness .1 / popularity .05，**缺失分项连同权重一起剔除**）与
 * `freshnessScore = 0.5 ** (ageDays / 30)`、`popularityScore = min(1, favoriteCount / 20)`。
 * 改动任何一个分数都必须重跑 `bun run visual:eval` 并同步更新 rationale——否则文档会开始撒谎。
 *
 * `visualScore` / `textScore` 都是人工给定的 [0, 1] 相似度（与
 * `similarityFromCosineDistance` 的输出同域：0 = 正交/无关，1 = 同向）。
 * `textScore = null` 表示"这一路没有文本证据"——它与 `0` **不是一回事**：
 * `scoreVisualCandidate` 会把 `null` 的分项**连同权重一起剔除**，而 `0` 会被当成
 * "有证据但完全不相似"计入加权。
 *
 * ## 时间基准是常量
 *
 * `createdAt` 全部相对 `REFERENCE_NOW` 给出，评测脚本把它当作 `now` 传入，
 * 因此 freshness 分项在每次运行里都是同一个值（与 #322 的"分数必须可复现"同一纪律）。
 */

/** 评测用的固定"现在"。改动它会让所有样本的 freshness 分项一起变，等于换了一套基准。 */
export const REFERENCE_NOW = new Date('2026-03-01T00:00:00.000Z')

/** `daysAgo` 相对 `REFERENCE_NOW` 的绝对时刻。 */
function daysAgo(days: number): Date {
  return new Date(REFERENCE_NOW.getTime() - days * 86_400_000)
}

export type VisualEvalCandidate = {
  listingId: string
  title: string
  category: ListingCategory
  priceCents: number
  condition: 'NEW' | 'LIKE_NEW' | 'GOOD' | 'FAIR'
  createdAt: Date
  favoriteCount: number
  /** 图片路召回的相似度，人工给定。 */
  visualScore: number
  /** OCR/VLM 文本路召回的相似度，人工给定；无文本证据为 `null`。 */
  textScore: number | null
}

/**
 * 相关性分级（人工判断，`relevance` 字典的值）。
 *
 * 用三级而不是布尔：难样本的意义就在于"它**确实有点关系**，只是不该排在同款前面"，
 * 布尔标注会把这种样本压成 0，于是 NDCG 再也看不出"难样本被排到第几位"。
 */
export type VisualEvalRelevance = 0 | 1 | 2

/**
 * 样本类别。四类对应 Issue 要求的"正/难/负样本"：
 *
 * - `exact`：正样本。候选池里有同款（同型号不同图），图片路与文本路都应当把它排在前面。
 * - `variant`：难样本。同系列不同型号 / 只差颜色 / 同品类异商品——
 *   图片路会给它们偏高的分（这正是难的地方），但人工判断应把它们排在同款之后。
 * - `category-mismatch`：难样本的另一形态。图片相似（包装盒、配件、耗材），
 *   但分类与查询图的解析结果不一致——靠 `categoryScore` 那一路兜底。
 * - `unrelated`：负样本。图片路与文本路都不该把它们抬上来。
 */
export type VisualEvalSampleClass = 'exact' | 'variant' | 'category-mismatch' | 'unrelated'

export type VisualEvalSample = {
  id: string
  sampleClass: VisualEvalSampleClass
  /**
   * 查询图的解析结果（M5）。`null` = 没解析出文本 / 解析被关掉（`VISUAL_PARSE_TRANSPORT=off`）。
   *
   * 排序评测只用它的 `category` 字段：hybrid 路的 `categoryScore` 是
   * 「候选分类 === 解析分类」的硬一致性（命中 1 / 未命中 0 / 没解析出分类则整项剔除）。
   */
  query: { interpretation: VisualInterpretation | null }
  candidates: VisualEvalCandidate[]
  /** `listingId` → 分级相关性（0 = 不相关，1 = 部分相关，2 = 同款）。 */
  relevance: Record<string, VisualEvalRelevance>
  /** 为什么这样标注，以及这条样本期望三路怎么分岔（见文件头注释）。 */
  rationale: string
}

/** 造候选的简写：只写关心的字段，其余给一个中性默认值。 */
function candidate(input: {
  listingId: string
  title: string
  category: ListingCategory
  priceCents: number
  visualScore: number
  textScore: number | null
  condition?: VisualEvalCandidate['condition']
  ageDays?: number
  favoriteCount?: number
}): VisualEvalCandidate {
  return {
    listingId: input.listingId,
    title: input.title,
    category: input.category,
    priceCents: input.priceCents,
    condition: input.condition ?? 'GOOD',
    createdAt: daysAgo(input.ageDays ?? 10),
    favoriteCount: input.favoriteCount ?? 0,
    visualScore: input.visualScore,
    textScore: input.textScore,
  }
}

/** 把候选列表按 `listingId` 变成 `relevance` 字典（写样本时比手写对象少一处打错 id 的机会）。 */
function relevanceOf(
  entries: readonly (readonly [VisualEvalCandidate, VisualEvalRelevance])[],
): Record<string, VisualEvalRelevance> {
  const result: Record<string, VisualEvalRelevance> = {}
  for (const [entry, relevance] of entries) result[entry.listingId] = relevance
  return result
}

// ---------------------------------------------------------------------------
// 候选池：同一件商品在多个样本里复用，避免它的分数在不同样本里漂移。
// ---------------------------------------------------------------------------

// --- 罗技 C270 摄像头 -----------------------------------------------------

/** 真机（同款）。 */
const camRealA = candidate({
  listingId: 'cam-real-a',
  title: '罗技 C270 网络摄像头（几乎全新）',
  category: 'DIGITAL',
  priceCents: 15900,
  visualScore: 0.97,
  textScore: 0.95,
  condition: 'LIKE_NEW',
  ageDays: 2,
  favoriteCount: 6,
})

const camRealB = candidate({
  listingId: 'cam-real-b',
  title: '罗技 C270 摄像头 带原装盒',
  category: 'DIGITAL',
  priceCents: 17500,
  visualScore: 0.91,
  textScore: 0.92,
  ageDays: 22,
  favoriteCount: 3,
})

/** 空盒：图片极像、文字不像、分类错。`visual-only` 的头号失误来源。 */
const camBoxOnly = candidate({
  listingId: 'cam-box-only',
  title: '罗技 C270 原装包装盒 + 说明书（空盒）',
  category: 'OTHER',
  priceCents: 500,
  visualScore: 0.96,
  textScore: 0.4,
  ageDays: 30,
  favoriteCount: 0,
})

/** 旧型号 C270i：外观几乎一致、型号低一档。 */
const camOldVariant = candidate({
  listingId: 'cam-old-variant',
  title: '罗技 C270i 摄像头 720p（老款）',
  category: 'DIGITAL',
  priceCents: 9900,
  visualScore: 0.9,
  textScore: 0.7,
  condition: 'FAIR',
  ageDays: 200,
  favoriteCount: 0,
})

/** 无关品类。 */
const camUnrelated = candidate({
  listingId: 'cam-unrelated',
  title: '考研英语一 历年真题 2020-2025',
  category: 'BOOKS',
  priceCents: 3000,
  visualScore: 0.14,
  textScore: 0.1,
  ageDays: 14,
  favoriteCount: 5,
})

// --- 罗技 K380 键盘（查询图解析不出文本） ---------------------------------

const kbdRealA = candidate({
  listingId: 'kbd-real-a',
  title: '罗技 K380 无线键盘 深灰',
  category: 'DIGITAL',
  priceCents: 12500,
  visualScore: 0.96,
  textScore: null,
  ageDays: 5,
  favoriteCount: 20,
})

const kbdRealB = candidate({
  listingId: 'kbd-real-b',
  title: '罗技 K380 蓝牙键盘（附收纳袋）',
  category: 'DIGITAL',
  priceCents: 11000,
  visualScore: 0.9,
  textScore: null,
  condition: 'LIKE_NEW',
  ageDays: 21,
  favoriteCount: 7,
})

const kbdOtherModel = candidate({
  listingId: 'kbd-other-model',
  title: '罗技 K480 键盘 白色',
  category: 'DIGITAL',
  priceCents: 9000,
  visualScore: 0.82,
  textScore: null,
  ageDays: 15,
  favoriteCount: 9,
})

/** 高热度的无关项：文本路没有证据时它靠 popularity 挤上来。 */
const kbdMouseDistractor = candidate({
  listingId: 'kbd-mouse-distractor',
  title: '罗技 M330 静音无线鼠标（静音款）',
  category: 'DIGITAL',
  priceCents: 6900,
  visualScore: 0.62,
  textScore: null,
  ageDays: 40,
  favoriteCount: 80,
})

// --- 教材 ----------------------------------------------------------------

const bookRealA = candidate({
  listingId: 'book-real-a',
  title: '高等数学 上册 第七版 同济大学',
  category: 'BOOKS',
  priceCents: 2500,
  visualScore: 0.95,
  textScore: 0.93,
  ageDays: 8,
  favoriteCount: 15,
})

const bookRealB = candidate({
  listingId: 'book-real-b',
  title: '高等数学（第七版）上册 有少量笔记',
  category: 'BOOKS',
  priceCents: 1800,
  visualScore: 0.91,
  textScore: 0.9,
  condition: 'FAIR',
  ageDays: 26,
  favoriteCount: 6,
})

/** 同系列不同分册（下册）：相关但不等价。 */
const bookSameSeries = candidate({
  listingId: 'book-same-series',
  title: '高等数学 下册 第七版 同济大学',
  category: 'BOOKS',
  priceCents: 2200,
  visualScore: 0.94,
  textScore: 0.88,
  ageDays: 4,
  favoriteCount: 9,
})

const bookOtherSubject = candidate({
  listingId: 'book-other-subject',
  title: '线性代数 第六版 同济大学',
  category: 'BOOKS',
  priceCents: 1500,
  visualScore: 0.61,
  textScore: 0.58,
  ageDays: 12,
  favoriteCount: 8,
})

// --- 罗技 MX Master 鼠标系列 ---------------------------------------------

const mx3s = candidate({
  listingId: 'mx-3s',
  title: '罗技 MX Master 3S 无线鼠标',
  category: 'DIGITAL',
  priceCents: 42000,
  visualScore: 0.9,
  textScore: 1,
  condition: 'LIKE_NEW',
  ageDays: 3,
  favoriteCount: 10,
})

/** 上一代：图片更像查询图，型号文字不同。`visual-only` 的第二个失误来源。 */
const mx3old = candidate({
  listingId: 'mx-3-old',
  title: '罗技 MX Master 3 无线鼠标（上一代）',
  category: 'DIGITAL',
  priceCents: 31000,
  visualScore: 0.95,
  textScore: 0.8,
  ageDays: 40,
  favoriteCount: 2,
})

const mxAnywhere = candidate({
  listingId: 'mx-anywhere',
  title: '罗技 MX Anywhere 3 便携鼠标',
  category: 'DIGITAL',
  priceCents: 28000,
  visualScore: 0.84,
  textScore: 0.7,
  ageDays: 33,
  favoriteCount: 5,
})

// --- AirPods Pro 2 ------------------------------------------------------

const airpodsWhite = candidate({
  listingId: 'airpods-white',
  title: 'AirPods Pro 2 白色 国行',
  category: 'DIGITAL',
  priceCents: 118000,
  visualScore: 0.85,
  textScore: 0.88,
  condition: 'LIKE_NEW',
  ageDays: 7,
  favoriteCount: 11,
})

/** 只差颜色 + 附带保护壳：图片更像，文字更不像。 */
const airpodsBlack = candidate({
  listingId: 'airpods-black',
  title: 'AirPods Pro 2 黑色 保护壳套装',
  category: 'DIGITAL',
  priceCents: 105000,
  visualScore: 0.93,
  textScore: 0.7,
  ageDays: 9,
  favoriteCount: 6,
})

const airpodsOlder = candidate({
  listingId: 'airpods-3',
  title: 'AirPods 3 白色 无降噪',
  category: 'DIGITAL',
  priceCents: 62000,
  visualScore: 0.87,
  textScore: 0.66,
  ageDays: 45,
  favoriteCount: 14,
})

// --- 小米配件（同品类异商品） --------------------------------------------

const miPowerBank = candidate({
  listingId: 'mi-powerbank',
  title: '小米移动电源 3 10000mAh',
  category: 'DIGITAL',
  priceCents: 6900,
  visualScore: 0.58,
  textScore: 0.55,
  ageDays: 6,
  favoriteCount: 21,
})

const miBand = candidate({
  listingId: 'mi-band',
  title: '小米手环 8 NFC 版',
  category: 'DIGITAL',
  priceCents: 15900,
  visualScore: 0.52,
  textScore: 0.47,
  ageDays: 27,
  favoriteCount: 8,
})

// --- iPad 与配件 ---------------------------------------------------------

/** 保护壳：图片比平板本体更像"iPad"，分类却在 OTHER。 */
const ipadCase = candidate({
  listingId: 'ipad-case',
  title: 'iPad 保护壳 11 英寸 通用',
  category: 'OTHER',
  priceCents: 2900,
  visualScore: 0.86,
  textScore: 0.45,
  ageDays: 17,
  favoriteCount: 4,
})

const ipadFilm = candidate({
  listingId: 'ipad-film',
  title: 'iPad 钢化膜 两片装',
  category: 'OTHER',
  priceCents: 1200,
  visualScore: 0.7,
  textScore: 0.4,
  ageDays: 60,
  favoriteCount: 2,
})

const ipadTablet = candidate({
  listingId: 'ipad-tablet',
  title: 'iPad 第 9 代 64G WiFi 版',
  category: 'DIGITAL',
  priceCents: 129000,
  visualScore: 0.68,
  textScore: 0.78,
  ageDays: 30,
  favoriteCount: 1,
})

const ipadPencil = candidate({
  listingId: 'ipad-pencil',
  title: 'Apple Pencil 一代 手写笔',
  category: 'DIGITAL',
  priceCents: 45000,
  visualScore: 0.6,
  textScore: 0.42,
  ageDays: 25,
  favoriteCount: 2,
})

// --- 负样本池 -----------------------------------------------------------

const negTextbook = candidate({
  listingId: 'neg-textbook',
  title: '考研英语一 历年真题 2020-2025',
  category: 'BOOKS',
  priceCents: 3000,
  visualScore: 0.18,
  textScore: 0.12,
  ageDays: 14,
  favoriteCount: 5,
})

const negRacket = candidate({
  listingId: 'neg-racket',
  title: '羽毛球拍 尤尼克斯 双拍套装',
  category: 'SPORTS',
  priceCents: 22000,
  visualScore: 0.11,
  textScore: null,
  ageDays: 23,
  favoriteCount: 3,
})

const negBike = candidate({
  listingId: 'neg-bike',
  title: '折叠自行车 20 寸 校园代步',
  category: 'TRANSPORT',
  priceCents: 38000,
  visualScore: 0.09,
  textScore: 0.07,
  ageDays: 35,
  favoriteCount: 12,
})

/** 真同款混进负样本池：应当排第一，证明无关品类不会被抬起来。 */
const negCameraNew = candidate({
  listingId: 'neg-camera-new',
  title: '罗技 C270 摄像头 全新未拆',
  category: 'DIGITAL',
  priceCents: 19900,
  visualScore: 0.9,
  textScore: 0.86,
  condition: 'NEW',
  ageDays: 1,
  favoriteCount: 30,
})

/** 标题写着型号的盒子：文本路会把它排进前列，图片路也不会太低。 */
const negBoxTextMatch = candidate({
  listingId: 'neg-box-text-match',
  title: '罗技 C270 摄像头 原盒（无机器）',
  category: 'OTHER',
  priceCents: 300,
  visualScore: 0.88,
  textScore: 0.72,
  ageDays: 45,
  favoriteCount: 0,
})

// ---------------------------------------------------------------------------
// fixture 本体：12 条样本
// ---------------------------------------------------------------------------

export const VISUAL_EVAL_FIXTURE: VisualEvalSample[] = [
  // -------------------------------------------------------------------------
  // category-mismatch：图片极像、分类不对（`visual-only` 会首选错位）
  // -------------------------------------------------------------------------
  {
    id: 'mismatch-camera-box',
    sampleClass: 'category-mismatch',
    query: {
      interpretation: { category: 'DIGITAL', brand: '罗技', model: 'C270', keywords: ['摄像头'] },
    },
    candidates: [camBoxOnly, camRealA, camRealB, camUnrelated],
    relevance: relevanceOf([
      [camBoxOnly, 0],
      [camRealA, 2],
      [camRealB, 2],
      [camUnrelated, 0],
    ]),
    rationale:
      '包装盒陷阱。这条**三路都排对了**，它存在的意义是：一旦 rankings 里盒子翻上去，就是"图片像"盖过了"能用"。' +
      '盒子的 visualScore（0.96）只比真机 A（0.97）低 0.01，肉眼几乎分不出来；真正拉开差距的是盒子 30 天前发布、0 收藏。' +
      '实测：visual-only = 真机 A 0.9161 > 盒 0.8154 > 真机 B 0.8041 > 教材 0.2383；' +
      'text-only = 真机 A 0.3535 > 真机 B 0.2961 > 盒 0.1529 > 教材 0.1234；' +
      'hybrid = 真机 A 0.9355 > 真机 B 0.8567 > 盒 0.6100 > 教材 0.1749（盒子被 categoryScore=0 再压一档：它是 OTHER，解析出的是 DIGITAL）。' +
      '标 0 而不是 1：买家拍一台摄像头找的是能用的商品，不是盒子。',
  },
  {
    id: 'mismatch-ipad-accessories',
    sampleClass: 'category-mismatch',
    query: { interpretation: { category: 'DIGITAL', keywords: ['iPad'], text: 'iPad' } },
    candidates: [ipadCase, ipadFilm, ipadTablet, ipadPencil],
    relevance: relevanceOf([
      [ipadCase, 0],
      [ipadFilm, 0],
      [ipadTablet, 2],
      [ipadPencil, 1],
    ]),
    rationale:
      '配件/耗材陷阱，**本 fixture 里 visual-only 错得最彻底的一条**：保护壳的 visualScore 0.86 远高于平板本体 0.68——壳的照片本来就是一块 iPad 形状的东西，模型最容易把它当平板。' +
      '两条配件的分类是 OTHER（解析出的是 DIGITAL ⇒ categoryScore = 0），平板与 Pencil 是 DIGITAL（= 1）。' +
      '实测：visual-only = 壳 0.7808 > 平板 0.6038 > 膜 0.5846 > Pencil 0.5556 ⇒ **首选是 rel=0 的壳**；' +
      'text-only = 平板 0.2453 > 壳 0.1971 > Pencil 0.1707 > 膜 0.1294 ⇒ 纠正；' +
      'hybrid = 平板 0.6985 > 壳 0.5975 > Pencil 0.5951 > 膜 0.4600 ⇒ 纠正（壳与 Pencil 只差 0.0024，靠 categoryScore 那 0.15 的权重翻过来）。' +
      'Pencil 标 1：它是 iPad 的配套件，但查询的是平板本身。',
  },

  // -------------------------------------------------------------------------
  // variant：图片路把"次一等"的候选排在最前
  // -------------------------------------------------------------------------
  {
    id: 'variant-mx-model',
    sampleClass: 'variant',
    query: { interpretation: { category: 'DIGITAL', brand: '罗技', model: 'MX Master 3S' } },
    candidates: [mx3old, mx3s, mxAnywhere, miBand],
    relevance: relevanceOf([
      [mx3old, 1],
      [mx3s, 2],
      [mxAnywhere, 1],
      [miBand, 0],
    ]),
    rationale:
      '同系列不同型号：MX Master 3（上一代）与 3S 外形几乎一致，人工给定旧款的 visualScore 更高（0.95 > 0.90）——现实中"照片更像查询图"的完全可能是旧款。' +
      '实测：visual-only = 新款 0.8743 > 旧款 0.7995 > Anywhere 0.7372 > 手环 0.5132；' +
      'text-only = 新款 0.3745 > 旧款 0.2408 > Anywhere 0.2343 > 手环 0.1972；' +
      'hybrid = 新款 0.9183 > 旧款 0.8297 > Anywhere 0.7692 > 手环 0.5776。' +
      '**三路都排对了**，原因值得记下来：旧款视觉分高 0.05，却比新款早 37 天发布、少 8 个收藏，' +
      'freshness（0.397 vs 0.933）与 popularity（0.100 vs 0.500）合计 0.15 的权重正好抵消了那 0.05 的视觉优势。' +
      '换句话说这条样本当前**没有**暴露 visual-only 的失误——要让上一代真的顶上来，得把旧款的 visualScore 提到约 0.99 或把它的新鲜度补上。' +
      '保留现状是刻意的：它记录了"视觉优势被新鲜度抵消"这个真实边界，也提醒不要把这条当成图片路会翻车的证据。' +
      '标 1 而不是 2：上一代是同系列但不同型号，买家会介意；也确实"能用"，所以不是 0。',
  },
  {
    id: 'variant-airpods-color',
    sampleClass: 'variant',
    query: {
      interpretation: { category: 'DIGITAL', model: 'AirPods Pro 2', text: 'AirPods Pro 2 白色' },
    },
    candidates: [airpodsBlack, airpodsWhite, airpodsOlder, miBand],
    relevance: relevanceOf([
      [airpodsBlack, 1],
      [airpodsWhite, 2],
      [airpodsOlder, 1],
      [miBand, 0],
    ]),
    rationale:
      '**只差颜色**，而且颜色写在查询图的文字里（"白色"）。黑色那件照片更近更干净（visualScore 0.93 > 0.85），但标题里还有"保护壳套装"、且是黑色 ⇒ textScore 0.70 vs 0.88。' +
      '实测：visual-only = 黑 0.8634 > 白 0.8270 > 老款 0.7775 > 手环 0.5132 ⇒ **首选错位**；' +
      'text-only = 白 0.3395 > 黑 0.2779 > 老款 0.2381 > 手环 0.1972 ⇒ 纠正；' +
      'hybrid = 白 0.8636 > 黑 0.8512 > 老款 0.7874 > 手环 0.5776 ⇒ 纠正，但只赢 0.0124——这是本 fixture 里最脆的一次翻盘，颜色这类"文字里的硬属性"在 hybrid 里权重并不高。' +
      '标 1 而不是 2：颜色在二手交易里是买家会挑的属性；把"白"与"黑"标成等价，指标就看不出"颜色错配被排到第一"这种真实退化。',
  },
  {
    id: 'variant-books-volume',
    sampleClass: 'variant',
    query: {
      interpretation: {
        category: 'BOOKS',
        text: '高等数学 上册 第七版',
        keywords: ['高等数学', '同济'],
      },
    },
    candidates: [bookRealA, bookRealB, bookSameSeries, bookOtherSubject],
    relevance: relevanceOf([
      [bookRealA, 2],
      [bookRealB, 2],
      [bookSameSeries, 1],
      [bookOtherSubject, 1],
    ]),
    rationale:
      '教材套装：查询的是**上册**，下册名字只差一个字、封面几乎相同。下册的视觉分 0.94 只比上册 A 的 0.95 低一点，比上册 B 的 0.91 还高——图片路完全分不出"上/下册"。' +
      '实测：visual-only = 上册 A 0.9163 > 下册 0.8980 > 上册 B 0.8074 > 线代 0.6166（下册第 2，差距 0.0183；它 4 天前发布、9 收藏，新鲜度 0.912 甚至高于上册 A 的 0.831，把 0.01 的视觉劣势补掉了）；' +
      'text-only = 上册 A 0.3607 > 下册 0.3408 > 上册 B 0.2939 > 线代 0.2492（同样第 2）；' +
      'hybrid = 上册 A 0.9316 > 下册 0.9097 > 上册 B 0.8548 > 线代 0.6668（同样第 2）。' +
      '三路的第 1 名都是 rel=2 的上册 A，所以**这条不产生首选错位**，它暴露的是"分册级差异几乎贴在一起"：三路里上册 B（rel=2）都被下册（rel=1）压住。' +
      '标 1 给下册：它确实相关（同一门课、同一版次），但买家拍的是上册，买到下册没用。',
  },

  // -------------------------------------------------------------------------
  // exact：正样本（同款不同图），也是短板较短的两条
  // -------------------------------------------------------------------------
  {
    id: 'exact-camera-reorder',
    sampleClass: 'exact',
    query: { interpretation: { category: 'DIGITAL', brand: '罗技', model: 'C270' } },
    candidates: [camUnrelated, camOldVariant, camRealB, camRealA],
    relevance: relevanceOf([
      [camUnrelated, 0],
      [camOldVariant, 1],
      [camRealB, 2],
      [camRealA, 2],
    ]),
    rationale:
      '正样本，**候选池的输入顺序是乱的**（第一项是教材）：真机 A、真机 B 标 2，C270i 标 1，教材标 0。' +
      '实测：visual-only = 真机 A 0.9161 > 真机 B 0.8041 > 旧款 0.6938 > 教材 0.2383；' +
      'text-only = 真机 A 0.3535 > 真机 B 0.2961 > 旧款 0.1659 > 教材 0.1234；' +
      'hybrid = 真机 A 0.9355 > 真机 B 0.8567 > 旧款 0.7410 > 教材 0.1749。' +
      '三路排序完全一致且都正确——这条不制造分歧，它是**排序逻辑本身的冒烟测试**：排序器必须不照抄输入顺序才能把教材（输入第 1 项）压到最后。' +
      '旧款落在第 3 是对的：它 200 天前发布、0 收藏，freshness 0.010 几乎归零。',
  },
  {
    id: 'exact-keyboard-no-text',
    sampleClass: 'exact',
    query: { interpretation: { category: 'DIGITAL', brand: '罗技', model: 'K380' } },
    candidates: [kbdRealA, kbdRealB, kbdOtherModel, kbdMouseDistractor],
    relevance: relevanceOf([
      [kbdRealA, 2],
      [kbdRealB, 2],
      [kbdOtherModel, 1],
      [kbdMouseDistractor, 0],
    ]),
    rationale:
      '**查询图没有解析出文本**（所有候选 `textScore = null`，对应 `VISUAL_PARSE_TRANSPORT=off` 或图中无可读文字）。' +
      '实测：visual-only = 真机 A 0.9524 > 真机 B 0.8139 > K480 0.7742 > 鼠标 0.6149（rel 2/2/1/0，全对）；' +
      'text-only = 真机 A 0.1636 > K480 0.1097 > 鼠标 0.1055 > **真机 B 0.0930** ⇒ 排序里出现一次**倒置**：rel=0 的鼠标（40 天前、80 收藏）压过了 rel=2 的真机 B（21 天前、7 收藏）；' +
      'hybrid = 真机 A 0.7691 > 真机 B 0.6791 > K480 0.6532 > 鼠标 0.5497 ⇒ 倒置消失。' +
      '这是最能说明"缺项不能按 0 计入"的一条：文本路完全没有文本证据时，可用的只剩 freshness + popularity（合计 0.15），' +
      '排序就退化成"谁新谁受欢迎"，于是一条高热度鼠标爬到了真同款前面。若实现把 `null` 当成 `0` 参与加权，' +
      '两台 K380 会**同时**被拉低，鼠标只会更容易翻上来——这条守住那个回归。',
  },

  // -------------------------------------------------------------------------
  // unrelated：负样本池
  // -------------------------------------------------------------------------
  {
    id: 'unrelated-camera-pool',
    sampleClass: 'unrelated',
    query: { interpretation: { category: 'DIGITAL', brand: '罗技', model: 'C270' } },
    candidates: [camUnrelated, negRacket, negBike, negCameraNew, camRealA],
    relevance: relevanceOf([
      [camUnrelated, 0],
      [negRacket, 0],
      [negBike, 0],
      [negCameraNew, 2],
      [camRealA, 2],
    ]),
    rationale:
      '负样本池 + 两条真同款：教材（BOOKS）、球拍（SPORTS）、自行车（TRANSPORT）三类都与解析出的 DIGITAL 不一致 ⇒ categoryScore = 0，不会被"分类恰好相同"这种安慰性信号抬起。' +
      '全新未拆的 C270 全场最热（1 天前发布、30 收藏触顶）。' +
      '实测：visual-only = 全新 0.9196 > 真机 A 0.9161 > 教材 0.2383 > 球拍 0.1866 > 自行车 0.1839（**全新与真机 A 只差 0.0035**）；' +
      'text-only = 全新 0.3761 > 真机 A 0.3535 > 教材 0.1234 > 自行车 0.1042 > 球拍 0.0780（球拍的 textScore 是 null，缺项被剔除）；' +
      'hybrid = 真机 A 0.9355 > 全新 0.9197 > 教材 0.1749 > 自行车 0.1335 > 球拍 0.1414… 精确值：教材 0.1749 > 球拍 0.1414 > 自行车 0.1335（**真机 A 与全新只差 0.0158**）。' +
      '三路都把两条真同款排在负样本池之前，首选也都是 rel=2。负样本池在这里的作用是压低 `Top-5 人工相关率`（5 条里只有 2 条相关），不是制造分歧。',
  },
  {
    id: 'unrelated-same-category',
    sampleClass: 'unrelated',
    query: { interpretation: { category: 'DIGITAL', model: 'MX Master 3S' } },
    candidates: [miBand, negRacket, negBike, mx3s, mx3old],
    relevance: relevanceOf([
      [miBand, 0],
      [negRacket, 0],
      [negBike, 0],
      [mx3s, 2],
      [mx3old, 1],
    ]),
    rationale:
      '**分类相同的负样本**：小米手环是 DIGITAL，与解析出的分类一致 ⇒ categoryScore = 1，这是它唯一可能被"错抬"的路径；它必须仍然排在真同款之后。' +
      '实测：visual-only = 旧款 0.8297 > 新款 0.8141 > 手环 0.5132 > 球拍 0.1866 > 自行车 0.1839 ⇒ **首选错位**：旧款（rel=1）压过新款（rel=2）；' +
      'text-only = 新款 0.3293 > 旧款 0.2768 > 手环 0.1972 > 球拍 0.0780 > 自行车 0.1042 ⇒ 纠正；' +
      'hybrid = 新款 0.8837 > 旧款 0.8491 > 手环 0.5776 > 球拍 0.1414 > 自行车 0.1335 ⇒ 纠正。' +
      '手环虽然拿到 categoryScore 的 1，但 0.15 的权重不足以让一个 0.52/0.47 的候选翻过 0.90/1.00 的真同款——这条专门抓"把 categoryScore 做成加法偏置"的实现错误。',
  },
  {
    id: 'unrelated-text-match-box',
    sampleClass: 'unrelated',
    query: { interpretation: { category: 'DIGITAL', brand: '罗技', model: 'C270' } },
    candidates: [negBoxTextMatch, negRacket, bookOtherSubject, camRealA, negCameraNew],
    relevance: relevanceOf([
      [negBoxTextMatch, 0],
      [negRacket, 0],
      [bookOtherSubject, 0],
      [camRealA, 2],
      [negCameraNew, 2],
    ]),
    rationale:
      '**文本路的失败模式**：一条标题写着"罗技 C270 摄像头"的盒子（无机器）拿到 textScore 0.72，远高于无关品类；而球拍的 textScore 是 null。' +
      '三路排序：visual-only = 真机 A 0.898 > 全新 0.895 > 盒 0.800 > 线代 0.659 > 球拍 0.132；' +
      'text-only = 真机 A 0.950 > 全新 0.860 > 盒 0.720 > 线代 0.580 > 球拍（null 剔除）；' +
      'hybrid = 真机 A 0.896 > 全新 0.871 > 盒 0.819 > 线代 0.674 > 球拍 0.120。' +
      '**三路都把盒子排在两条真机之后**，但盒子在 text-only 与 hybrid 里都稳定占据第 3——它是本 fixture 里"纯文本排序也会犯错"的证据：只看文字，一个写着型号的空盒能进前 3。' +
      '这条的期望是三路**都不完美**：盒子的 relevance 是 0，它出现在 Top-5 里就是一次污染。',
  },
  {
    id: 'unrelated-same-category-noise',
    sampleClass: 'unrelated',
    query: { interpretation: { category: 'DIGITAL', keywords: ['数码', '闲置'] } },
    candidates: [miPowerBank, miBand, negTextbook, negBike, negCameraNew],
    relevance: relevanceOf([
      [miPowerBank, 0],
      [miBand, 0],
      [negTextbook, 0],
      [negBike, 0],
      [negCameraNew, 2],
    ]),
    rationale:
      '**宽泛关键词查询**（只解析出"数码/闲置"，没有型号）：三条无关项里两条是 DIGITAL（分类一致 ⇒ categoryScore = 1），另一条是 BOOKS。查询本身没有判别力，所以三路都只能靠相似度与热度。' +
      '三路排序：visual-only = 全新 0.895 > 充电宝 0.614 > 手环 0.564 > 教材 0.198 > 自行车 0.113；' +
      'text-only = 全新 0.860 > 充电宝 0.550 > 手环 0.470 > 教材 0.120 > 自行车 0.070；' +
      'hybrid = 全新 0.871 > 充电宝 0.640 > 手环 0.588 > 教材 0.212 > 自行车 0.137。' +
      '这条用来压 `Top-5 人工相关率`：三路都会把 4 条不相关项带进 Top-5，只有 1/5 相关。它说明**宽泛查询下排名再准也没用**——这是查询理解（M5）的问题，不是排序的问题。',
  },
  {
    id: 'exact-camera-clean',
    sampleClass: 'exact',
    query: { interpretation: { category: 'DIGITAL', model: 'C270', keywords: ['摄像头'] } },
    candidates: [camRealA, camRealB, camOldVariant, negCameraNew, camBoxOnly],
    relevance: relevanceOf([
      [camRealA, 2],
      [camRealB, 2],
      [camOldVariant, 1],
      [negCameraNew, 2],
      [camBoxOnly, 0],
    ]),
    rationale:
      '三件真同款 + 一件旧款 + 一个空盒，用来压 `Recall@K`：相关的有 5 条里的 4 条（3 条 rel=2 + 1 条 rel=1）。' +
      '三路排序：visual-only = 真机 A 0.898 > 全新 0.895 > 盒 0.867 > 真机 B 0.830 > 旧款 0.765 ⇒ **不相关项（盒）挤进前 3**，Recall@5 仍然是 1.0；' +
      'text-only = 真机 A 0.950 > 真机 B 0.920 > 全新 0.860 > 旧款 0.700 > 盒 0.400 ⇒ 五条里前四全相关；' +
      'hybrid = 真机 A 0.896 > 全新 0.871 > 真机 B 0.842 > 盒 0.701 > 旧款 0.628 ⇒ 盒被压到第 4。' +
      '注意 hybrid 的排序里旧款落在了盒子后面：旧款 200 天前发布、0 收藏，freshness 与 popularity 把它拖到 0.628；这是**刻意的取舍暴露**——一条真正相关（rel=1）的候选被一个不相关项反超。它记录为已知偏差，不修排序公式（要修得动 freshness 权重，那是产品口径）。',
  },
]

/**
 * 自检：每条样本都必须满足评测脚本会依赖的不变量。
 *
 * 放在模块加载期而不是单测里：fixture 是**数据**，写错 id（例如 `relevance` 里的 id
 * 不在 `candidates` 里）在离线腿里会表现为"这条样本没有相关项"，被静默算成一组
 * 看起来正常的 0 分——那是最难事后发现的一类错误。加载即抛，就没有"静默"这一说。
 */
function assertFixtureIntegrity(samples: readonly VisualEvalSample[]): void {
  const seen = new Set<string>()
  for (const sample of samples) {
    if (seen.has(sample.id)) throw new Error(`VISUAL_EVAL_FIXTURE 样本 id 重复：${sample.id}`)
    seen.add(sample.id)

    if (sample.candidates.length < 4) {
      throw new Error(`样本 ${sample.id} 的候选池少于 4 条，Top-5 相关率没有区分度`)
    }
    if (sample.rationale.length < 80) {
      throw new Error(`样本 ${sample.id} 的 rationale 太短，不足以支撑标注`)
    }

    const candidateIds = new Set(sample.candidates.map((candidate) => candidate.listingId))
    if (candidateIds.size !== sample.candidates.length) {
      throw new Error(`样本 ${sample.id} 的 candidates 里有重复 listingId`)
    }
    for (const listingId of Object.keys(sample.relevance)) {
      if (!candidateIds.has(listingId)) {
        throw new Error(
          `样本 ${sample.id} 的 relevance 引用了不在 candidates 里的 listingId：${listingId}`,
        )
      }
    }
    if (!sample.candidates.some((candidate) => (sample.relevance[candidate.listingId] ?? 0) >= 1)) {
      throw new Error(`样本 ${sample.id} 没有任何相关候选（relevance ≥ 1）`)
    }
  }

  // 整个 fixture 至少要有一条"全部候选都相关（没有 relevance = 0）"的样本：它把
  // Recall@K 钉在 1.0，从而暴露一个容易误读的结论——召回率在这种情况下不携带信息，
  // 只有 NDCG/MRR 还在区分"同款排第一"与"部分相关排第一"。fixture 的候选池是采样过的，
  // 因此这里的 1.0 **不能**被读成"线上召回率 100%"。
  if (!samples.some((sample) => Object.values(sample.relevance).every((value) => value >= 1))) {
    throw new Error('VISUAL_EVAL_FIXTURE 缺少"全部候选都相关（没有 relevance = 0）"的样本')
  }
  // 四类样本都要有，否则"按类别拆开看"的表会缺行。
  for (const sampleClass of ['exact', 'variant', 'category-mismatch', 'unrelated'] as const) {
    if (!samples.some((sample) => sample.sampleClass === sampleClass)) {
      throw new Error(`VISUAL_EVAL_FIXTURE 缺少 ${sampleClass} 类样本`)
    }
  }
}

assertFixtureIntegrity(VISUAL_EVAL_FIXTURE)
