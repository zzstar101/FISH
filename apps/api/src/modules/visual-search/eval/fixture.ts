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
 * ## 样本由两部分组成：初版 12 条 + 对抗性审查 B1 补齐的 9 条
 *
 * 初版 12 条按"两路各自的失误模式"设计；复查时发现 Issue #324 M9 点名的若干**图像质量维度**
 * 在 fixture 里一条样本都没有（`grep` 结果：背景 0、多物体 0、模糊 0、低光 0、截图 0、
 * 同品牌 0、同色 0），另有三个维度只有名义覆盖（同款不同角度 / 同型号不同背景 /
 * 同色不同物体）。补齐的 9 条用 `scenario` 打标，并由 `REQUIRED_SCENARIOS` +
 * `assertFixtureIntegrity` 保证"每个点名维度至少有一条样本"——删掉会在加载期抛错。
 * 其中 `exact-parse-failed` 还补上了 `interpretation = null`（解析完全失败）这条从未被采样的路径。
 *
 * ## 当前的实测结果（改样本前先读这段）
 *
 * `bun run visual:eval` 在 21 条样本上得到：**首选与人工判断一致率** visual-only 12/21、
 * text-only 19/21、hybrid 21/21；**排序倒置数**（至少一条不相关项压过相关项）
 * 分别是 9 / 5 / 3 条；MRR 0.833 / 0.976 / 1.000，NDCG@10 0.855 / 0.959 / 0.993。
 * 也就是说：hybrid 的优势是**真实但很窄**——它同时赢了"首选命中"与"排序倒置"两项，
 * 但 `Recall@5` / `Recall@10` / `Top-5 人工相关率` 三路**完全一样**
 * （候选池每样本只有 4–5 条，Top-5 覆盖全池；Recall 的分母是标注出的相关项，
 * 只要不漏就都是 1.000；Top-5 相关率只取决于池子成分，与排序无关）。这不是脚本的缺陷，
 * 而是这个 fixture 分辨率的真实上限——想知道线上召回率与空结果率，必须跑 `visual:eval:db`。
 *
 * 补进来的 9 条把 visual-only 的优势削得很明显（它在这 9 条里只赢了 2 条）：背景复杂、
 * 多物体、模糊低光、截图、同品牌不同品类、同色不同物体这六个场景**都会让纯视觉排序首选错位**，
 * 同款不同角度则相反——文本路因为"照片里没有字"把真同款排到池底，只有视觉路能救。
 * 这正是 hybrid 存在的理由：两路的失误模式不重叠。
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

/**
 * 样本**场景标签**。比 `sampleClass` 细一层：`sampleClass` 说"这条是正/难/负样本"，
 * `scenario` 说"它到底在考哪一种真实场景"。
 *
 * 存在的理由是可核查的**覆盖面**。Issue #324 M9 点名的图像质量维度（背景复杂 / 多物体 /
 * 模糊低光 / 截图非实拍 / 同品牌不同品类）以及三个此前只有名义覆盖的维度
 * （同款不同角度 / 同型号不同背景 / 同色不同物体）如果只写在 rationale 的散文里，
 * 下一次改样本就可能把它们悄悄删掉，而指标不会有任何变化。这里给每个场景一个稳定标签，
 * 并由 `required-scenario` 那条完整性断言保证"每个必需场景至少有一条样本"——
 * 删掉样本会在模块加载期**直接抛错**。
 *
 * 与 `sampleClass` 正交：同一条样本只属于一个 `sampleClass`，但"同品牌不同品类"这种陷阱
 * 在标注上既可能是 `category-mismatch`（分类不同），也可能是 `unrelated`。
 *
 * 前 9 个是 `REQUIRED_SCENARIOS`（必需覆盖）；其余是既有样本的描述性标签，不参与覆盖断言。
 */
export type VisualEvalScenario =
  // —— Issue #324 M9 点名的维度（必需覆盖，见 REQUIRED_SCENARIOS） ——
  | 'complex-background' // 背景复杂：桌面/杂物占了大半画面
  | 'multiple-objects' // 一张图里多个物体，查询只指向其中一个
  | 'blurry-low-light' // 模糊 / 低光：查询图本身质量差
  | 'screenshot-not-photo' // 截图而非实拍：带 UI/文字的电商页截图
  | 'same-brand-different-category' // 同品牌不同品类（视觉同族，品类不符）
  | 'same-model-different-angle' // 同一件东西换个角度重拍
  | 'same-model-different-background' // 同型号换背景重拍
  | 'same-color-different-object' // 同颜色但完全不同的物体
  | 'parse-failed' // 语义解析完全失败（`interpretation = null`）
  // —— 既有 12 条样本的场景标签（描述性，不参与覆盖断言） ——
  | 'packaging-trap'
  | 'accessory-trap'
  | 'same-series-older-model'
  | 'same-model-different-color'
  | 'same-series-different-volume'
  | 'reordered-pool-smoke'
  | 'no-text-in-image'
  | 'negative-pool'
  | 'same-category-negative'
  | 'text-only-failure'
  | 'broad-keyword-query'
  | 'multi-exact-recall'

