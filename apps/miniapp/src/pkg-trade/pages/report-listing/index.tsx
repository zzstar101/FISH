import { ListingIdSchema } from '@fish/contracts/listings/schema'
import type { ListingReportReason, ReportCreateResponse } from '@fish/contracts/reports/schema'
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
  DEMO_SUBMITTED_LISTING_ID,
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
 * 举报商品（稿 `小程序1版举报商品.html`）。
 *
 * ## 两张独立页面，互不相通（Owner 2026-09-26 拍板）
 *
 * 举报商品（本页，入口：商品详情「举报商品」）与举报用户（`pages/report-user`）是两张
 * 独立页面：各自持有对象形态、原因胶囊与文案，互不跳转。两页只共用
 * `features/reports` 里的枚举 / 状态 / 文案常量（#252 冻结的那部分），页面结构互不复用。
 *
 * ## 同一页面的三种形态（入口 query 决定，页内不切换）
 *
 * - **新建**：商品详情带 `id / title / price / cover` 进入。对象卡固定不可改 ——
 *   防止拿别人的资源 id 拼举报；商品编号不在页内展示（#217 拍板「详情页不常驻展示编号」）。
 *   提交用的目标 ID 是 `params.id`（商品详情传的是契约 `lst_` 公开 ID），**裸 UUID 或错前缀
 *   在发请求前就被挡下**（`ListingIdSchema.safeParse` + 契约 `ReportCreateInputSchema`）。
 * - **只读**：「我的举报」点卡片带 `reportId` 进入 —— 按该条记录的状态渲染
 *   审核中 / 已处理 / 已驳回横幅 + 内容卡（编号可复制，给客服对账用）。
 * - **打不开**：带 `reportId` 但取不到记录。**不退回新建态** —— 那会让「打开一条记录」
 *   静默变成「凭空举报一个没有对象的商品」；由 `features/reports/view` 的
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
 * - `created: true` →「举报已提交」（本次新建）；
 * - `created: false` →「这条举报已受理」（同一未决目标的重复提交，服务端返回 200 而不是报错）。
 *
 * 演示构建（`TARO_APP_MOCK=1`）先试真实请求，只有请求**没到过后端**（网络层失败，或演示假会话
 * 必然拿到的 401）才回退到本地模拟并把记录追加进进程内存，让「提交 → 查看我的举报 →
 * 点进详情」动线能走通；重启即消失。服务端给了业务错误码时**不**回退 ——
 * 那会把「失败」说成「成功」（#193 / #260 复查 P2 同款要求）。
 *
 * ## 账号作用域（PR #280 复查 P2-1）
 *
 * 只读记录、提交结果与成功态都是**当前账号的私有数据**，而页面实例会跨过一次换号。所以：
 * 只读查询与提交各自持有一个「任务」（账号 + 代次），落地前先过
 * `isReportTaskCurrent`；换号在渲染期同步清场并让代次前进；身份未就绪不发私有读取；
 * 卸载也作废在途任务。判据是纯逻辑，单测在 `tests/reports.test.ts`。
 *
 * ## 成功卡的权威来源（PR #280 复查 P2-3）
 *
 * 卡里的原因 / 说明 / 时间 / 状态一律取服务端返回的 `res.report`（`doneOf`），**不取本次输入**。
 * `created:false` 时服务端返回的是此前那条，本次填的内容没有落库，卡片换成「已受理的举报」
 * 并明确说明「没有被新增进去」—— 不能用本地成功卡让用户以为新证据已被受理。
 *
 * ## 顶部栏（吸顶口径）
 *
 * 二级页拍板形态：`NavBar glass` —— `position: fixed` 的玻璃底 + 居中双色标题 +
 * 裸返回钮，**常驻吸顶**（表单滚动时标题栏不动，页头渐变随内容滚走）。
 * 内容顶部用 `readNavMetrics().totalHeight` 让出栏高（`pages/user` 同款做法）。
 *
 * ## 鉴权
 *
 * 挂 `useAuthGuard()`：确定未登录时自动 redirectTo 登录页（#252「未登录引导登录」），
 * `unknown`（冷启动恢复中）渲染占位、不发任何东西。
 */

