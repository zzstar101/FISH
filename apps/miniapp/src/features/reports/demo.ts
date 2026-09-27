/**
 * 「我的举报」的演示数据（`pages/my-reports` 用；填写页的只读态也从这里找记录）。
 *
 * ## 演示口径（与 `pages/favorites` / `features/comments` 同一体系）
 *
 * 后端 `GET /reports/mine` 与 `POST /reports` **已经接线**（#252）：真实构建先发请求，
 * 只有请求失败且构建开关允许时才回退到这里（判据见 `./load` 的 `DEMO_REPORTS_ENABLED`），
 * 页面据 `demo` 标志渲染「演示数据」说明带。下面 7 条只在本地演示 / 预览构建里出现。
 *
 * ## 数据照稿（`小程序1版我的举报.html`）
 *
 * 商品 4 条 + 用户 3 条，PENDING/HANDLED/REJECTED 三态都出现；`rpt_` 编号与时间都是
 * 演示占位（编号只为撑样式与复制动线）。这 7 条**不与「我的」页任何数字对齐**
 * （`demoProfile()` 没有举报计数），别当成跨页一致性要求。
 *
 * ## 演示提交的「落库」只落在进程内存
 *
 * 演示兜底路径下提交举报不会真的保存，但为了让「提交 → 查看我的举报 → 点进详情」
 * 动线在演示里能走通，`rememberDemoReport()` 把这条记录**追加进本次进程的列表头**
 * （与 `pages/history` 的「演示清空仅页面实例内生效」同一取舍）：重启小程序就消失，
 * 不落 storage、更不落服务端。
 *
 * 本模块不 import 任何 Taro / fixture 模块，`tests/reports.test.ts` 直接加载它。
 */
import type { ReportStatus, ReportTarget } from './meta'

export type ReportRecord = {
  /** 举报编号（`rpt_` 前缀；真实记录来自后端返回的 `report.id`） */
  id: string
  target: ReportTarget
  /** 商品标题 / 用户昵称。真实记录是「被举报商品 / 被举报用户」这种占位称呼，见 `./map` */
  objTitle: string
  /** 商品价格文案（数字部分，页面自己补「¥」）；用户举报恒为 null */
  objPrice: string | null
  /**
   * 被举报对象的公开 ID（`lst_` / `usr_`）。真实记录由后端 `report.targetId` 带入；
   * 用户端 DTO **不返回对象摘要**（`ReportSchema` 没有标题字段），页面拿它给用户指认对象。
   * 演示数据不带（样例标题本身就是可读的），所以是可选的。
   */
  objId?: string
  /** 原因枚举（target 对应的那套，见 `meta.ts`） */
  reason: string
  /** 补充说明原文；空串 = 提交时未填写（详情行显示「未填写」） */
  desc: string
  /** 提交时间文案（演示占位；真实记录由 `createdAt` 派生，见 `./map`） */
  timeLabel: string
  status: ReportStatus
}

