/**
 * 举报域的纯数据与文案（pages/report-listing、pages/report-user、pages/my-reports 共用）。
 *
 * ## 为什么只有「枚举与文案」共用（两页不互通）
 *
 * Owner 2026-09-26 拍板：举报商品与举报用户是**两张独立页面**（入口分别在商品详情 /
 * 他人主页），各自持有自己的对象形态、原因胶囊与文案，互不跳转、页面结构互不复用。
 * 本模块只放两边按 #252 必须保持一致的**枚举、状态与文案**，不放任何页面结构。
 *
 * ## 契约对应（#252）
 *
 * 仓库 main 还没有 Report 契约（后端在 Draft PR #231/#240/#241，#217 的 TypeID 也未冻结），
 * 这里的 key 以 #252 文本冻结的原因枚举为准：
 * - 商品类：MISLEADING / PROHIBITED / FRAUD / SPAM / OTHER
 * - 用户类：HARASSMENT / FRAUD / IMPERSONATION / ABUSE / OTHER
 * 契约合并后若不一致，**以契约为准改这里的 key**（label / hint 可随意调，key 是对外的）。
 *
 * ## 结果文案的边界（#252 明确要求）
 *
 * 列表与详情只展示用户可见字段：状态三态（PENDING/HANDLED/REJECTED）之外，
 * **管理员处理原因不落端上**，`bannerCopy` 的文案也不提内部处理细节。
 *
 * 本模块不 import 任何 Taro / fixture 模块，`tests/reports.test.ts` 直接加载它。
 */

export type ReportTarget = 'LISTING' | 'USER'
export type ReportStatus = 'PENDING' | 'HANDLED' | 'REJECTED'

export type ReportReasonOption = {
  /** 后端原因枚举（#252）；对外值，不得随意改名 */
  key: string
  /** 胶囊文案 */
  label: string
  /** 选中后补充说明框的 placeholder：点名要「可核查的信息」——给不出可核查信息的举报没法处理 */
  hint: string
}

/** 商品类原因（#252）。顺序即稿子里胶囊的排布（3+2）。 */
export const LISTING_REPORT_REASONS: ReportReasonOption[] = [
  {
    key: 'MISLEADING',
    label: '描述与实物不符',
    hint: '请说明商品页描述与实际不符的地方（成色 / 型号 / 功能…），便于平台核对',
  },
  {
    key: 'PROHIBITED',
    label: '违禁品或禁售物',
    hint: '请说明涉嫌违规的品类或内容，以及你看到它的位置',
  },
  {
    key: 'FRAUD',
    label: '涉嫌欺诈',
    hint: '请提供对方的具体言行（如要求线下转账）与大致时间，便于核对会话记录',
  },
  {
    key: 'SPAM',
    label: '垃圾广告或引流',
    hint: '请说明引流方式（如外部链接 / 二维码 / 加微信）与出现的位置',
  },
  {
    key: 'OTHER',
    label: '其他',
    hint: '请描述该商品的违规情形，包含具体位置与内容',
  },
]

/** 用户类原因（#252）。与商品类是**两套枚举**，页面互不相通（见文件头）。 */
export const USER_REPORT_REASONS: ReportReasonOption[] = [
  {
    key: 'HARASSMENT',
    label: '骚扰',
    hint: '请说明对方骚扰的方式与大致时间，便于核对会话记录',
  },
  {
    key: 'FRAUD',
    label: '涉嫌欺诈',
    hint: '请提供对方的具体言行（如要求线下转账）与大致时间，便于核对会话记录',
  },
  {
    key: 'IMPERSONATION',
    label: '冒充他人',
    hint: '请说明对方冒充的身份（如同学 / 官方人员）以及你判断的依据',
  },
  {
    key: 'ABUSE',
    label: '辱骂或恶意行为',
    hint: '请描述对方的言行与大致时间，便于核对会话记录',
  },
  {
    key: 'OTHER',
    label: '其他',
    hint: '请描述该用户的违规情形，包含具体言行与时间',
  },
]

/** 两类页面的补充说明 placeholder 都用它（未选类型时） */
export const REPORT_DESC_DEFAULT_HINT = '选填：补充时间、对方言行等细节，帮助平台更快核查'

export function reasonsOf(target: ReportTarget): ReportReasonOption[] {
  return target === 'LISTING' ? LISTING_REPORT_REASONS : USER_REPORT_REASONS
}

/** 找不到时回传 key 本身（演示数据与枚举演进短暂错位时不至于渲染成空） */
export function reasonLabel(target: ReportTarget, key: string): string {
  return reasonsOf(target).find((r) => r.key === key)?.label ?? key
}

export function reasonHint(target: ReportTarget, key: string | null): string | null {
  if (key === null) return null
  return reasonsOf(target).find((r) => r.key === key)?.hint ?? null
}

/** 状态三态的展示元数据；tone 决定胶囊 / 横幅用哪套语义色（warn=审核中、ok=已处理、danger=已驳回） */
export const REPORT_STATUS_META: Record<
  ReportStatus,
  { label: string; tone: 'pending' | 'done' | 'rejected' }
> = {
  PENDING: { label: '审核中', tone: 'pending' },
  HANDLED: { label: '已处理', tone: 'done' },
  REJECTED: { label: '已驳回', tone: 'rejected' },
}

/**
 * 只读态横幅文案。**不提管理员处理原因**（#252：只展示用户可见字段）；
 * 已驳回要给「有新证据可重新提交」的出口，不留死胡同。
 */
export function bannerCopy(status: ReportStatus): { title: string; text: string } {
  if (status === 'PENDING') {
    return {
      title: '审核中',
      text: '我们已收到你的举报，会在核实后处理。审核中的举报无需重复提交，不影响处理进度。',
    }
  }
  if (status === 'HANDLED') {
    return {
      title: '已处理',
      text: '经平台核实，已对被举报内容作出处理。感谢你帮平台变得更好。',
    }
  }
  return {
    title: '已驳回',
    text: '经核实，该内容未违反平台规则。如果你有新的证据，欢迎重新提交举报。',
  }
}

/**
 * 「我的举报」空态文案。
 * - 真实构建：如实说缺口（举报表与接口都还没有，与 `pages/favorites` 的「收藏功能还没有后端」同一句式）；
 * - 演示构建：两个 tab 都有演示数据，这个分支只在数据被清空时兜底，不再说「没有后端」。
 */
export function emptyCopyOf(demo: boolean): {
  title: string
  text: string
  actionLabel: string | null
} {
  if (demo) {
    return {
      title: '还没有提交过举报',
      text: '在商品详情或对方主页点击「举报」，提交后记录和处理进度都会出现在这里。',
      actionLabel: null,
    }
  }
  return {
    title: '举报功能还没有后端',
    text: '服务端还没有举报表与接口（#252），提交入口也还没有开放。',
    actionLabel: '去逛逛',
  }
}

/**
 * 列表脚行的编号截断：`rpt_01J8ZQ3XK7M2` → `rpt_01J8Z…K7M2`。
 * 完整编号与「复制」只在填写页的只读态给（列表保持轻，复制是低频动作）。
 */
export function shortReportId(id: string): string {
  if (id.length <= 14) return id
  return `${id.slice(0, 9)}…${id.slice(-4)}`
}