const REASONS = reasonsOf('LISTING')
const REASON_MAX = 200
/** 演示构建口径：mock 回退与演示登录态**都要**开（只认 MOCK_FALLBACK 会顶掉 dev:weapp 的真实空态） */
const DEMO_MODE = MOCK_FALLBACK_ENABLED && DEMO_AUTH_ENABLED

/**
 * 成功态落定后的内容（`created` 决定文案：本次新建 / 此前已受理）。
 *
 * **记录本身以服务端返回的 `res.report` 为权威**（PR #280 复查 P2-3）。重复举报同一个未决
 * 目标时后端走 `ON CONFLICT ... DO NOTHING` 返回**原来那条**，本次填写的 `reason` /
 * `detailText` / `createdAt` 根本没落库。此前这里用本次输入现拼一张成功卡（还写「刚刚」），
 * 会让用户以为新补充的说明已被受理 —— 而点开只读记录又会看到另一份内容。
 * 要补充证据，得等服务端给出明确的写接口，不能在本地成功卡里模拟。
 */
type SubmitDone = {
  /** 服务端返回的那条记录；`created: false` 时是此前已存在的那条 */
  record: ReportRecord
  /** 本次是否真的新建了这条举报 */
  created: boolean
  /** 记录来自本地模拟，而不是服务端 */
  simulated: boolean
}

/** 把服务端响应收成成功态：展示内容一律取 `res.report`（`submittedRecord`），不取本次输入。 */
function doneOf(res: ReportCreateResponse, nowMs: number): SubmitDone {
  return { ...submittedRecord(res, nowMs), simulated: false }
}

/**
 * 这次提交失败能不能按演示口径模拟成功。
 *
 * 只有「请求根本没到过后端」才可以：网络层失败、契约解析失败，以及演示构建里假会话
 * 必然拿到的 `UNAUTHENTICATED`。服务端若给了业务错误码（目标不存在 / 不能举报自己 / 冲突…），
 * 说明请求真的到达了后端，改用模拟就是把失败说成成功。
 */
function canSimulateSubmit(error: unknown): boolean {
  if (!DEMO_REPORTS_ENABLED) return false
  return !isApiError(error) || error.code === 'UNAUTHENTICATED'
}