export type VisualEvalSample = {
  id: string
  /** 这条样本考的是哪种真实场景（覆盖断言按它检查，见 `REQUIRED_SCENARIOS`）。 */
  scenario: VisualEvalScenario
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
// 复查补齐（#324 M9 对抗性审查 B1）：图像质量维度 / 同品牌 / 同色 / 同款不同角度
//
// 这一组候选**只服务于下面 9 条新样本**，刻意不复用旧池里的常数：旧池那些候选的分数
// 已经在 12 条样本的 rationale 里被引用（"实测：visual-only = …"），改一个数就会让文档撒谎。
// 新样本要的是"同一个物件、不同拍摄条件"的对照，用一套独立常数最不容易互相污染。
// ---------------------------------------------------------------------------

// --- 同款不同角度：同一副 AirPods，换个角度重拍 -----------------------------

/**
 * 同一副 AirPods Pro 2，换一个角度重拍（例如把耳机盒立起来）。
 * 物件相同 ⇒ 图片路给高分（0.95）；这个角度拍不到可读型号文字 ⇒ 文本路几乎没有证据（0.25）。
 */
const airpodsAngleShot = candidate({
  listingId: 'airpods-angle-shot',
  title: 'AirPods Pro 2 白色（换个角度实拍）',
  category: 'DIGITAL',
  priceCents: 115000,
  visualScore: 0.95,
  textScore: 0.25,
  condition: 'LIKE_NEW',
  ageDays: 6,
  favoriteCount: 4,
})

/** 同款但另一副（正脸平铺照）：图片分略低，标题里型号齐全 ⇒ 文本分更高。 */
const airpodsColorShot = candidate({
  listingId: 'airpods-color-shot',
  title: 'AirPods Pro 2 白色 国行 全套',
  category: 'DIGITAL',
  priceCents: 118000,
  visualScore: 0.8,
  textScore: 0.45,
  ageDays: 9,
  favoriteCount: 6,
})

const airpodsOlderShot = candidate({
  listingId: 'airpods-older-shot',
  title: 'AirPods 3 白色 无降噪',
  category: 'DIGITAL',
  priceCents: 62000,
  visualScore: 0.78,
  textScore: 0.4,
  ageDays: 45,
  favoriteCount: 14,
})

// --- 同型号不同背景：同一台 K380，换到窗台/木桌 -----------------------------

/**
 * **同一型号** K380，只是换了个背景（窗台 + 木桌 + 绿植）。
 * 背景占了画面大半 ⇒ 图片路的分被摊薄（0.80）；型号文字对得上 ⇒ 文本路很高（0.90）。
 */
const kbdSameModelNewBg = candidate({
  listingId: 'kbd-same-model-new-bg',
  title: '罗技 K380 无线键盘 深灰',
  category: 'DIGITAL',
  priceCents: 12500,
  visualScore: 0.8,
  textScore: 0.9,
  ageDays: 4,
  favoriteCount: 5,
})

/** 另一个型号（K480）在纯色背景下的棚拍：图片路觉得"更像查询图"，型号其实不同。 */
const kbdOtherModelCleanBg = candidate({
  listingId: 'kbd-other-model-clean-bg',
  title: '罗技 K480 键盘 白色',
  category: 'DIGITAL',
  priceCents: 9000,
  visualScore: 0.9,
  textScore: 0.45,
  ageDays: 10,
  favoriteCount: 9,
})

// --- 背景复杂：同款教材放在凌乱桌面上 ---------------------------------------

/** 同款《高等数学 上册》，但查询图/商品图都是"凌乱书桌"：封面被杂物遮住大半 ⇒ 视觉分只有 0.72。 */
const bookClutteredReal = candidate({
  listingId: 'book-cluttered-real',
  title: '高等数学 上册 第七版 同济大学',
  category: 'BOOKS',
  priceCents: 2500,
  visualScore: 0.72,
  textScore: 0.92,
  ageDays: 5,
  favoriteCount: 8,
})

/** 另一本书，但它是**纯色封面棚拍**：背景干净 ⇒ 图片路反而给 0.85。 */
const bookCleanOtherSubject = candidate({
  listingId: 'book-clean-other-subject',
  title: '线性代数 第六版 同济大学',
  category: 'BOOKS',
  priceCents: 1500,
  visualScore: 0.85,
  textScore: 0.45,
  ageDays: 12,
  favoriteCount: 6,
})

/** 同系列下册，干净实拍：相关（rel=1）但不是查询的那一册。 */
const bookCleanSameSeries = candidate({
  listingId: 'book-clean-same-series',
  title: '高等数学 下册 第七版 同济大学',
  category: 'BOOKS',
  priceCents: 2200,
  visualScore: 0.8,
  textScore: 0.85,
  ageDays: 20,
  favoriteCount: 3,
})

// --- 多物体：一张桌上同时有键盘和鼠标 ---------------------------------------

/** 查询想找的键盘：它在这张"多物体"照片里也在，但不是画面主体 ⇒ 视觉分 0.88。 */
const kbdRealMulti = candidate({
  listingId: 'kbd-real-multi',
  title: '罗技 K380 无线键盘 深灰',
  category: 'DIGITAL',
  priceCents: 12500,
  visualScore: 0.88,
  textScore: 0.9,
  ageDays: 7,
  favoriteCount: 10,
})

/** 同一张照片里**最显眼**的那只鼠标：视觉分 0.93 全场最高，但它不是用户要找的东西。 */
const mouseProminentMulti = candidate({
  listingId: 'mouse-prominent-multi',
  title: '罗技 M330 静音无线鼠标（静音款）',
  category: 'DIGITAL',
  priceCents: 6900,
  visualScore: 0.93,
  textScore: 0.1,
  ageDays: 15,
  favoriteCount: 25,
})

const kbdOtherModelMulti = candidate({
  listingId: 'kbd-other-model-multi',
  title: '罗技 K480 键盘 白色',
  category: 'DIGITAL',
  priceCents: 9000,
  visualScore: 0.82,
  textScore: 0.5,
  ageDays: 20,
  favoriteCount: 6,
})

// --- 模糊 / 低光：查询图本身拍糊了 ------------------------------------------

/** 真机 C270，但查询图是低光 + 手抖：图片路只敢给 0.55。 */
const camBlurryReal = candidate({
  listingId: 'cam-blurry-real',
  title: '罗技 C270 网络摄像头（几乎全新）',
  category: 'DIGITAL',
  priceCents: 15900,
  visualScore: 0.55,
  textScore: 0.88,
  condition: 'LIKE_NEW',
  ageDays: 4,
  favoriteCount: 6,
})

/** 一张**清晰**的棚拍图，但拍的根本不是 C270：图片路被"清晰度"骗到 0.72。 */
const camCrispUnrelated = candidate({
  listingId: 'cam-crisp-unrelated',
  title: '罗技 C920 高清摄像头（另一款）',
  category: 'DIGITAL',
  priceCents: 29900,
  visualScore: 0.72,
  textScore: 0.2,
  ageDays: 10,
  favoriteCount: 12,
})

const camOldVariantLow = candidate({
  listingId: 'cam-old-variant-low',
  title: '罗技 C270i 摄像头 720p（老款）',
  category: 'DIGITAL',
  priceCents: 9900,
  visualScore: 0.6,
  textScore: 0.7,
  condition: 'FAIR',
  ageDays: 60,
  favoriteCount: 2,
})

// --- 截图而非实拍：查询图是电商详情页截图 -----------------------------------

/** 真同款，但查询图是**电商详情页截图**（带价格条/按钮/白底排版）⇒ 视觉分被 UI 拉低到 0.66。 */
const airpodsWhiteScreenshot = candidate({
  listingId: 'airpods-white-screenshot',
  title: 'AirPods Pro 2 白色 国行',
  category: 'DIGITAL',
  priceCents: 118000,
  visualScore: 0.66,
  textScore: 0.82,
  condition: 'LIKE_NEW',
  ageDays: 6,
  favoriteCount: 9,
})

const airpodsBlackScreenshot = candidate({
  listingId: 'airpods-black-screenshot',
  title: 'AirPods Pro 2 黑色 保护壳套装',
  category: 'DIGITAL',
  priceCents: 105000,
  visualScore: 0.64,
  textScore: 0.6,
  ageDays: 9,
  favoriteCount: 6,
})

/** 白底平铺的商品图：和"截图"的白底排版最像 ⇒ 视觉分 0.74，但它只是配件（OTHER）。 */
const ipadCaseScreenshot = candidate({
  listingId: 'ipad-case-screenshot',
  title: 'iPad 保护壳 11 英寸 通用',
  category: 'OTHER',
  priceCents: 2900,
  visualScore: 0.74,
  textScore: 0.4,
  ageDays: 17,
  favoriteCount: 4,
})

// --- 同品牌不同品类：小米 -----------------------------------------------

/** 查询要找的小米移动电源（同品牌同品类）。 */
const miPowerBankOwn = candidate({
  listingId: 'mi-powerbank-own',
  title: '小米移动电源 3 10000mAh',
  category: 'DIGITAL',
  priceCents: 6900,
  visualScore: 0.75,
  textScore: 0.8,
  ageDays: 6,
  favoriteCount: 21,
})

/** **同品牌不同品类**：小米米家台灯。白色极简外观与充电宝同族 ⇒ 图片路给 0.86（全场最高），品类却是 DAILY。 */
const miLampSameBrand = candidate({
  listingId: 'mi-lamp-same-brand',
  title: '小米米家台灯 Lite 白色',
  category: 'DAILY',
  priceCents: 7900,
  visualScore: 0.86,
  textScore: 0.55,
  ageDays: 9,
  favoriteCount: 12,
})

const miBandOwn = candidate({
  listingId: 'mi-band-own',
  title: '小米手环 8 NFC 版',
  category: 'DIGITAL',
  priceCents: 15900,
  visualScore: 0.52,
  textScore: 0.47,
  ageDays: 27,
  favoriteCount: 8,
})

// --- 同颜色但不同物体：全是白色 -------------------------------------------

/** 查询要找的白色 AirPods Pro 2。 */
const airpodsWhiteColor = candidate({
  listingId: 'airpods-white-color',
  title: 'AirPods Pro 2 白色 国行',
  category: 'DIGITAL',
  priceCents: 118000,
  visualScore: 0.85,
  textScore: 0.88,
  condition: 'LIKE_NEW',
  ageDays: 7,
  favoriteCount: 11,
})

/** **同颜色但完全不同的物体**：白色静音鼠标。颜色/材质/白底都像 ⇒ 图片路 0.90 反超真同款。 */
const whiteMouseColor = candidate({
  listingId: 'white-mouse-color',
  title: '罗技 M330 静音无线鼠标 白色',
  category: 'DIGITAL',
  priceCents: 6900,
  visualScore: 0.9,
  textScore: 0.3,
  ageDays: 5,
  favoriteCount: 6,
})

const airpodsBlackColor = candidate({
  listingId: 'airpods-black-color',
  title: 'AirPods Pro 2 黑色 保护壳套装',
  category: 'DIGITAL',
  priceCents: 105000,
  visualScore: 0.8,
  textScore: 0.6,
  ageDays: 9,
  favoriteCount: 6,
})

/** 另一个"白"：白色保温杯（DAILY）。 */
const whiteBottleColor = candidate({
  listingId: 'white-bottle-color',
  title: '白色保温杯 500ml 不锈钢',
  category: 'DAILY',
  priceCents: 4900,
  visualScore: 0.7,
  textScore: 0.15,
  ageDays: 20,
  favoriteCount: 4,
})

// --- 解析完全失败：interpretation = null ----------------------------------

/**
 * 这一组的 `textScore` **全是 `null`**，这是刻意的：`interpretation = null` 表示 M5 一行文本
 * 都没解析出来（`VISUAL_PARSE_TRANSPORT=off`、或图里根本没有可读文字），生产链路上
 * `visualTextQueryOf(interpretation) === null` ⇒ **文本路根本不会发起**。
 * 所以这里的 `null` 不是"文本分是 0"，而是"这一路不存在"。
 */
const parseFailedReal = candidate({
  listingId: 'parse-failed-real',
  title: '罗技 K380 无线键盘 深灰',
  category: 'DIGITAL',
  priceCents: 12500,
  visualScore: 0.96,
  textScore: null,
  ageDays: 12,
  favoriteCount: 20,
})

const parseFailedOtherModel = candidate({
  listingId: 'parse-failed-other-model',
  title: '罗技 K480 键盘 白色',
  category: 'DIGITAL',
  priceCents: 9000,
  visualScore: 0.82,
  textScore: null,
  ageDays: 15,
  favoriteCount: 9,
})

/** 高热度无关项：文本路完全没有证据时，它靠 popularity 挤到第一。 */
const parseFailedHotMouse = candidate({
  listingId: 'parse-failed-hot-mouse',
  title: '罗技 M330 静音无线鼠标（静音款）',
  category: 'DIGITAL',
  priceCents: 6900,
  visualScore: 0.62,
  textScore: null,
  ageDays: 5,
  favoriteCount: 80,
})

// ---------------------------------------------------------------------------
// fixture 本体：21 条样本
// ---------------------------------------------------------------------------

export const VISUAL_EVAL_FIXTURE: VisualEvalSample[] = [
  // -------------------------------------------------------------------------
  // category-mismatch：图片极像、分类不对（`visual-only` 会首选错位）
  // -------------------------------------------------------------------------
  {
    id: 'mismatch-camera-box',
    scenario: 'packaging-trap',
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
    scenario: 'accessory-trap',
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
    scenario: 'same-series-older-model',
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
    scenario: 'same-model-different-color',
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
    scenario: 'same-series-different-volume',
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
    scenario: 'reordered-pool-smoke',
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
    scenario: 'no-text-in-image',
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
    scenario: 'negative-pool',
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
    scenario: 'same-category-negative',
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
    scenario: 'text-only-failure',
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
    scenario: 'broad-keyword-query',
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
    scenario: 'multi-exact-recall',
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

  // -------------------------------------------------------------------------
  // 复查补齐（#324 M9 对抗性审查 B1）：同款不同角度 / 同型号不同背景
  // -------------------------------------------------------------------------
  {
    id: 'exact-airpods-same-angle',
    scenario: 'same-model-different-angle',
    sampleClass: 'exact',
    query: { interpretation: { category: 'DIGITAL', keywords: ['白色', '耳机'] } },
    candidates: [airpodsAngleShot, airpodsColorShot, airpodsOlderShot, miBand],
    relevance: relevanceOf([
      [airpodsAngleShot, 2],
      [airpodsColorShot, 1],
      [airpodsOlderShot, 1],
      [miBand, 0],
    ]),
    rationale:
      '**同一件东西换个角度重拍**（B1 补：旧样本 `variant-airpods-color` 只建模了颜色差，而且把差异放在 textScore 上，视觉路没有对应的"同物不同角度"样本）。' +
      '`airpods-angle-shot` 与查询图是同一副 AirPods Pro 2，只是立起来拍：图片路给 0.95（物件相同），' +
      '但这个角度拍不到可读的型号文字 ⇒ textScore 只有 0.25。' +
      '实测：visual-only = 角度 0.8801 > 平铺 0.7634 > 老款 0.7082 > 手环 0.5132 ⇒ 首选正确；' +
      'text-only = 平铺 0.2191 > 手环 0.1972 > 老款 0.1769 > **角度 0.1730（最后一名）** ⇒ **首选错位**：文本路因为"照片里没有字"把真正的同款排到了池底；' +
      'hybrid = 角度 0.7721 > 平铺 0.7362 > 老款 0.6904 > 手环 0.5776 ⇒ 纠正。' +
      '标 2 给角度、标 1 给另外两副：角度那条是同一副耳机，平铺那条是同款但不是同一副（二手交易里"同一副"意味着成色与来源已知），老款是 AirPods 3。' +
      '这条的意义：图片路的判别力**恰恰来自"是不是同一个物体"**，而文本路对"没有文字的角度照"完全失明——hybrid 必须靠视觉把这一票拿回来。',
  },
  {
    id: 'exact-keyboard-different-background',
    scenario: 'same-model-different-background',
    sampleClass: 'exact',
    query: {
      interpretation: { category: 'DIGITAL', brand: '罗技', model: 'K380', keywords: ['键盘'] },
    },
    candidates: [kbdSameModelNewBg, kbdOtherModelCleanBg, kbdMouseDistractor, bookOtherSubject],
    relevance: relevanceOf([
      [kbdSameModelNewBg, 2],
      [kbdOtherModelCleanBg, 1],
      [kbdMouseDistractor, 0],
      [bookOtherSubject, 0],
    ]),
    rationale:
      '**同一型号、不同背景**（B1 补：旧样本 `exact-keyboard-no-text` 的维度是"查询图里没有文字"，不是背景）。' +
      '同一台 K380 换到窗台/木桌上重拍：背景占了画面大半，图片路的分被摊薄到 0.80；' +
      '而另一型号 K480 是纯色棚拍，图片路给到 0.90——**背景干净不等于"更像"**。' +
      '实测：visual-only = K480 0.8490 > K380 0.7749 > 线代 0.6166 > 鼠标 0.6149 ⇒ **首选错位**（型号错了）；' +
      'text-only = K380 0.3337 > 线代 0.2492 > K480 0.2257 > 鼠标 0.1055 ⇒ 纠正；' +
      'hybrid = K380 0.8337 > K480 0.7919 > 鼠标 0.5497 > 线代 0.5168 ⇒ 纠正（K380 领先 0.0418）。' +
      '标 2 给 K380、标 1 给 K480：型号不同就是不同的东西，但同品牌同品类仍算"相关"。' +
      '注意 text-only 里出现**一次倒置**：rel=0 的线代（0.2492）压过 rel=1 的 K480（0.2257）——纯文本路在"书名 vs 键盘型号"上没有可比性。',
  },

  // -------------------------------------------------------------------------
  // 复查补齐（#324 M9 对抗性审查 B1）：图像质量维度
  // -------------------------------------------------------------------------
  {
    id: 'quality-complex-background',
    scenario: 'complex-background',
    sampleClass: 'exact',
    query: {
      interpretation: { category: 'BOOKS', text: '高等数学 上册 第七版', keywords: ['高等数学'] },
    },
    candidates: [bookClutteredReal, bookCleanOtherSubject, bookCleanSameSeries, negRacket],
    relevance: relevanceOf([
      [bookClutteredReal, 2],
      [bookCleanOtherSubject, 0],
      [bookCleanSameSeries, 1],
      [negRacket, 0],
    ]),
    rationale:
      '**背景复杂**（B1 补：Issue #324 M9 点名维度之一）。同款《高等数学 上册》拍在凌乱书桌上，封面被杂物遮掉大半 ⇒ 图片路只给 0.72；' +
      '另一本《线性代数》是纯色封面棚拍 ⇒ 图片路 0.85。' +
      '实测：visual-only = 线代 0.7935 > 下册 0.7238 > **上册 0.7217（第 3）** > 球拍 0.1866 ⇒ **首选错位**，而且真同款被压到第三；' +
      'text-only = 上册 0.3448 > 下册 0.2829 > 线代 0.2127 > 球拍 0.0780 ⇒ 纠正；' +
      'hybrid = 上册 0.8031 > 下册 0.7905 > 线代 0.7558 > 球拍 0.1213 ⇒ 纠正（上册只领先下册 0.0126）。' +
      '标 0 给线代：不同科目的教材，拍它没有用。' +
      '这条是"图像质量维度会直接吃掉视觉路判别力"的证据：**背景越干净 ≠ 越像**，纯视觉排序在这里把真同款排到了第 3。',
  },
  {
    id: 'quality-multiple-objects',
    scenario: 'multiple-objects',
    sampleClass: 'exact',
    query: { interpretation: { category: 'DIGITAL', model: 'K380', keywords: ['键盘'] } },
    candidates: [kbdRealMulti, mouseProminentMulti, kbdOtherModelMulti, miBand],
    relevance: relevanceOf([
      [kbdRealMulti, 2],
      [mouseProminentMulti, 0],
      [kbdOtherModelMulti, 1],
      [miBand, 0],
    ]),
    rationale:
      '**一张图里多个物体**（B1 补：Issue #324 M9 点名维度之一）。用户拍了一张"桌上有键盘也有鼠标"的照片来找键盘。' +
      '鼠标在画面里最显眼 ⇒ 图片路 0.93（全场最高）；键盘虽然也在图里但不是主体 ⇒ 0.88。' +
      '实测：visual-only = 鼠标 0.9011 > 键盘 0.8463 > K480 0.7508 > 手环 0.5132 ⇒ **首选错位**（把画面主体当成了查询意图）；' +
      'text-only = 键盘 0.3413 > K480 0.2094 > 手环 0.1972 > 鼠标 0.1655 ⇒ 纠正；' +
      'hybrid = 键盘 0.8801 > 鼠标 0.7557 > K480 0.7380 > 手环 0.5776 ⇒ 首选纠正，但**鼠标（rel=0）仍然排在第 2**，压过 rel=1 的 K480 ⇒ 一次倒置。' +
      '标 0 给鼠标：它是同一张照片里最显眼的东西，却不是用户要找的东西。' +
      '这条钉住的是"多物体查询图"这个真实场景：视觉相似度的分母是整张图，而用户问的是图里的**某一个**物体。',
  },
  {
    id: 'quality-blurry-low-light',
    scenario: 'blurry-low-light',
    sampleClass: 'exact',
    query: { interpretation: { category: 'DIGITAL', brand: '罗技', model: 'C270' } },
    candidates: [camBlurryReal, camCrispUnrelated, camOldVariantLow, camUnrelated],
    relevance: relevanceOf([
      [camBlurryReal, 2],
      [camCrispUnrelated, 0],
      [camOldVariantLow, 1],
      [camUnrelated, 0],
    ]),
    rationale:
      '**模糊 / 低光**（B1 补：Issue #324 M9 点名维度之一）。查询图是低光 + 手抖拍的真机 C270，图片路只敢给 0.55；' +
      '另一条是**清晰**棚拍的 C920（另一款摄像头），图片路被"清晰度"骗到 0.72。' +
      '实测：visual-only = C920 0.7221 > C270 0.5864 > C270i 0.5077 > 教材 0.2383 ⇒ **首选错位**；' +
      'text-only = C270 0.3320 > C270i 0.2000 > C920 0.1757 > 教材 0.1234 ⇒ 纠正；' +
      'hybrid = C270 0.7072 > C920 0.6594 > C270i 0.6200 > 教材 0.1749 ⇒ 首选纠正，但 C920（rel=0）仍排第 2，压过 rel=1 的 C270i ⇒ 一次倒置。' +
      '标 0 给 C920：它是另一个型号，"拍得清楚"不构成相关性。' +
      '这条的意义：低光/模糊会**同时**压低所有候选的视觉分，但压得最狠的恰恰是真同款（它本来最像），' +
      '于是"图拍糊了"在纯视觉排序里会伪装成"这条不像"——hybrid 靠文本路才救回来。',
  },
  {
    id: 'quality-screenshot-not-photo',
    scenario: 'screenshot-not-photo',
    sampleClass: 'exact',
    query: {
      interpretation: { category: 'DIGITAL', model: 'AirPods Pro 2', keywords: ['耳机'] },
    },
    candidates: [airpodsWhiteScreenshot, airpodsBlackScreenshot, ipadCaseScreenshot, negTextbook],
    relevance: relevanceOf([
      [airpodsWhiteScreenshot, 2],
      [airpodsBlackScreenshot, 1],
      [ipadCaseScreenshot, 0],
      [negTextbook, 0],
    ]),
    rationale:
      '**截图而非实拍**（B1 补：Issue #324 M9 点名维度之一）。查询图不是实物照，而是电商详情页截图（白底排版 + 价格条 + 按钮）。' +
      '真同款的视觉分因此被 UI 拉低到 0.66；一条白底平铺的 iPad 保护壳（OTHER）反而更像"截图"的排版 ⇒ 0.74。' +
      '实测：visual-only = 保护壳 0.6885 > 白 AirPods 0.6762 > 黑 AirPods 0.6403 > 教材 0.2690 ⇒ **首选错位**（只差 0.0123）；' +
      'text-only = 白 0.3218 > 黑 0.2544 > 保护壳 0.1853 > 教材 0.1281 ⇒ 纠正；' +
      'hybrid = 白 0.7536 > 黑 0.6862 > 保护壳 0.5275 > 教材 0.1989 ⇒ 纠正。' +
      '标 0 给保护壳：它是配件且品类不同（OTHER）。' +
      '这条钉住的是"截图"这个真实入口（用户从别的 App 截图来搜）：截图带的是**版面特征**，不是商品特征。',
  },

  // -------------------------------------------------------------------------
  // 复查补齐（#324 M9 对抗性审查 B1）：同品牌不同品类 / 同色不同物 / 解析失败
  // -------------------------------------------------------------------------
  {
    id: 'brand-same-brand-different-category',
    scenario: 'same-brand-different-category',
    sampleClass: 'category-mismatch',
    query: {
      interpretation: { category: 'DIGITAL', brand: '小米', keywords: ['充电宝', '移动电源'] },
    },
    candidates: [miPowerBankOwn, miLampSameBrand, miBandOwn, negTextbook],
    relevance: relevanceOf([
      [miPowerBankOwn, 2],
      [miLampSameBrand, 0],
      [miBandOwn, 0],
      [negTextbook, 0],
    ]),
    rationale:
      '**同品牌不同品类**（B1 补：Issue #324 M9 点名维度之一）。查询要找小米移动电源，池里放了一盏小米米家台灯：' +
      '白色极简外观与充电宝是同一套设计语言 ⇒ 图片路给 0.86（全场最高），但它的品类是 DAILY（解析出的是 DIGITAL）。' +
      '实测：visual-only = 台灯 0.8327 > 充电宝 0.7878 > 手环 0.5132 > 教材 0.2690 ⇒ **首选错位**；' +
      'text-only = 充电宝 0.3495 > 台灯 0.2603 > 手环 0.1972 > 教材 0.1281 ⇒ 纠正；' +
      'hybrid = 充电宝 0.8221 > 台灯 0.6512 > 手环 0.5776 > 教材 0.1989 ⇒ 纠正（台灯被 categoryScore=0 砍掉那 0.15 权重）。' +
      '标 0 给台灯：品牌相同不是相关性，"同一套工业设计"恰恰是最容易骗到多模态模型的东西。' +
      '这条专门抓"把 brand 当强信号"的实现错误——解析出 `brand: 小米` 时，一个把品牌加成加进分数的实现会直接把台灯抬到第一。',
  },
  {
    id: 'unrelated-same-color-different-object',
    scenario: 'same-color-different-object',
    sampleClass: 'unrelated',
    query: {
      interpretation: { category: 'DIGITAL', model: 'AirPods Pro 2', keywords: ['白色'] },
    },
    candidates: [airpodsWhiteColor, whiteMouseColor, airpodsBlackColor, whiteBottleColor],
    relevance: relevanceOf([
      [airpodsWhiteColor, 2],
      [whiteMouseColor, 0],
      [airpodsBlackColor, 1],
      [whiteBottleColor, 0],
    ]),
    rationale:
      '**同颜色但不同物体**（B1 补：旧样本 `unrelated-same-category` 是"同品类异商品"，颜色这一维没有被建模）。' +
      '池里全是白色的东西：真同款白色 AirPods、白色静音鼠标、白色保温杯。颜色/材质/白底都像 ⇒ 图片路给鼠标 0.90，反超真同款的 0.85。' +
      '实测：visual-only = 鼠标 0.8524 > AirPods 0.8270 > 黑 AirPods 0.7634 > 保温杯 0.6508 ⇒ **首选错位**；' +
      'text-only = AirPods 0.3395 > 黑 0.2544 > 鼠标 0.1930 > 保温杯 0.1212 ⇒ 纠正；' +
      'hybrid = AirPods 0.8636 > 黑 0.7662 > 鼠标 0.7641 > 保温杯 0.4530 ⇒ 纠正，但**黑 AirPods 只领先白色鼠标 0.0021**——这是本 fixture 里最脆的一次翻盘。' +
      '标 0 给鼠标与保温杯：颜色不是物体。标 1 给黑色同款：型号相同、颜色不同（与 `variant-airpods-color` 同一口径）。' +
      '这条把"颜色"从文字属性（`variant-airpods-color` 里颜色写在查询文字里）变成了**纯视觉陷阱**：图里颜色对得上，但东西完全不对。',
  },
  {
    id: 'exact-parse-failed',
    scenario: 'parse-failed',
    sampleClass: 'exact',
    query: { interpretation: null },
    candidates: [parseFailedReal, parseFailedOtherModel, parseFailedHotMouse, negRacket],
    relevance: relevanceOf([
      [parseFailedReal, 2],
      [parseFailedOtherModel, 1],
      [parseFailedHotMouse, 0],
      [negRacket, 0],
    ]),
    rationale:
      '**语义解析完全失败**（B1 补：既有 12 条样本的 `query.interpretation` 全部非 null，离线腿从来没采样过这条路径）。' +
      '`interpretation = null` 在生产链路上有两个后果，这条样本把两个都钉住：' +
      '① `visualTextQueryOf(null) === null` ⇒ 文本路**根本不发起**（不是"文本分是 0"），所以池里所有候选的 `textScore` 都是 `null`（表示"这一路不存在"）；' +
      '② 解析不出分类 ⇒ `categoryScore` 整项剔除。' +
      '实测：visual-only = 真机 0.9320 > K480 0.7742 > 鼠标 0.6909 > 球拍 0.1866 ⇒ 首选正确；' +
      'text-only = **鼠标 0.1636（rel=0）** > 真机 0.1480 > K480 0.1097 > 球拍 0.0780 ⇒ **首选错位**：文本路失去全部判别力后只剩 freshness + popularity，' +
      '一条 5 天前发布、80 收藏的高热度鼠标爬到了真同款前面；' +
      'hybrid = 真机 0.9320 > K480 0.7742 > 鼠标 0.6909 > 球拍 0.1866 ⇒ 纠正。' +
      '**hybrid 的分数与 visual-only 逐位相同**（0.9320 / 0.7742 / 0.6909 / 0.1866）：文本项与分类项都被剔除，hybrid 退化成纯视觉排序。' +
      '这不是巧合而是实现不变量：`rankSample` 在 `visualTextQueryOf(interpretation) === null` 时必须把 `textScore` 传 `null`（而不是 `?? 0`），' +
      '否则会以 0.2 的权重给所有候选同时减去一个 0 分项——顺序不变，但"hybrid 在解析失败时退化成 visual-only"这个性质就再也测不出来了。' +
      '标 1 给 K480：同品牌同品类，型号不同。',
  },
]

/**
 * **必需覆盖**的场景（#324 M9 点名的图像质量维度 + 三个此前只有名义覆盖的维度）。
 *
 * 这份清单是"样本类别的可执行规格"：`assertFixtureIntegrity` 会断言每个场景至少有一条样本。
 * 加维度时先加到这里，再加样本——反过来（只加样本）会让下一个人无从知道哪些维度是**承诺过**的。
 */
export const REQUIRED_SCENARIOS: readonly VisualEvalScenario[] = [
  'complex-background',
  'multiple-objects',
  'blurry-low-light',
  'screenshot-not-photo',
  'same-brand-different-category',
  'same-model-different-angle',
  'same-model-different-background',
  'same-color-different-object',
  'parse-failed',
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
  // 必需场景覆盖（#324 M9 对抗性审查 B1）：这些维度必须**始终**至少有一条样本承载，
  // 否则"补过样本"只存在于 git 历史里，下一个人删掉它不会有任何反馈。
  for (const scenario of REQUIRED_SCENARIOS) {
    if (!samples.some((sample) => sample.scenario === scenario)) {
      throw new Error(`VISUAL_EVAL_FIXTURE 缺少必需场景 ${scenario} 的样本`)
    }
  }
}

assertFixtureIntegrity(VISUAL_EVAL_FIXTURE)
