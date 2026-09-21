/**
 * 发布页的 **AI 润色候选** fixture。
 *
 * **与契约的边界**：AI 润色后端能力在 #141、miniapp 接线在 #142，两者都还没落地，
 * 所以候选仍是本地 mock。真实实现由后端调模型生成候选，前端只负责
 * 「展示候选 → 采用 / 换一条 / 放弃」。这里给几条**与原文同义**的润色结果，
 * 保证「采用前不覆盖原文」这条交互能被验证。
 *
 * **审核判定不在这里**（#74 已落地）：BLOCK 的字段级原因来自服务端 422 的
 * `error.details`，前端不再保留任何敏感词表，也不自行判定违规。
 *
 * 页面不内联任何假数据：候选从这里取。
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
