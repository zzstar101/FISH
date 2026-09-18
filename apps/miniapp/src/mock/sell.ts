/**
 * D1 发布页增补域的 fixture：AI 润色候选文案 + 审核失败反馈。
 *
 * **与契约的边界**（两条都还没落地，前端只做视觉与交互）：
 * - AI 润色（Issue #75 未开工）：真实实现由后端调模型生成候选，前端只负责
 *   「展示候选 → 采用 / 换一条 / 放弃」。这里给几条**与原文同义**的润色结果，
 *   保证「采用前不覆盖原文」这条交互能被验证。
 * - 审核失败（#74，PR #80 被 CHANGES_REQUESTED）：真实实现返回的是**命中的违规片段**
 *   （起止位置 + 词），前端按位置标红。这里退化成「命中词清单」，因为
 *   前端没有可靠的定位算法之前，标红必须落在具体词上（设计稿第 03 帧就是这么画的）。
 *
 * 页面不内联任何假数据：候选与违规词都从这里取。
 */

/** AI 润色候选：与「原文」同义的三种改写（顺序 = 稿子「第 1 / 3 条」） */
export type PolishCandidate = {
  id: string
  text: string
}

/**
 * 润色候选是按**输入框内容**生成的，mock 里用一组通用模板填充 `{原文}` 的变体。
 *
 * 之所以不做「按关键词生成」：那样会让不同商品的候选文案看起来互不相关，
 * 反而更难验收「换一条」这条交互。真实实现里这些文案来自模型。
 *
 * 拼接前先剥掉原文结尾的句读，否则会出现「…都可以。。成色与附件…」这种双句号。
 */
const stripTail = (text: string): string => text.trim().replace(/[。.！!？?，,、；;：:]+$/, '')

const TEMPLATES: ((origin: string) => string)[] = [
  // 结构更完整：先一句话概括卖什么，再讲成色与附件，最后给交付方式
  (origin) =>
    `${stripTail(origin)}。成色与附件都写清楚了，支持校内面交，价格可小刀，看中的同学直接聊。`,
  // 更口语、更短，突出「为什么值得买」
  (origin) =>
    `出一件自己用过的闲置：${stripTail(origin)}。性能与外观都没问题，当面验货更放心，诚心要的价格好谈。`,
  // 面向「同校自提」的写法，把交付方式提到前面
  (origin) =>
    `校内自提优先。${stripTail(origin)}，东西一直在宿舍用，功能完好、附件齐全，欢迎当面看成色。`,
]

export function polishCandidates(origin: string): PolishCandidate[] {
  return TEMPLATES.map((build, index) => ({
    id: `polish-${index + 1}`,
    text: build(origin),
  }))
}

/* ------------------------------------------------------------ 审核失败 */

/**
 * 违规词表（mock）。
 *
 * 真实实现里这是服务端返回的结果，前端**不应该**自己判定违规——这里为了能演示
 * 「审核失败 + 定位到具体输入框」的视觉，才在前端保留一份最小词表。
 * 因此判定函数返回的也是「命中的词」，与后端返回的语义一致。
 */
const VIOLATION_WORDS = ['代写', '包过', '代考', '刷单', '外挂', '代刷']

export function findViolations(text: string): string[] {
  return VIOLATION_WORDS.filter((word) => text.includes(word))
}

export type ModerationResult = {
  /** 标题命中的违规词 */
  title: string[]
  /** 描述命中的违规词 */
  description: string[]
  /** 命中总数（页头提示条的「N 处需要修改」按字段数算，不是词的个数） */
  fieldCount: number
  passed: boolean
}

export function moderate(title: string, description: string): ModerationResult {
  const titleHits = findViolations(title)
  const descHits = findViolations(description)
  const fieldCount = (titleHits.length > 0 ? 1 : 0) + (descHits.length > 0 ? 1 : 0)
  return { title: titleHits, description: descHits, fieldCount, passed: fieldCount === 0 }
}