export const DEMO_REPORTS: ReportRecord[] = [
  {
    id: 'rpt_01J8ZQ3XK7M2',
    target: 'LISTING',
    objTitle: '戴尔 U2419H 显示器（成色不错）',
    objPrice: '450',
    reason: 'FRAUD',
    desc: '卖家在会话里要求微信转账，不走平台下单流程，说可以便宜 50 元。',
    timeLabel: '09-25 21:07',
    status: 'PENDING',
  },
  {
    id: 'rpt_01J8YB9WD4N6',
    target: 'LISTING',
    objTitle: '九成新 iPad Air 5 蓝色 64G',
    objPrice: '2399',
    reason: 'MISLEADING',
    desc: '商品页写「国行在保」，实际是美版无保修。',
    timeLabel: '09-24 18:42',
    status: 'HANDLED',
  },
  {
    id: 'rpt_01J8XF2CQ8T1',
    target: 'LISTING',
    objTitle: '小米台灯 Pro 全新未拆封',
    objPrice: '89',
    reason: 'SPAM',
    desc: '疑似商家引流，会话里一直发外部链接。',
    timeLabel: '09-23 12:15',
    status: 'PENDING',
  },
  {
    id: 'rpt_01J8VE5HK3P9',
    target: 'LISTING',
    objTitle: '三只松鼠零食大礼包',
    objPrice: '25.8',
    reason: 'OTHER',
    desc: '担心是临期商品，想请平台看看资质。',
    timeLabel: '09-21 09:03',
    status: 'REJECTED',
  },
  {
    id: 'rpt_01J8TN7RD2M4',
    target: 'USER',
    objTitle: '老张的杂货铺',
    objPrice: null,
    reason: 'FRAUD',
    desc: '成交后拉黑，钱货两空。',
    timeLabel: '09-24 19:40',
    status: 'HANDLED',
  },
  {
    id: 'rpt_01J8SC1XP6K8',
    target: 'USER',
    objTitle: '校园跑腿小王',
    objPrice: null,
    reason: 'HARASSMENT',
    desc: '交易取消后频繁私信催促、打扰，一天发十几条。',
    timeLabel: '09-23 20:11',
    status: 'PENDING',
  },
  {
    id: 'rpt_01J8RA9GB3W2',
    target: 'USER',
    objTitle: 'AA代抢代缴',
    objPrice: null,
    reason: 'IMPERSONATION',
    desc: '冒充学生会成员收费代办校园业务。',
    timeLabel: '09-22 14:26',
    status: 'REJECTED',
  },
]

/**
 * 演示提交产生的记录（进程内存，见文件头）。**按 id 去重，商品 / 用户两类各占一条**
 * （两填写页互不相通，各自只写自己的那条）：反复提交同一类时，「我的举报」里出现的
 * 是该类的最后一次，且一类不会被另一类顶掉。
 */
const submittedReports: ReportRecord[] = []
export const DEMO_SUBMITTED_LISTING_ID = 'rpt_01J8DEMOL001'
export const DEMO_SUBMITTED_USER_ID = 'rpt_01J8DEMOU001'

export function rememberDemoReport(record: ReportRecord): void {
  const i = submittedReports.findIndex((r) => r.id === record.id)
  if (i >= 0) submittedReports.splice(i, 1)
  submittedReports.unshift(record)
}

/**
 * 按编号取一条**演示**记录；找不到、或记录的目标类型与调用方期望的不符时返回 null。
 *
 * 两点都是刻意的：
 * - `target` 必须对得上 —— 商品举报页拿用户举报的记录去渲染，会把「举报用户」的原因与
 *   对象当成商品举报解释（两套原因是不同的枚举）；
 * - 调用方**必须**先用演示开关判据（`DEMO_REPORTS_ENABLED`）拦住真实构建：本模块是纯数据，
 *   自身不认构建模式，真实构建下调用它就会把样例记录当成真实处理结果渲染出去。
 */
export function findDemoReport(id: string, target: ReportTarget): ReportRecord | null {
  const hit =
    submittedReports.find((r) => r.id === id) ?? DEMO_REPORTS.find((r) => r.id === id) ?? null
  return hit !== null && hit.target === target ? hit : null
}

/**
 * 按编号取一条**演示**记录，**不校验目标类型**。
 *
 * 只给「填写页的只读态」用：那里先按编号取到记录、再交给 `resolveReportView` 判定
 * target 是否对得上并给出「这条举报打不开」。这样「编号存在但类型不符」与「编号不存在」
 * 走的是同一个出口，两页的判定逻辑（含测试）不用各写一份。
 *
 * **真实构建不得调用**（同 `findDemoReport`：本模块不认构建模式）。
 */
export function findDemoReportById(id: string): ReportRecord | null {
  return submittedReports.find((r) => r.id === id) ?? DEMO_REPORTS.find((r) => r.id === id) ?? null
}

const DEMO_LATENCY = 120

/** 演示提交的记录排最前（最新在前），其余按稿的顺序 */
export function loadDemoReports(): Promise<ReportRecord[]> {
  return new Promise((resolve) => {
    setTimeout(() => resolve([...submittedReports, ...DEMO_REPORTS]), DEMO_LATENCY)
  })
}
