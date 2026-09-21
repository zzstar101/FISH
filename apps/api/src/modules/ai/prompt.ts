import { AI_POLISH_CANDIDATE_MAX } from '@fish/contracts/ai/schema'
import type { ListingCategory } from '@fish/contracts/listings/schema'
import { ListingCategorySchema } from '@fish/contracts/listings/schema'

/**
 * 上游 prompt 与版本号（#141 设计 §3.3 / §9）。
 *
 * 运行时改 prompt 属独立迭代：**改本文件即升版本**（与 `MODERATION_RULE_VERSION` 同一惯例），
 * 版本号随用量一起落 `ai_polish_requests.prompt_version`。脱敏规则没有对应的落库版本
 * （`ai_polish_requests` 没有该列，见设计 §6.1），别把这两者的可追溯性混为一谈。
 */
export const PROMPT_VERSION = '2026-09-21-v2'

/**
 * 分类的中文标签由**服务端**解析：请求只收枚举值，不接受客户端传标签文本，堵住
 * "伪造上下文诱导模型"的口子（设计 §4.1）。本表只服务本模块的 prompt，不是全仓标签来源
 * ——web / miniapp 各有一份自己的前端标签表，抽公共层要等有第二个服务端调用方。
 */
const CATEGORY_LABELS: Record<ListingCategory, string> = {
  DIGITAL: '数码电子',
  BOOKS: '图书教材',
  BEAUTY: '美妆个护',
  DAILY: '生活用品',
  SPORTS: '运动健身',
  APPAREL: '服饰鞋包',
  TRANSPORT: '代步工具',
  OTHER: '其他闲置',
}

/**
 * 系统提示词。第 1、2 条来自实测：探针 2 里模型确实照抄过 "标题：/分类：/描述：" 字段名
 * （设计 §9），服务端另有 §5.6b 硬校验兜底；第 6 条是回填的前提——标记被改写或删掉，
 * 那条候选就会整条降级（§5.7）。
 */
const SYSTEM_PROMPT = `你是校内二手交易平台的文案助手，负责把学生写的原始描述改写成更清晰、更好读的商品描述。

严格遵守以下规则：
1. 只输出描述正文本身。不要复述"标题""分类""描述"这类字段名，不要写开场白、解释、编号或 Markdown 标记。
2. 一共输出 ${AI_POLISH_CANDIDATE_MAX} 条候选，每条之间用单独一行的 === 分隔；正文里不要再出现 ===。
3. 每条候选不超过 500 字。
4. 不得新增或改动原文没有的事实：数字、价格、成色、容量、型号、品牌、数量都保持原样；也不要添加"包邮""正品""可退换"这类承诺。
5. 不要写出"加微信""微信号""vx""v信""二维码""外链"这类字样（平台审核会拦下整条候选），也不要添加原文没有的联系方式、链接或地址；需要表达可以联系时，写"有意者私聊"就够了。
6. 原文中形如 [fish-phone-1]、[fish-card-2] 的占位符是敏感信息占位，必须原样保留（含序号），不得改写、翻译、删除或补充。
7. 语言自然简洁，突出对校内买家有用的信息。`

export type PolishPromptInput = {
  title: string
  description: string
  category: ListingCategory
}

/** 只拼装文本，不做脱敏——送进来的 `description` 必须已是脱敏后的标记版（设计 §5.3）。 */
export function buildPolishPrompt(input: PolishPromptInput): { system: string; user: string } {
  const user = [
    `商品标题：${input.title}`,
    `商品分类：${categoryLabelFor(input.category)}`,
    '原始描述：',
    input.description,
  ].join('\n')

  return { system: SYSTEM_PROMPT, user }
}

/**
 * 标签表与枚举的一致性：加了新分类却忘了补标签，prompt 里就会写进 `undefined`。
 * 导出给测试用，避免运行时才发现。
 */
export function categoryLabelFor(category: ListingCategory): string {
  const label = CATEGORY_LABELS[category]
  if (!label) {
    throw new Error(
      `分类 ${category} 缺少中文标签：请同步 CATEGORY_LABELS（当前值域 ${ListingCategorySchema.options.join('/')}）`,
    )
  }
  return label
}
