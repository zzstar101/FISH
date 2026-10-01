import type { IconName } from '@/assets/lib-icons'

/**
 * 法务文档（用户协议 / 隐私政策）的**数据模型** —— 两份文档共用一套渲染组件
 * （`components/legal-doc`），所以结构必须能同时表达两者的形态差异：
 *
 * - 用户协议有「重要提示」强调块（`callout`）与左竖线的 `key` 块；
 * - 隐私政策有「一句话摘要」卡（`brief`）、信息清单（`list`）与「我们不会收集这些」（`notlist`）。
 *
 * 尺寸与配色的唯一真源是 `styles/_token-vars.scss`；本文件只管数据形状。
 * 内容本身在 `./terms.ts` 与 `./privacy.ts`，两个文件都标注为**未定内容页面**。
 */

/**
 * 行内富文本片段。稿里的行内标记有三种，一一对应：
 * - `<strong>` → `b`（加粗：需要提请注意的免责、责任限制语句）
 * - `<em>` → `em`（斜体说明：清单里「何时收集」那一小段）
 * - `<span class="ph">` → `ph`（**待填占位**：虚线 + 警示色，上线前必须替换）
 *
 * 拆成片段而不是整段塞 HTML：小程序没有 `dangerouslySetInnerHTML`，
 * `Text` 嵌套 `Text` 才是唯一可靠的行内样式手段（`text` 节点的子节点必须是 `text`）。
 */
export type Run = {
  /**
   * React 列表 key。**只在同一个片段数组里出现重复文本时才生成**
   * （实测只有两页页脚那行的两个「待填」）—— 其余数组直接用文本本身当 key：
   * 片段数组是静态数据，位置就是稳定标识，给每一段都塞一个 key 只会淹掉正文。
   * 不用数组下标：Biome 的 `suspicious/noArrayIndexKey` 会判为不稳定 key。
   */
  k?: string
  /** 文本本身 */
  t: string
  /** 加粗 */
  b?: boolean
  /** 斜体说明（稿 `em`，实际按等宽小字落地） */
  em?: boolean
  /** 待填占位（稿 `.ph`） */
  ph?: boolean
}

/** 信息清单行尾的必要性标签（稿 `.tag` 的四种色调） */
export type TagTone = 'on' | 'opt' | 'off' | 'note'

export type ListItem = {
  /**
   * React 列表 key。**由数据带出来而不是在 JSX 里用数组下标** ——
   * Biome 的 `suspicious/noArrayIndexKey` 在 react 域默认开启，纯下标会被判为不稳定 key。
   */
  key: string
  /** 信息项名（`em` 片段是本地存储 key 这类等宽内容） */
  name: Run[]
  tag: { text: string; tone: TagTone }
  /** 用途说明 */
  use: Run[]
}

/** 带图标的分组小标题（稿 `.list-hd` / `.notlist-hd`） */
export type GroupHead = {
  /** 库内图标名（见 `assets/lib-icons.ts` 的 `ICONS`） */
  icon: IconName
  text: string
}

/** 正文块。顺序即稿内顺序，渲染组件按 `kind` 分派。 */
export type Block =
  | { key: string; kind: 'clause'; no: string; runs: Run[] }
  | { key: string; kind: 'key'; runs: Run[] }
  | { key: string; kind: 'sub'; no: string; runs: Run[] }
  | { key: string; kind: 'callout'; head: string; runs: Run[] }
  | { key: string; kind: 'notlist'; head: GroupHead; runs: Run[] }
  | { key: string; kind: 'list'; head: GroupHead; items: ListItem[] }

export type LegalSection = {
  /** 锚点 id（`s1`…），目录跳章与 `createSelectorQuery` 都用它 */
  id: string
  /** 章序号（一 / 二 / …） */
  num: string
  title: string
  blocks: Block[]
}

/** 「一句话摘要」卡（稿 `.brief`，只有隐私政策有） */
export type LegalBrief = {
  head: string
  lead: Run[]
  items: Run[][]
}

export type LegalDoc = {
  /** 导航条居中标题（稿 `.mp-title`）：滚过文档头之后淡入 */
  navTitle: string
  kicker: { icon: IconName; text: string }
  title: string
  /** 文档头的元信息行，每项一段片段（版本 / 更新日期 / 生效日期） */
  meta: Run[][]
  /** 摘要卡（可选） */
  brief?: LegalBrief
  /** 重要提示块（可选） */
  callout?: { head: string; runs: Run[] }
  sections: LegalSection[]
  /** 页脚注释（稿 `.doc-foot p`）：外层每个数组是**一行**（稿里的 `<br>`），逐行渲染 */
  footNote: Run[][]
  /** 页脚互链胶囊 */
  links: { icon: IconName; label: string; page: string }[]
  /**
   * 吸底同意条（稿 `.agree-bar`，设计状态 02）。**只在从登录/注册流程进入时渲染** ——
   * 从设置页进来是纯阅读，对一个已经生效的协议再点一次「同意」语义是错的。
   */
  agree: { note: string; ok: string; no: string }
}
