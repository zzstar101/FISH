import type { ReportCreateResponse, UserReportReason } from '@fish/contracts/reports/schema'
import { UserIdSchema } from '@fish/contracts/system/public-id'
import { Image, Text, Textarea, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import NavBar from '@/components/nav-bar'
import { DEMO_AUTH_ENABLED } from '@/features/auth/demo'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { MOCK_FALLBACK_ENABLED } from '@/features/load-failure'
import { submitReport } from '@/features/reports/api'
import {
  DEMO_SUBMITTED_USER_ID,
  type ReportRecord,
  rememberDemoReport,
} from '@/features/reports/demo'
import { DEMO_REPORTS_ENABLED, loadReportRecord } from '@/features/reports/load'
import { submittedRecord } from '@/features/reports/map'
import {
  bannerCopy,
  REPORT_DESC_DEFAULT_HINT,
  REPORT_STATUS_META,
  reasonHint,
  reasonLabel,
  reasonsOf,
  submitFailureText,
} from '@/features/reports/meta'
import {
  beginReportTask,
  isReportTaskCurrent,
  reportOwnerChanged,
  resolveReportView,
  unavailableCopy,
  wantsReportRecord,
} from '@/features/reports/view'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { routeParam } from '@/lib/route-param'
import './index.scss'

/**
 * 举报用户（稿 `小程序1版举报用户.html`）。
 *
 * ## 两张独立页面，互不相通（Owner 2026-09-26 拍板）
 *
 * 举报用户（本页，入口：他人主页「举报用户」）与举报商品（`pages/report-listing`）是
 * 两张独立页面：各自持有对象形态、原因胶囊与文案，互不跳转。两页只共用
 * `features/reports` 里的枚举 / 状态 / 文案常量（#252 冻结的那部分），页面结构互不复用。
 *
 * ## 同一页面的三种形态（入口 query 决定，页内不切换）
 *
 * - **新建**：他人主页带 `id / nickname / avatar` 进入。对象卡固定不可改；
 *   公开资料子集只带头像与昵称（#86 边界：不带教育邮箱 / 手机号 / 校区）。
 *   提交用的目标 ID 是 `params.id`（对方主页传的是契约 `usr_` 公开 ID），**裸 UUID 或错前缀
 *   在发请求前就被挡下**（`UserIdSchema.safeParse` + 契约 `ReportCreateInputSchema`）。
 * - **只读**：「我的举报」点用户卡带 `reportId` 进入 —— 按该条记录的状态渲染
 *   审核中 / 已处理 / 已驳回横幅 + 内容卡（编号可复制，给客服对账用）。
 * - **打不开**：带 `reportId` 但取不到记录。**不退回新建态** —— 那会让「打开一条记录」
 *   静默变成「凭空举报一个没有对象的用户」；由 `features/reports/view` 的
 *   `resolveReportView` 判定，页面对应地说明原因。
 *
 * ## 只读记录的来源（#252 接线）
 *
 * 契约**没有单条举报读取端点**（`REPORT_ROUTES` 只有 create / mine），所以：
 * - 真实构建：`loadReportRecord(reportId)` 翻 `GET /reports/mine` 找这条（见 `load.ts`），
 *   查询期间渲染加载占位；
 * - 演示构建：记录就在打包产物里，`resolveReportView` 同步取（`demoEnabled`），不发请求。
 *   真实构建**绝不**回落到样例数据 —— 那等于给用户看一条带「已处理 / 已驳回」的虚构结论。
 *
 * ## 提交的口径（#252）
 *
 * 后端 `POST /reports` 已接线，真实构建直接提交，并据响应的 `created` 分两种成功：
 * `created: true` →「举报已提交」；`created: false` →「这条举报已受理」（同一未决目标的
 * 重复提交，服务端返回 200 而不是报错）。
 *
 * 演示构建（`TARO_APP_MOCK=1`）先试真实请求，只有请求**没到过后端**（网络层失败，或演示假会话
 * 必然拿到的 401）才回退到本地模拟并把记录追加进进程内存，重启即消失。服务端给了业务错误码时
 * **不**回退 —— 那会把「失败」说成「成功」（#193 / #261 复查 P2 同款要求）。
 *
 * ## 账号作用域（PR #280 复查 P2-1）
 *
 * 只读记录、提交结果与成功态都是**当前账号的私有数据**，而页面实例会跨过一次换号。所以：
 * 只读查询与提交各自持有一个「任务」（账号 + 代次），落地前先过 `isReportTaskCurrent`；
 * 换号在渲染期同步清场并让代次前进；身份未就绪不发私有读取；卸载也作废在途任务。
 * 判据是纯逻辑，单测在 `tests/reports.test.ts`。
 *
 * ## 成功卡的权威来源（PR #280 复查 P2-3）
 *
 * 卡里的原因 / 说明 / 时间 / 状态一律取服务端返回的 `res.report`（`doneOf`），**不取本次输入**。
 * `created:false` 时服务端返回的是此前那条，本次填的内容没有落库，卡片换成「已受理的举报」
 * 并明确说明「没有被新增进去」—— 不能用本地成功卡让用户以为新证据已被受理。
 *
 * ## 顶部栏 / 鉴权
 *
 * `NavBar glass`（fixed 玻璃底 + 居中双色标题）常驻吸顶；`useAuthGuard()` 在
 * 确定未登录时自动 redirectTo 登录页（#252「未登录引导登录」）。
 */

const REASONS = reasonsOf('USER')
const REASON_MAX = 200
/** 演示构建口径：mock 回退与演示登录态**都要**开（两个注入点可单独打开，只认 MOCK_FALLBACK 会顶掉真实空态） */
const DEMO_MODE = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

/** 成功态落定后的内容（`created` 决定文案：本次新建 / 此前已受理） */
type SubmitDone = { record: ReportRecord; created: boolean; simulated: boolean }

/**
 * 把服务端返回的举报记录翻成成功态要展示的内容。
 *
 * **卡里的原因 / 说明 / 时间 / 状态一律取 `res.report`，不取本次输入**：`created:false` 时
 * 服务端返回的是此前那条（`ON CONFLICT DO NOTHING`，本次输入没有落库），若照搬本次输入，
 * 用户会以为刚补充的证据已经被受理（PR #280 复查 P2-3）。映射本体是
 * `features/reports/map.ts` 的 `submittedRecord`（可单测），这里只补「是否本地模拟」。
 */
function doneOf(res: ReportCreateResponse, nowMs: number): SubmitDone {
  return { ...submittedRecord(res, nowMs), simulated: false }
}

/**
 * 这次提交失败能不能按演示口径模拟成功。
 *
 * 只有「请求根本没到过后端」才可以：网络层失败、契约解析失败，以及演示构建里假会话
 * 必然拿到的 `UNAUTHENTICATED`。服务端若给了业务错误码（用户不存在 / 不能举报自己 / 冲突…），
 * 说明请求真的到达了后端，改用模拟就是把失败说成成功。
 */
function canSimulateSubmit(error: unknown): boolean {
  if (!DEMO_REPORTS_ENABLED) return false
  return !isApiError(error) || error.code === 'UNAUTHENTICATED'
}

export default function ReportUser() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  /** 当前账号（公开 `usr_…` ID）。只读记录、提交结果与 `busy` 锁都归属它 */
  const userId = user?.id ?? null
  /** 路由参数读一次：两种入口都靠 query 定形态，页内不切换（跳转都是重新开页） */
  const { params } = useRouter()
  const reportId = params.reportId
  /** 入口带没带 `reportId`（判据与 `resolveReportView` 同一个，见 `features/reports/view`）。 */
  const wantsRecord = wantsReportRecord(reportId)

  /** 真实构建按编号查到的记录；演示构建不用它（记录同步可得） */
  const [record, setRecord] = useState<ReportRecord | null>(null)
  /** 真实构建的查询是否已落定；新建态与演示构建一开始就是 true */
  const [lookupDone, setLookupDone] = useState(!wantsRecord || DEMO_MODE)

  /** 账号作用域：换号时同步清场并让代次前进，让在途的读取 / 提交任务失效（PR #280 复查 P2-1） */
  const [prevUserId, setPrevUserId] = useState<string | null>(null)
  const epochRef = useRef(0)
  /** 与 `epochRef.current` 同步的账号：提交任务落地前要拿它比对，不能读闭包里的旧值 */
  const ownerRef = useRef<string | null>(null)

  useEffect(() => {
    // 身份没就绪就不发私有读取：演示假会话下 `unknown → authed` 会翻转一次，
    // 早退后由本 effect 重跑补上（此前失败一次就再也不会重读）
    if (!wantsRecord || DEMO_MODE || authStatus !== 'authed' || userId === null) return
    const task = beginReportTask(epochRef.current, userId)
    void loadReportRecord(reportId as string).then((hit) => {
      // 迟到的结果不再 setState：既可能是页面已卸载，也可能是这中间换了账号
      if (!isReportTaskCurrent(task, epochRef.current, ownerRef.current)) return
      setRecord(hit)
      setLookupDone(true)
    })
    return () => {
      epochRef.current += 1
    }
  }, [wantsRecord, reportId, authStatus, userId])

  /** `null` = 记录还在查（只有真实构建的只读入口会经过） */
  const view = lookupDone
    ? resolveReportView({ reportId, target: 'USER', demoEnabled: DEMO_MODE, record })
    : null
  const mode = view === null ? null : view.mode
  const viewRecord = view === null ? null : view.record

  /** 新建态的举报对象（对方主页带入，页内不可改）。query 未解码，取值统一过 `routeParam` */
  const target = {
    nickname: routeParam(params.nickname),
    avatar: routeParam(params.avatar),
  }
  /** 提交用的目标 ID：对方主页传的是契约 `usr_` 公开 ID */
  const targetId = params.id ?? ''

  const [chosen, setChosen] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [typeErr, setTypeErr] = useState(false)
  const [fieldFocus, setFieldFocus] = useState(false)
  /** 提交在飞：防重复提交（#252） */
  const [busy, setBusy] = useState(false)
  /** null = 还在表单；非 null = 成功态已落定（整页切换，不再回到表单） */
  const [done, setDone] = useState<SubmitDone | null>(null)

  /*
   * 换号清场（渲染期同步做，不放进 effect）：A 读到 / 提交出的记录、表单内容与 `busy` 锁
   * 都属于 A，B 不该看到，也不该被 A 的在途请求解锁。与 `pages/sell/index.tsx` 的
   * `ownerChanged` 清场同源。
   */
  if (reportOwnerChanged(prevUserId, userId)) {
    setPrevUserId(userId)
    ownerRef.current = userId
    epochRef.current += 1
    setRecord(null)
    setLookupDone(!wantsRecord || DEMO_MODE)
    setChosen(null)
    setDesc('')
    setTypeErr(false)
    setFieldFocus(false)
    setBusy(false)
    setDone(null)
  }

  useEffect(
    () => () => {
      // 卸载也作废在途任务：成功 / 失败 / 提示 / `finally` 都不该再落到已离开的页面
      epochRef.current += 1
    },
    [],
  )

  const navTotalHeight = readNavMetrics().totalHeight

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const chosenHint = reasonHint('USER', chosen)

  const copyId = (id: string) => {
    void Taro.setClipboardData({ data: id })
    // 微信会在复制成功后弹自己的「内容已复制」提示，这里不再叠一层 toast
  }

  const submit = () => {
    if (busy || done !== null) return
    if (chosen === null) {
      setTypeErr(true)
      toast('请先选择举报类型')
      return
    }
    // 身份没就绪就不发：`busy` 锁与成功态都归属当前账号，没有账号就没有归属
    if (authStatus !== 'authed' || userId === null) return
    // 目标 ID 先在本端验一遍：入口 query 可能是被改坏的深链，或旧版本页面传的裸 uuid。
    // 契约 `ReportCreateInputSchema` 也会拦（提交前 `parse`），但那时的报错文案对用户无意义。
    const parsedId = UserIdSchema.safeParse(targetId)
    if (!parsedId.success) {
      toast('举报对象编号无效，请从对方主页重新进入')
      return
    }
    // 胶囊来自 `reasonsOf('USER')`，取值必属用户类枚举；契约提交前还会再校验一次（superRefine）
    const reason = chosen as UserReportReason
    const detail = desc.trim()
    const task = beginReportTask(epochRef.current, userId)
    setBusy(true)
    void (async () => {
      try {
        const res = await submitReport({
          targetType: 'USER',
          targetId: parsedId.data,
          reason,
          detailText: detail === '' ? undefined : detail,
        })
        if (!isReportTaskCurrent(task, epochRef.current, ownerRef.current)) return
        setDone(doneOf(res, Date.now()))
      } catch (error) {
        if (!isReportTaskCurrent(task, epochRef.current, ownerRef.current)) return
        if (canSimulateSubmit(error)) {
          // 演示「落库」：追加进进程内存，让「我的举报」列表与只读态都能看到这条（见 demo.ts 文件头）
          const demoRecord: ReportRecord = {
            id: DEMO_SUBMITTED_USER_ID,
            target: 'USER',
            objTitle: target.nickname || '（未带出昵称）',
            objPrice: null,
            objId: targetId === '' ? undefined : targetId,
            reason,
            desc: detail,
            timeLabel: '刚刚',
            status: 'PENDING',
          }
          rememberDemoReport(demoRecord)
          setDone({ record: demoRecord, created: true, simulated: true })
        } else {
          toast(submitFailureText(isApiError(error) ? error.code : null))
        }
      } finally {
        // A 的 `finally` 不能解开 B 已经点下的那一次，否则 B 会重复发出请求
        if (isReportTaskCurrent(task, epochRef.current, ownerRef.current)) setBusy(false)
      }
    })()
  }

  /** 成功态主按钮：用 redirectTo 把表单页换成列表页（返回键回到对方主页，栈不加深） */
  const goMyReports = () => {
    void Taro.redirectTo({ url: '/pkg-trade/pages/my-reports/index' })
  }

  const navTitle = (
    <Text>
      举报
      <Text className="rpu__navem">{mode === 'fill' ? '用户' : '详情'}</Text>
    </Text>
  )

  /* ── 对象头像：主页带真实头像就用，否则占位（演示记录同样占位） ── */
  const avatarOf = (avatar: string, sizeClass: string) =>
    avatar ? (
      <Image className={`rpu__ava ${sizeClass}`} src={avatar} mode="aspectFill" />
    ) : (
      <View className={`rpu__ava-ph ${sizeClass}`}>
        <Image className="rpu__ava-ph-ic" src={ICONS.user} mode="aspectFit" />
      </View>
    )

  /* ── 键值行：成功态「提交内容」与只读态「举报内容」共用同一套结构 ── */
  const rowsOf = (data: {
    objTitle: string
    objAvatar: string
    /** 被举报对象的公开 ID；真实记录有（契约 `targetId`），成功态刚提交时也有 */
    objId?: string
    reason: string
    desc: string
    timeLabel: string
    id: string
  }) => (
    <>
      <View className="rpu__kvobj">
        {avatarOf(data.objAvatar, 'rpu__ava--sm')}
        <View className="rpu__obj-main">
          <Text className="rpu__obj-name">{data.objTitle}</Text>
          {/* 用户端 DTO 不返回被举报人的昵称（`ReportSchema` 只有 targetId），
              所以真实记录靠这行公开 ID 让用户指认自己举报的是谁 */}
          {data.objId ? <Text className="rpu__obj-sub num">{data.objId}</Text> : null}
        </View>
      </View>
      <View className="rpu__kv">
        <Text className="rpu__kv-k">举报类型</Text>
        <View className="rpu__kv-v">
          <Text className="rpu__rtag">{reasonLabel('USER', data.reason)}</Text>
        </View>
      </View>
      <View className="rpu__kv">
        <Text className="rpu__kv-k">补充说明</Text>
        <Text className={`rpu__kv-v${data.desc ? '' : ' is-dim'}`}>{data.desc || '未填写'}</Text>
      </View>
      <View className="rpu__kv">
        <Text className="rpu__kv-k">提交时间</Text>
        <Text className="rpu__kv-v num">{data.timeLabel}</Text>
      </View>
      <View className="rpu__kv">
        <Text className="rpu__kv-k">举报编号</Text>
        <View className="rpu__kvid">
          <Text className="rpu__kv-v num">{data.id}</Text>
          <View className="rpu__copy" onClick={() => copyId(data.id)}>
            <Text>复制</Text>
          </View>
        </View>
      </View>
    </>
  )

  return (
    <View className="rpu">
      <NavBar glass titleAlign="center" title={navTitle} />
      {/* 玻璃栏是 fixed：内容让出栏高（状态栏 + 导航行，设备 px，见 nav-metrics.ts） */}
      <View style={{ height: `${navTotalHeight}px` }} />

      {authStatus !== 'authed' ? (
        <View className="rpu__auth">
          <AuthRequired restoring={authStatus === 'unknown'} />
        </View>
      ) : mode === null ? (
        /* ═══ 只读入口的取数占位（真实构建按编号翻 `/reports/mine`，列表进详情通常只闪一下） ═══ */
        <View className="rpu__content">
          <Text className="rpu__loading">加载中…</Text>
        </View>
      ) : mode === 'view' && viewRecord !== null ? (
        /* ═══ 只读态：审核中 / 已处理 / 已驳回（入口：「我的举报」点用户卡） ═══ */
        <View className="rpu__content">
          <View className={`rpu__banner is-${REPORT_STATUS_META[viewRecord.status].tone}`}>
            <Image
              className="rpu__banner-ic"
              src={
                viewRecord.status === 'HANDLED'
                  ? ICONS.checkAccent
                  : viewRecord.status === 'REJECTED'
                    ? ICONS.warnInk
                    : ICONS.clockInk
              }
              mode="aspectFit"
            />
            <View className="rpu__banner-main">
              <Text className="rpu__banner-t">{bannerCopy(viewRecord.status).title}</Text>
              <Text className="rpu__banner-s">{bannerCopy(viewRecord.status).text}</Text>
            </View>
          </View>

          <View className="rpu__card">
            <View className="rpu__card-hd">
              <Text className="rpu__card-h2">举报内容</Text>
            </View>
            {rowsOf({
              objTitle: viewRecord.objTitle,
              objAvatar: '',
              objId: viewRecord.objId,
              reason: viewRecord.reason,
              desc: viewRecord.desc,
              timeLabel: viewRecord.timeLabel,
              id: viewRecord.id,
            })}
          </View>

          {DEMO_MODE ? (
            <Text className="rpu__demonote">演示记录：来自演示构建的样例数据。</Text>
          ) : null}

          <View className="rpu__acts">
            <View className="rpu__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回「我的举报」</Text>
            </View>
          </View>
        </View>
      ) : mode === 'unavailable' ? (
        /* ═══ 打不开：带 reportId 却取不到记录（见文件头「三种形态」） ═══ */
        <View className="rpu__content">
          <View className="rpu__emptypad">
            <EmptyState
              title={unavailableCopy(DEMO_MODE).title}
              text={unavailableCopy(DEMO_MODE).text}
              icon={ICONS.shieldLine}
            />
          </View>
          <View className="rpu__acts">
            <View className="rpu__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回「我的举报」</Text>
            </View>
          </View>
        </View>
      ) : done !== null ? (
        /* ═══ 成功态（02）：不 toast 了事，整页落成功并给「我的举报」动线 ═══
              `created:false` 表示这个未决目标此前已受理过，文案不能再说一次「已提交」 */
        <View className="rpu__content">
          <View className="rpu__hero">
            <View className="rpu__hero-ic">
              <Image className="rpu__hero-ic-img" src={ICONS.checkAccent} mode="aspectFit" />
            </View>
            <Text className="rpu__hero-t">{done.created ? '举报已提交' : '这条举报已受理'}</Text>
            <Text className="rpu__hero-s">
              {done.created
                ? '平台会在核实后处理，处理结果可在「我的举报」中查看。'
                : '同一个用户此前已经举报过，平台正在核实，无需重复提交。'}
            </Text>
          </View>

          <View className="rpu__card">
            <View className="rpu__card-hd">
              {/* `created:false` 时卡里是**此前那条**的内容，标题不能再说「提交内容」 */}
              <Text className="rpu__card-h2">{done.created ? '提交内容' : '已受理的举报'}</Text>
            </View>
            {rowsOf({
              objTitle: target.nickname || done.record.objTitle,
              objAvatar: target.avatar,
              objId: done.record.objId,
              reason: done.record.reason,
              desc: done.record.desc,
              timeLabel: done.record.timeLabel,
              id: done.record.id,
            })}
          </View>

          {/* `created:false`：服务端返回的是**此前那条**，本次填写的原因 / 说明没有落库。
              必须说清楚，否则用户会以为刚补充的证据已经被受理（PR #280 复查 P2-3） */}
          {done.created ? null : (
            <Text className="rpu__demonote">
              上面是这条举报原有的内容：同一个用户此前已经举报过，这次填写的原因和说明没有被新增进去。
            </Text>
          )}

          {done.simulated ? (
            <Text className="rpu__demonote">
              演示提交：这次提交走的是本地模拟，没有真的发到服务端，记录也不会保存。
            </Text>
          ) : null}

          <View className="rpu__acts">
            <View className="rpu__btn-primary" onClick={goMyReports}>
              <Text>查看「我的举报」</Text>
            </View>
            <View className="rpu__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回对方主页</Text>
            </View>
          </View>
        </View>
      ) : (
        /* ═══ 新建态（01）：入口 = 他人主页「举报用户」 ═══ */
        <View className="rpu__content">
          <View className="rpu__head">
            <View className="rpu__kicker">
              <Image className="rpu__kicker-ic" src={ICONS.shieldLine} mode="aspectFit" />
              <Text>Report · 举报用户</Text>
            </View>
            <Text className="rpu__title">举报这个用户</Text>
            <Text className="rpu__sub">
              平台会在核实后处理被举报用户，处理进度与结果可以在「我的举报」中查看。
            </Text>
          </View>

          <View className="rpu__card">
            <View className="rpu__card-hd">
              <Text className="rpu__card-h2">举报对象</Text>
              <Text className="rpu__opt">由入口带入</Text>
            </View>
            <Text className="rpu__card-sub">对象来自你点击「举报」的对方主页，不能修改。</Text>
            <View className="rpu__obj">
              {avatarOf(target.avatar, 'rpu__ava--obj')}
              <View className="rpu__obj-main">
                <Text className="rpu__obj-name">{target.nickname || '（未带出昵称）'}</Text>
                <Text className="rpu__obj-sub">由对方主页带入</Text>
              </View>
              <Text className="rpu__obj-tag">不可修改</Text>
            </View>
          </View>

          <View className={`rpu__card${typeErr ? ' is-err' : ''}`}>
            <View className="rpu__card-hd">
              <Text className="rpu__card-h2">举报类型</Text>
              <Text className="rpu__req">*</Text>
              <Text className="rpu__opt">必填</Text>
            </View>
            <Text className="rpu__card-sub">选择最接近的一项，平台会按类型核查。</Text>
            <View className="rpu__pills">
              {REASONS.map((reason) => (
                <View
                  key={reason.key}
                  className={`rpu__pill${chosen === reason.key ? ' is-on' : ''}`}
                  onClick={() => {
                    setChosen(reason.key)
                    setTypeErr(false)
                  }}
                >
                  <Text>{reason.label}</Text>
                </View>
              ))}
            </View>
            {typeErr ? (
              <View className="rpu__err">
                <Text>请先选择举报类型</Text>
              </View>
            ) : null}
          </View>

          <View className="rpu__card">
            <View className="rpu__card-hd">
              <Text className="rpu__card-h2">补充说明</Text>
              <Text className="rpu__opt">选填 · 最多 200 字</Text>
            </View>
            <Text className="rpu__card-sub">
              {chosenHint ?? '补充时间、对方言行等细节，能让核查更快。'}
            </Text>
            <View className={`rpu__field${fieldFocus ? ' is-focus' : ''}`}>
              <Textarea
                className="rpu__ta"
                value={desc}
                maxlength={REASON_MAX}
                placeholder={chosenHint ?? REPORT_DESC_DEFAULT_HINT}
                onInput={(e) => setDesc(e.detail.value)}
                onFocus={() => setFieldFocus(true)}
                onBlur={() => setFieldFocus(false)}
              />
              <View className="rpu__fieldfoot">
                <Text className="rpu__kb">最多 200 字</Text>
                <Text className="rpu__count num">{`${desc.length} / ${REASON_MAX}`}</Text>
              </View>
            </View>
          </View>

          <View className="rpu__note">
            <Image className="rpu__note-ic" src={ICONS.shieldLine} mode="aspectFit" />
            <Text className="rpu__note-tx">
              提交后平台会核查被举报内容；恶意举报可能影响你的账号信用。
            </Text>
          </View>

          <View
            className={`rpu__submit${chosen !== null && !busy ? '' : ' is-off'}`}
            onClick={submit}
          >
            <Text>{busy ? '提交中…' : '提交举报'}</Text>
          </View>
          <Text className="rpu__formfoot">重复举报不会加快处理 · 结果请在「我的举报」查看</Text>
        </View>
      )}
    </View>
  )
}