export default function ReportListing() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  /** 当前登录账号的公开 ID（`usr_…`）；身份未就绪时为 null */
  const userId = user?.id ?? null
  /** 路由参数读一次：两种入口都靠 query 定形态，页内不切换（跳转都是重新开页） */
  const { params } = useRouter()
  const reportId = params.reportId
  /** 入口带没带 `reportId`（判据与 `resolveReportView` 同一个，见 `features/reports/view`）。
        参数**原样传**、不在这里 `?? null`：`?reportId=` 这种空值入口也算「给了编号」。 */
  const wantsRecord = wantsReportRecord(reportId)

  /** 真实构建按编号查到的记录；演示构建不用它（记录同步可得） */
  const [record, setRecord] = useState<ReportRecord | null>(null)
  /** 真实构建的查询是否已落定；新建态与演示构建一开始就是 true */
  const [lookupDone, setLookupDone] = useState(!wantsRecord || DEMO_MODE)

  /** `null` = 记录还在查（只有真实构建的只读入口会经过） */
  const view = lookupDone
    ? resolveReportView({ reportId, target: 'LISTING', demoEnabled: DEMO_MODE, record })
    : null
  const mode = view === null ? null : view.mode
  const viewRecord = view === null ? null : view.record

  /** 新建态的举报对象（商品详情带入，页内不可改）。query 未解码，取值统一过 `routeParam` */
  const target = {
    title: routeParam(params.title),
    price: routeParam(params.price),
    cover: routeParam(params.cover),
  }
  /** 提交用的目标 ID：商品详情传的是契约 `lst_` 公开 ID（#269/#270 收口后不再传裸 uuid） */
  const targetId = params.id ?? ''

  const [chosen, setChosen] = useState<string | null>(null)
  const [desc, setDesc] = useState('')
  const [typeErr, setTypeErr] = useState(false)
  const [fieldFocus, setFieldFocus] = useState(false)
  /** 提交在飞：防重复提交（#252） */
  const [busy, setBusy] = useState(false)
  /** null = 还在表单；非 null = 成功态已落定（整页切换，不再回到表单） */
  const [done, setDone] = useState<SubmitDone | null>(null)

  /**
   * 账号作用域（PR #280 复查 P2-1）。
   *
   * 本页的只读记录、提交结果与成功态都是**当前账号的私有数据**，而页面实例会跨过一次换号
   * （`authed(A) → authed(B)`，或退出到匿名）。给只读查询与提交各发一个「任务」，落地前必须
   * 仍然属于当前账号、且没被换号或卸载作废（判据在 `features/reports/view`）。
   *
   * 只比对 `ownerId` 不够：`A → B → A` 时当前账号又变回 A，A 的旧响应会被写进 A 的**新**会话，
   * 所以还要叠一个只在换号 / 卸载时前进的代次。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  const epochRef = useRef(0)
  const ownerRef = useRef<string | null>(userId)
  ownerRef.current = userId

  /**
   * 换号时**在渲染期**同步清场：effect 要等这一帧提交之后才跑，中间那一帧 B 的界面会带着
   * A 的只读记录、A 的成功态与 A 填了一半的原因 / 说明。代次 +1 让 A 的在途读取与提交作废。
   */
  if (reportOwnerChanged(prevUserId, userId)) {
    setPrevUserId(userId)
    epochRef.current += 1
    setRecord(null)
    setLookupDone(!wantsRecord || DEMO_MODE)
    setChosen(null)
    setDesc('')
    setTypeErr(false)
    setBusy(false)
    setDone(null)
  }

  /**
   * 只读记录查询。
   *
   * 身份没就绪就**不发**私有读取（冷启动 `unknown` 时用未知身份去查，失败了也不知道该不该
   * 重试）；等 `authed` 且拿到 `userId` 之后再查，换号会让这个 effect 重新跑一次。
   */
  useEffect(() => {
    if (!wantsRecord || DEMO_MODE) return
    if (authStatus !== 'authed' || userId === null) return
    const task = beginReportTask(epochRef.current, userId)
    void loadReportRecord(reportId as string).then((hit) => {
      // 换号 / 卸载后迟到的结果一律不落地（`alive` 只能防卸载，防不了 A→B 仍为已登录）
      if (!isReportTaskCurrent(task, epochRef.current, ownerRef.current)) return
      setRecord(hit)
      setLookupDone(true)
    })
  }, [wantsRecord, reportId, authStatus, userId])

  /** 卸载：作废在途任务，免得迟到的结果在离页后 setState */
  useEffect(() => {
    return () => {
      epochRef.current += 1
    }
  }, [])

  const navTotalHeight = readNavMetrics().totalHeight

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  const chosenHint = reasonHint('LISTING', chosen)

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
    const parsedId = ListingIdSchema.safeParse(targetId)
    if (!parsedId.success) {
      toast('举报对象编号无效，请从商品详情重新进入')
      return
    }
    // 胶囊来自 `reasonsOf('LISTING')`，取值必属商品类枚举；契约提交前还会再校验一次（superRefine）
    const reason = chosen as ListingReportReason
    const detail = desc.trim()
    const task = beginReportTask(epochRef.current, userId)
    setBusy(true)
    void (async () => {
      try {
        const res = await submitReport({
          targetType: 'LISTING',
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
            id: DEMO_SUBMITTED_LISTING_ID,
            target: 'LISTING',
            objTitle: target.title || '（未带出商品标题）',
            objPrice: target.price || null,
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

  /** 成功态主按钮：用 redirectTo 把表单页换成列表页（返回键回到商品详情，栈不加深） */
  const goMyReports = () => {
    void Taro.redirectTo({ url: '/pkg-trade/pages/my-reports/index' })
  }

  const navTitle = (
    <Text>
      举报
      <Text className="rpl__navem">{mode === 'fill' ? '商品' : '详情'}</Text>
    </Text>
  )

  /* ── 键值行：成功态「提交内容」与只读态「举报内容」共用同一套结构 ── */
  const rowsOf = (data: {
    objTitle: string
    objPrice: string | null
    /** 被举报对象的公开 ID；真实记录有（契约 `targetId`），成功态刚提交时也有 */
    objId?: string
    cover: string
    reason: string
    desc: string
    timeLabel: string
    id: string
  }) => (
    <>
      <View className="rpl__kvobj">
        {data.cover ? (
          <Image className="rpl__obj-img rpl__obj-img--sm" src={data.cover} mode="aspectFill" />
        ) : (
          <View className="rpl__obj-ph rpl__obj-ph--sm">
            <Image className="rpl__obj-ph-ic" src={ICONS.imageMuted} mode="aspectFit" />
          </View>
        )}
        <View className="rpl__obj-main">
          <Text className="rpl__obj-name">{data.objTitle}</Text>
          {data.objPrice ? (
            <Text className="rpl__obj-sub">
              <Text className="rpl__obj-price">{`¥${data.objPrice}`}</Text>
            </Text>
          ) : null}
          {/* 用户端 DTO 不返回被举报对象的标题（`ReportSchema` 只有 targetId），
              所以真实记录靠这行公开 ID 让用户指认自己举报的是哪一件 */}
          {data.objId ? <Text className="rpl__obj-sub num">{data.objId}</Text> : null}
        </View>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">举报类型</Text>
        <View className="rpl__kv-v">
          <Text className="rpl__rtag">{reasonLabel('LISTING', data.reason)}</Text>
        </View>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">补充说明</Text>
        <Text className={`rpl__kv-v${data.desc ? '' : ' is-dim'}`}>{data.desc || '未填写'}</Text>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">提交时间</Text>
        <Text className="rpl__kv-v num">{data.timeLabel}</Text>
      </View>
      <View className="rpl__kv">
        <Text className="rpl__kv-k">举报编号</Text>
        <View className="rpl__kvid">
          <Text className="rpl__kv-v num">{data.id}</Text>
          <View className="rpl__copy" onClick={() => copyId(data.id)}>
            <Text>复制</Text>
          </View>
        </View>
      </View>
    </>
  )

  return (
    <View className="rpl">
      <NavBar glass titleAlign="center" title={navTitle} />
      {/* 玻璃栏是 fixed：内容让出栏高（状态栏 + 导航行，设备 px，见 nav-metrics.ts） */}
      <View style={{ height: `${navTotalHeight}px` }} />

      {authStatus !== 'authed' ? (
        <View className="rpl__auth">
          <AuthRequired restoring={authStatus === 'unknown'} />
        </View>
      ) : mode === null ? (
        /* ═══ 只读入口的取数占位（真实构建按编号查 `/reports/mine`，列表进详情通常只闪一下） ═══ */
        <View className="rpl__content">
          <Text className="rpl__loading">加载中…</Text>
        </View>
      ) : mode === 'view' && viewRecord !== null ? (
        /* ═══ 只读态：审核中 / 已处理 / 已驳回（入口：「我的举报」点卡片） ═══ */
        <View className="rpl__content">
          <View className={`rpl__banner is-${REPORT_STATUS_META[viewRecord.status].tone}`}>
            <Image
              className="rpl__banner-ic"
              src={
                viewRecord.status === 'HANDLED'
                  ? ICONS.checkAccent
                  : viewRecord.status === 'REJECTED'
                    ? ICONS.warnInk
                    : ICONS.clockInk
              }
              mode="aspectFit"
            />
            <View className="rpl__banner-main">
              <Text className="rpl__banner-t">{bannerCopy(viewRecord.status).title}</Text>
              <Text className="rpl__banner-s">{bannerCopy(viewRecord.status).text}</Text>
            </View>
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">举报内容</Text>
            </View>
            {rowsOf({
              objTitle: viewRecord.objTitle,
              objPrice: viewRecord.objPrice,
              objId: viewRecord.objId,
              cover: '',
              reason: viewRecord.reason,
              desc: viewRecord.desc,
              timeLabel: viewRecord.timeLabel,
              id: viewRecord.id,
            })}
          </View>

          {DEMO_MODE ? (
            <Text className="rpl__demonote">演示记录：来自演示构建的样例数据。</Text>
          ) : null}

          <View className="rpl__acts">
            <View className="rpl__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回「我的举报」</Text>
            </View>
          </View>
        </View>
      ) : mode === 'unavailable' ? (
        /* ═══ 打不开：带 reportId 却取不到记录（见文件头「三种形态」） ═══ */
        <View className="rpl__content">
          <View className="rpl__emptypad">
            <EmptyState
              title={unavailableCopy(DEMO_MODE).title}
              text={unavailableCopy(DEMO_MODE).text}
              icon={ICONS.shieldLine}
            />
          </View>
          <View className="rpl__acts">
            <View className="rpl__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回「我的举报」</Text>
            </View>
          </View>
        </View>
      ) : done !== null ? (
        /* ═══ 成功态（02）：不 toast 了事，整页落成功并给「我的举报」动线 ═══
              `created:false` 表示这个未决目标此前已受理过，文案不能再说一次「已提交」 */
        <View className="rpl__content">
          <View className="rpl__hero">
            <View className="rpl__hero-ic">
              <Image className="rpl__hero-ic-img" src={ICONS.checkAccent} mode="aspectFit" />
            </View>
            <Text className="rpl__hero-t">{done.created ? '举报已提交' : '这条举报已受理'}</Text>
            <Text className="rpl__hero-s">
              {done.created
                ? '平台会在核实后处理，处理结果可在「我的举报」中查看。'
                : '同一个商品此前已经举报过，平台正在核实，无需重复提交。'}
            </Text>
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              {/* `created:false` 时卡里是**原有那条**的内容，标题不能再说「提交内容」 */}
              <Text className="rpl__card-h2">{done.created ? '提交内容' : '已受理的举报'}</Text>
            </View>
            {rowsOf({
              objTitle: target.title || '（未带出商品标题）',
              objPrice: target.price || null,
              objId: done.record.objId,
              cover: target.cover,
              reason: done.record.reason,
              desc: done.record.desc,
              timeLabel: done.record.timeLabel,
              id: done.record.id,
            })}
          </View>

          {/* `created:false`：服务端返回的是**此前那条**，本次填写的原因 / 说明没有落库。
              必须说清楚，否则用户会以为刚补充的证据已经被受理（PR #280 复查 P2-3） */}
          {done.created ? null : (
            <Text className="rpl__demonote">
              上面是这条举报原有的内容：同一个商品此前已经举报过，这次填写的原因和说明没有被新增进去。
            </Text>
          )}

          {done.simulated ? (
            <Text className="rpl__demonote">
              演示提交：这次提交走的是本地模拟，没有真的发到服务端，记录也不会保存。
            </Text>
          ) : null}

          <View className="rpl__acts">
            <View className="rpl__btn-primary" onClick={goMyReports}>
              <Text>查看「我的举报」</Text>
            </View>
            <View className="rpl__btn-ghost" onClick={() => void Taro.navigateBack()}>
              <Text>返回商品详情</Text>
            </View>
          </View>
        </View>
      ) : (
        /* ═══ 新建态（01）：入口 = 商品详情「举报商品」 ═══ */
        <View className="rpl__content">
          <View className="rpl__head">
            <View className="rpl__kicker">
              <Image className="rpl__kicker-ic" src={ICONS.shieldLine} mode="aspectFit" />
              <Text>Report · 举报商品</Text>
            </View>
            <Text className="rpl__title">举报这个商品</Text>
            <Text className="rpl__sub">
              平台会在核实后处理被举报商品，处理进度与结果可以在「我的举报」中查看。
            </Text>
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">举报对象</Text>
              <Text className="rpl__opt">由入口带入</Text>
            </View>
            <Text className="rpl__card-sub">对象来自你点击「举报」的商品详情页，不能修改。</Text>
            <View className="rpl__obj">
              {target.cover ? (
                <Image className="rpl__obj-img" src={target.cover} mode="aspectFill" />
              ) : (
                <View className="rpl__obj-ph">
                  <Image className="rpl__obj-ph-ic" src={ICONS.imageMuted} mode="aspectFit" />
                </View>
              )}
              <View className="rpl__obj-main">
                <Text className="rpl__obj-name">{target.title || '（未带出商品标题）'}</Text>
                <Text className="rpl__obj-sub">
                  {target.price ? (
                    <Text className="rpl__obj-price">{`¥${target.price}`}</Text>
                  ) : null}
                  {' · 由商品详情带入'}
                </Text>
              </View>
              <Text className="rpl__obj-tag">不可修改</Text>
            </View>
          </View>

          <View className={`rpl__card${typeErr ? ' is-err' : ''}`}>
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">举报类型</Text>
              <Text className="rpl__req">*</Text>
              <Text className="rpl__opt">必填</Text>
            </View>
            <Text className="rpl__card-sub">选择最接近的一项，平台会按类型核查。</Text>
            <View className="rpl__pills">
              {REASONS.map((reason) => (
                <View
                  key={reason.key}
                  className={`rpl__pill${chosen === reason.key ? ' is-on' : ''}`}
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
              <View className="rpl__err">
                <Text>请先选择举报类型</Text>
              </View>
            ) : null}
          </View>

          <View className="rpl__card">
            <View className="rpl__card-hd">
              <Text className="rpl__card-h2">补充说明</Text>
              <Text className="rpl__opt">选填 · 最多 200 字</Text>
            </View>
            <Text className="rpl__card-sub">
              {chosenHint ?? '补充时间、对方言行等细节，能让核查更快。'}
            </Text>
            <View className={`rpl__field${fieldFocus ? ' is-focus' : ''}`}>
              <Textarea
                className="rpl__ta"
                value={desc}
                maxlength={REASON_MAX}
                placeholder={chosenHint ?? REPORT_DESC_DEFAULT_HINT}
                onInput={(e) => setDesc(e.detail.value)}
                onFocus={() => setFieldFocus(true)}
                onBlur={() => setFieldFocus(false)}
              />
              <View className="rpl__fieldfoot">
                <Text className="rpl__kb">最多 200 字</Text>
                <Text className="rpl__count num">{`${desc.length} / ${REASON_MAX}`}</Text>
              </View>
            </View>
          </View>

          <View className="rpl__note">
            <Image className="rpl__note-ic" src={ICONS.shieldLine} mode="aspectFit" />
            <Text className="rpl__note-tx">
              提交后平台会核查被举报内容；恶意举报可能影响你的账号信用。
            </Text>
          </View>

          <View
            className={`rpl__submit${chosen !== null && !busy ? '' : ' is-off'}`}
            onClick={submit}
          >
            <Text>{busy ? '提交中…' : '提交举报'}</Text>
          </View>
          <Text className="rpl__formfoot">重复举报不会加快处理 · 结果请在「我的举报」查看</Text>
        </View>
      )}
    </View>
  )
}
