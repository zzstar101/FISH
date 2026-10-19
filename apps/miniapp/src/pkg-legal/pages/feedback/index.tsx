import {
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_CONTENT_MAX,
  FEEDBACK_CONTENT_MIN,
  type FeedbackType,
  FeedbackTypeSchema,
} from '@fish/contracts/feedback/schema'
import { Image, Input, Text, Textarea, View } from '@tarojs/components'
import Taro, { usePageScroll } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS, type IconName } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { submitFeedback } from '@/features/feedback/api'
import {
  DEMO_SUBMITTED_FEEDBACK_ID,
  type FeedbackRecord,
  rememberDemoFeedback,
} from '@/features/feedback/demo'
import { DEMO_FEEDBACK_ENABLED } from '@/features/feedback/load'
import { feedbackToRecord, shortFeedbackId } from '@/features/feedback/map'
import {
  FEEDBACK_TYPE_COPY,
  type FeedbackSubmitOutcome,
  submitFailureText,
  submitOutcome,
  submitResultCopy,
} from '@/features/feedback/meta'
import { readNavMetrics } from '@/lib/nav-metrics'
import { isApiError } from '@/lib/request'
import { randomUuidV4 } from '@/lib/uuid'
import { FEEDBACK_DRAFT_KEY, type FeedbackDraft, parseFeedbackDraft } from './draft'
import './index.scss'

/**
 * 意见反馈（稿 `小程序1版意见反馈.html`；入口：我的 → 帮助与设置「意见反馈」、设置 → 关于）。
 *
 * ## 提交是真的（#463）
 *
 * 页面把填好的内容 `POST /feedback` 交给后端（契约 `@fish/contracts/feedback/*`）：
 * - 成功 / 同一 `clientRequestId` 的重放 → 结果弹层说「已提交」，并给「查看我的反馈」；
 * - 失败 → **表单原样保留**（草稿也在本机），只给一行错误文案，重试沿用同一个
 *   `clientRequestId` —— 网络抖动时不会在服务端落两条（后端按它做幂等）。
 *
 * 这里不再有「客服邮箱 / 待接入」兜底弹层：那是后端不存在时的权宜方案，`SUPPORT_MAIL`
 * 与 `sheet.ts` 一并删除（`POST /feedback` 早已上线，PR #488）。
 *
 * ## 反馈类型来自契约，不是稿里的占位
 *
 * 6 个类型的枚举值、label、hint 分别来自契约 `FeedbackTypeSchema` 与 `features/feedback/meta.ts`：
 * 契约是唯一真源（后端与 PC 端都按它落地）。本页只负责把枚举映射成稿里的 6 枚胶囊与图标。
 *
 * ## 草稿按账号隔离
 *
 * 草稿 key 仍是 `fish:feedback:draft`（隐私政策的数据清单照旧），但记录里带 `ownerId`：
 * 同一台手机上换账号后，上一个账号未提交的内容不会被下一个账号看到（`./draft` 的解析
 * 判据见 `readStoredDraft`）。提交成功后立即删除草稿。
 *
 * ## 演示构建
 *
 * `TARO_APP_MOCK=1` 的演示构建里没有真会话（`features/auth/demo.ts`），真实提交必然 401；
 * 这时按「请求没到过后端」的同一判据模拟成功并把记录放进进程内存（`features/feedback/demo.ts`），
 * 让演示动线「提交 → 我的反馈」走得通。真实构建永远不模拟 —— 失败就是失败。
 *
 * ## 与稿的差异（稿是「模拟微信原生栏」的演示壳，不照搬）
 *
 * - 稿的 `.mp-nav` + 假胶囊 `.mp-capsule` 是**模拟原生导航栏**，本项目全端
 *   `navigationStyle: custom`、没有原生栏，改用 `components/nav-bar` 的 `glass` 变体
 *   （`position: fixed` 吸顶玻璃栏 + 居中标题，同 `pages/report-listing`），
 *   内容自己用 `readNavMetrics().totalHeight` 让出栏高；**不自己画胶囊**。
 * - 稿的 `.toast` 元素是稿子在模拟 `wx.showToast`，这里直接用 `Taro.showToast`。
 * - 稿的机身外壳（状态栏 / 灵动岛 / 侧键 / home indicator / 演示控制条 / `--rpx`+`cqw`
 *   自适应 / 固定 390×844 舞台）是演示稿的外壳，不是页面内容，一律不移植。
 *
 * ## 图标映射（稿的内联 SVG 描边图标 → `ICONS`；库里没有一一对应的，按语义就近取）
 *
 * `ic-alert`→`warnInk`（行内错误）、`ic-edit`→`editAccent`（页头 kicker）、
 * `ic-chat`→`chatInk`（交易纠纷）、`ic-shield`→`safeAccent`（违规举报 / 隐私提示）、
 * `ic-phone`→`serviceMuted`（账号与认证 / 联系方式输入框）、`ic-mail`→`mail`（其他）。
 * `ic-check`→`checkAccent`（提交成功 / 「知道了」）。
 *
 * ⚠️ **已知色偏（记录，不修）**：稿的图标是内联 SVG 描边、走 `currentColor`，所以
 * `.err .ic-line` 能被染成稿要求的 `--danger` 红；仓内 `ICONS` 是固定色 PNG、不可染色，
 * `warnInk` 实测是 **#17233D（墨色）**。所以行内错误图标比稿「暗一档」。
 * 要严格对齐得往图标生成器里加一个 danger 红变体，不是在本页调色。
 *
 * ## 行为口径（照稿）
 *
 * - 6 个类型胶囊：选中后**描述框 placeholder 与副标题文案跟着变**
 *   （交易纠纷 / 违规举报换成「需要能核对的信息」那一段）—— 稿注释 ②。
 * - 描述框 `maxlength=600`（多留 100 让用户写完再看到超限），**上限判 500 字**、
 *   计数 `n / 500`、少于 5 字算不合格；超限时计数变警示色并拦住提交（稿注释 ⑦）。
 * - 提交按钮**在表单末尾、不吸底**：textarea 聚焦后键盘会顶起页面（稿注释 ③）。
 * - 内容本机暂存 `fish:feedback:draft`，恢复时顶部给一行「已恢复上次未提交的内容 · 清空」；
 *   存储失败静默、不崩页面（稿注释 ⑥）。
 * - 校验不过**不弹层**：标红对应卡片 + 滚动到第一个出错处 + `Taro.showToast` 提示。
 * - 页面级滚动（`usePageScroll`）：根节点**不写 `overflow`**，否则页面自身成了滚动容器，
 *   `Taro.pageScrollTo` 会失真（见 `pages/favorites/index.scss` 的同类说明）。
 */

/** 反馈类型 → 稿内联图标的语义映射（图标只从 `ICONS` 取） */
const TYPE_ICON: Record<FeedbackType, IconName> = {
  BUG: 'warnInk',
  UX: 'editAccent',
  DISPUTE: 'chatInk',
  REPORT: 'safeAccent',
  ACCOUNT: 'serviceMuted',
  OTHER: 'mail',
}

const DEFAULT_HINT = FEEDBACK_TYPE_COPY.OTHER.hint
const DESC_SUB_DEFAULT = '请尽量写清出现的位置与操作步骤，越具体越容易定位。'
/** 交易纠纷 / 违规举报：这两类没有可核对的信息就无法处理（稿 `syncDescHint`） */
const DESC_SUB_CHECKABLE = '这一类需要能核对的信息：请写清商品名称、对方昵称与大致时间。'
const ERR_TYPE = '请先选择反馈类型'
const DESC_ERR_SHORT = '请至少填写 5 个字，便于我们定位问题'
const DESC_ERR_LONG = `描述不能超过 ${FEEDBACK_CONTENT_MAX} 字，请精简后再提交`

/** 上限判 500（计数与拦截都用它）；输入框多留 100，让用户写完再看到超限（稿注释 ⑦） */
const DESC_MAX = FEEDBACK_CONTENT_MAX
const DESC_MIN = FEEDBACK_CONTENT_MIN
const DESC_MAXLENGTH = FEEDBACK_CONTENT_MAX + 100
/**
 * 联系方式输入框的 UI 上限 40 字。契约 `FEEDBACK_CONTACT_MAX` 是 100，
 * 这里按稿收紧（微信号 / 手机号 / 邮箱都远小于 40），超长内容没有实际用途。
 */
const CONTACT_MAXLENGTH = Math.min(40, FEEDBACK_CONTACT_MAX)

function hintOf(type: FeedbackType | ''): string {
  return type === '' ? DEFAULT_HINT : FEEDBACK_TYPE_COPY[type].hint
}

/**
 * 读本机暂存。**存储不可用 / 内容为空 / 不属于当前账号都当作「没有草稿」**。
 *
 * 草稿记录里带 `ownerId`（换账号后不能看到上一个账号未提交的内容）；
 * 解析本身（两种存储形态、字段级容错、空草稿判据）在 `./draft`，是纯函数、有单测。
 */
function readStoredDraft(ownerId: string): FeedbackDraft | null {
  let parsed: FeedbackDraft | null
  try {
    parsed = parseFeedbackDraft(Taro.getStorageSync(FEEDBACK_DRAFT_KEY))
  } catch {
    return null
  }
  if (parsed === null) return null
  if (parsed.ownerId !== null && parsed.ownerId !== ownerId) {
    // 上一个账号留下的草稿：内容对当前账号是别人的隐私，顺手清掉
    try {
      Taro.removeStorageSync(FEEDBACK_DRAFT_KEY)
    } catch {
      // 清不掉也不展示；下次进来还会走到这里
    }
    return null
  }
  return parsed
}

/** 这次提交失败能不能按演示口径模拟成功（判据与 `pages/report-listing` 相同） */
function canSimulateSubmit(error: unknown): boolean {
  if (!DEMO_FEEDBACK_ENABLED) return false
  // 只有「请求根本没到过后端」才可以：网络层失败、契约解析失败，以及演示构建里
  // 假会话必然拿到的 UNAUTHENTICATED。服务端给了业务错误码就说明请求真的到达了后端。
  return !isApiError(error) || error.code === 'UNAUTHENTICATED'
}

/** 提交结果弹层的数据 */
type SubmitResult = {
  outcome: FeedbackSubmitOutcome
  /** 服务端返回的那条（重放时是此前已存在的那条；演示构建是本地模拟的那条） */
  record: FeedbackRecord
  /** 记录来自本地模拟，而不是服务端 */
  simulated: boolean
}

export default function Feedback() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const nav = useMemo(() => readNavMetrics(), [])

  // 未登录 / 登录态未就绪：先不渲染表单（守卫的跳转是异步的，渲染一帧别人的草稿不合适）
  if (authStatus !== 'authed' || user === null) {
    return (
      <View className="fb">
        <NavBar glass title="意见反馈" titleAlign="center" />
        <View style={{ height: `${nav.totalHeight}px` }} />
        <AuthRequired restoring={authStatus === 'unknown'} />
      </View>
    )
  }

  // key=账号：换账号时整页重挂，草稿 / 在飞请求 / 成功态都不跨账号
  return <FeedbackForm key={user.id} userId={user.id} />
}

function FeedbackForm({ userId }: { userId: string }) {
  /** 冷启动读一次本机暂存（只认属于当前账号的）；`null` = 没有可恢复的内容 */
  const [draft] = useState(() => readStoredDraft(userId))
  const [type, setType] = useState<FeedbackType | ''>(draft?.type ?? '')
  const [desc, setDesc] = useState(draft?.desc ?? '')
  const [contact, setContact] = useState(draft?.contact ?? '')
  /** 顶部「已恢复上次未提交的内容」提示条（稿注释 ⑥） */
  const [restored, setRestored] = useState(draft !== null)

  const [typeErr, setTypeErr] = useState(false)
  /** 描述的行内错误文案；`null` = 没有错误（文案随「太短 / 超 500」两态变） */
  const [descErr, setDescErr] = useState<string | null>(null)
  const [descFocus, setDescFocus] = useState(false)
  const [contactFocus, setContactFocus] = useState(false)
  /** 提交在飞：防重复提交，按钮显示「提交中…」 */
  const [busy, setBusy] = useState(false)
  /** 失败文案（服务端错误码映射，或网络层失败）；`null` = 没有错误 */
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** 提交结果弹层；`null` = 关闭 */
  const [result, setResult] = useState<SubmitResult | null>(null)
  /**
   * 幂等键：失败重试沿用同一个；每次拿到响应（成功 / 重放）后换新。
   * 换新必须发生在新一轮提交之前，否则下一次提交会被服务端当成同一请求的重放。
   */
  const [clientRequestId, setClientRequestId] = useState(() => randomUuidV4())

  const nav = useMemo(() => readNavMetrics(), [])
  const scrollTopRef = useRef(0)
  /** 提交在飞的**同步**闸门（`busy` 只负责 UI，同 `pages/login` 的 `wechatBusyRef`） */
  const submitBusyRef = useRef(false)
  /** 页面是否还活着：提交响应落地时页面可能已被卸载（换号 / 返回） */
  const aliveRef = useRef(true)
  useEffect(
    () => () => {
      aliveRef.current = false
    },
    [],
  )

  usePageScroll(({ scrollTop }) => {
    scrollTopRef.current = scrollTop
  })

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  /**
   * 写本机暂存。**失败不抛**（存储失败不致命），也**不再把成败回报给调用方** ——
   * 新的结果弹层只说服务端真的发生了什么，不再承诺「内容已暂存在本机」。
   *
   * **必须显式传整份草稿**，不能在回调里读 state：`setState` 要下一轮渲染才生效，
   * 事件回调里读到的是**改动前**的值，那样刚输入的字不会进暂存。
   */
  const persistDraft = (next: { type: FeedbackType | ''; desc: string; contact: string }) => {
    try {
      Taro.setStorageSync(FEEDBACK_DRAFT_KEY, { ownerId: userId, ...next })
    } catch {
      // 存储失败不影响页面交互
    }
  }

  const removeStoredDraft = () => {
    try {
      Taro.removeStorageSync(FEEDBACK_DRAFT_KEY)
    } catch {
      // 忽略：清不掉也只是留着一份草稿，不该让页面崩
    }
  }

  /** 清空草稿并复位表单（提示条的「清空」与提交成功后共用） */
  const clearDraftAndForm = () => {
    removeStoredDraft()
    setType('')
    setDesc('')
    setContact('')
    setTypeErr(false)
    setDescErr(null)
    setRestored(false)
    setSubmitError(null)
  }

  const selectType = (next: FeedbackType) => {
    setType(next)
    setTypeErr(false)
    setSubmitError(null)
    persistDraft({ type: next, desc, contact })
  }

  const onDescInput = (value: string) => {
    setDesc(value)
    // 够 5 个字就撤掉行内错误（同稿 desc 的 input 处理）
    if (value.trim().length >= DESC_MIN) setDescErr(null)
    setSubmitError(null)
    persistDraft({ type, desc: value, contact })
  }

  const onContactInput = (value: string) => {
    setContact(value)
    setSubmitError(null)
    persistDraft({ type, desc, contact: value })
  }

  /**
   * 滚到第一个出错的卡片。
   *
   * 页面级滚动（`Taro.pageScrollTo`），`boundingClientRect` 给的是视口坐标，
   * 加上当前滚动量才是它在页面里的位置；顶栏是 `position: fixed` 的玻璃栏，
   * 再让出 `nav.totalHeight`，否则卡片会被压在栏底下（同稿 `offsetTop - 12` 的意图）。
   */
  const scrollToCard = (selector: string) => {
    Taro.createSelectorQuery()
      .select(selector)
      .boundingClientRect()
      .exec((res) => {
        const rect = res?.[0] as { top?: number } | undefined
        if (typeof rect?.top !== 'number') return
        const top = Math.max(0, rect.top + scrollTopRef.current - nav.totalHeight - 12)
        void Taro.pageScrollTo({ scrollTop: top, duration: 300 })
      })
  }

  /**
   * 提交：校验 → `POST /feedback` → 结果弹层。
   *
   * 校验不过时不弹层：标红对应卡片 + 滚到第一个出错处 + toast。
   */
  const submit = () => {
    // 判 ref 而不是 state：`setState` 要下一轮渲染才可见，同一帧里的第二次点击读到的仍是
    // 旧值，会起两个请求
    if (submitBusyRef.current) return
    const missingType = type === ''
    const descTooLong = desc.length > DESC_MAX
    const descTooShort = desc.trim().length < DESC_MIN
    if (missingType || descTooShort || descTooLong) {
      if (missingType) setTypeErr(true)
      const message = descTooLong ? DESC_ERR_LONG : DESC_ERR_SHORT
      if (descTooShort || descTooLong) setDescErr(message)
      scrollToCard(missingType ? '#fb-type' : '#fb-desc')
      toast('还有必填项没有填完')
      return
    }
    submitBusyRef.current = true
    setBusy(true)
    setSubmitError(null)
    // 发出去的内容取当前表单的裁剪值；成功后展示服务端返回的那条，不拿本次输入拼
    const content = desc.trim()
    const sent = { type, content }
    const contactText = contact.trim()
    void (async () => {
      try {
        const res = await submitFeedback({
          clientRequestId,
          type,
          content,
          contact: contactText === '' ? undefined : contactText,
        })
        if (!aliveRef.current) return
        const outcome = submitOutcome(sent, res)
        const record = feedbackToRecord(res.feedback, Date.now())
        // 拿到响应就换新键：万一这次是重放，下一次提交不能被继续当成同一条
        setClientRequestId(randomUuidV4())
        // 只有「本次真的送达」才清空草稿；重放时用户后来的修改没有提交，草稿要留着
        if (outcome === 'submitted') clearDraftAndForm()
        setResult({ outcome, record, simulated: false })
      } catch (error) {
        if (!aliveRef.current) return
        if (canSimulateSubmit(error)) {
          // 演示「落库」：放进进程内存，让「我的反馈」列表能看到它（见 features/feedback/demo.ts）
          const demoRecord: FeedbackRecord = {
            id: DEMO_SUBMITTED_FEEDBACK_ID,
            type,
            content,
            reply: null,
            status: 'PENDING',
            timeLabel: '刚刚',
          }
          rememberDemoFeedback(demoRecord)
          clearDraftAndForm()
          setClientRequestId(randomUuidV4())
          setResult({ outcome: 'submitted', record: demoRecord, simulated: true })
        } else {
          // 失败时表单与草稿都保留，重试沿用同一个 clientRequestId（服务端据此幂等）
          setSubmitError(submitFailureText(isApiError(error) ? error.code : null))
        }
      } finally {
        if (aliveRef.current) {
          submitBusyRef.current = false
          setBusy(false)
        }
      }
    })()
  }

  const goPrivacy = () => {
    void Taro.navigateTo({ url: '/pkg-legal/pages/privacy/index' })
  }

  const goMyFeedback = () => {
    // redirectTo：把表单页换成列表页，返回键回到入口页，栈不加深
    void Taro.redirectTo({ url: '/pkg-legal/pages/my-feedback/index' })
  }

  const tooLong = desc.length > DESC_MAX
  const canSubmit = type !== '' && desc.trim().length >= DESC_MIN && !tooLong
  const descSub = type === 'DISPUTE' || type === 'REPORT' ? DESC_SUB_CHECKABLE : DESC_SUB_DEFAULT
  const resultCopy = result === null ? null : submitResultCopy(result.outcome)

  return (
    <View className="fb">
      <NavBar glass title="意见反馈" titleAlign="center" />
      {/* 玻璃栏是 fixed：内容让出栏高（状态栏 + 导航行，设备 px，见 nav-metrics.ts） */}
      <View style={{ height: `${nav.totalHeight}px` }} />

      {/* ── 渐变页头（稿 .headblock；随内容滚走，玻璃栏不动） ── */}
      <View className="fb__head">
        <View className="fb__kicker">
          <Image className="fb__kicker-ic" src={ICONS.editAccent} mode="aspectFit" />
          <Text>Feedback · 意见反馈</Text>
        </View>
        <Text className="fb__title">告诉我们哪里不对</Text>
        <Text className="fb__sub">
          反馈会提交给平台管理员，
          <Text className="fb__strong fb__strong--fg">只有你与管理员</Text>
          能看到内容与联系方式；处理结果和回复会显示在「我的反馈」里。
        </Text>
      </View>

      {/* ── 本机暂存恢复提示（有内容才出现，空草稿不打扰用户） ── */}
      {restored ? (
        <View className="fb__draft">
          <Image className="fb__draft-ic" src={ICONS.clockMuted} mode="aspectFit" />
          <Text className="fb__draft-tx">已恢复上次未提交的内容。提交成功后它会从本机删除。</Text>
          <View
            className="fb__draft-clear"
            onClick={() => {
              clearDraftAndForm()
              toast('已清空')
            }}
          >
            <Text>清空</Text>
          </View>
        </View>
      ) : null}

      <View className="fb__form">
        {/* ══ 「我的反馈」入口：提交过的记录与回复都在列表页 ══ */}
        <View className="fb__mine" onClick={goMyFeedback}>
          <Image className="fb__mine-ic" src={ICONS.docMuted} mode="aspectFit" />
          <View className="fb__mine-txt">
            <Text className="fb__mine-t">我的反馈</Text>
            <Text className="fb__mine-s">查看处理进度与管理员回复</Text>
          </View>
          <Image className="fb__mine-arrow" src={ICONS.chevronRightMuted} mode="aspectFit" />
        </View>

        {/* ══ 反馈类型（必填） ══ */}
        <View className={`fb__card${typeErr ? ' is-err' : ''}`} id="fb-type">
          <View className="fb__card-hd">
            <Text className="fb__card-h2">反馈类型</Text>
            <Text className="fb__req">*</Text>
            <Text className="fb__opt">必填</Text>
          </View>
          <Text className="fb__card-sub">选择最接近的一项，我们会转给对应的同学处理。</Text>
          <View className="fb__pills">
            {FeedbackTypeSchema.options.map((item) => (
              <View
                key={item}
                className={`fb__pill${type === item ? ' is-on' : ''}`}
                onClick={() => selectType(item)}
              >
                <Image className="fb__pill-ic" src={ICONS[TYPE_ICON[item]]} mode="aspectFit" />
                <Text>{FEEDBACK_TYPE_COPY[item].label}</Text>
              </View>
            ))}
          </View>
          {typeErr ? (
            <View className="fb__err">
              <Image className="fb__err-ic" src={ICONS.warnInk} mode="aspectFit" />
              <Text>{ERR_TYPE}</Text>
            </View>
          ) : null}
        </View>

        {/* ══ 问题描述（必填；placeholder 与副标题随类型变） ══ */}
        <View className={`fb__card${descErr === null ? '' : ' is-err'}`} id="fb-desc">
          <View className="fb__card-hd">
            <Text className="fb__card-h2">问题描述</Text>
            <Text className="fb__req">*</Text>
            <Text className="fb__opt">必填</Text>
          </View>
          <Text className="fb__card-sub">{descSub}</Text>
          <View
            className={`fb__field${descFocus ? ' is-focus' : ''}${
              descErr === null ? '' : ' is-err'
            }`}
          >
            <Textarea
              className="fb__ta"
              value={desc}
              maxlength={DESC_MAXLENGTH}
              placeholder={hintOf(type)}
              onInput={(event) => onDescInput(event.detail.value)}
              onFocus={() => setDescFocus(true)}
              onBlur={() => setDescFocus(false)}
            />
            <View className="fb__fieldfoot">
              <Text className="fb__kb">最多 500 字</Text>
              <Text
                className={`fb__count${tooLong ? ' is-over' : ''}`}
              >{`${desc.length} / ${DESC_MAX}`}</Text>
            </View>
          </View>
          {descErr === null ? null : (
            <View className="fb__err">
              <Image className="fb__err-ic" src={ICONS.warnInk} mode="aspectFit" />
              <Text>{descErr}</Text>
            </View>
          )}
        </View>

        {/* ══ 联系方式（选填，明确写清不会对外公开） ══ */}
        <View className="fb__card">
          <View className="fb__card-hd">
            <Text className="fb__card-h2">联系方式</Text>
            <Text className="fb__opt">选填</Text>
          </View>
          <Text className="fb__card-sub">
            留一个能联系到你的方式（微信号 / 手机号 / 邮箱），我们只会在核实问题时使用，
            <Text className="fb__strong">不会对外公开</Text>。
          </Text>
          <View className={`fb__inputwrap${contactFocus ? ' is-focus' : ''}`}>
            <Image className="fb__input-ic" src={ICONS.serviceMuted} mode="aspectFit" />
            <Input
              className="fb__input"
              value={contact}
              maxlength={CONTACT_MAXLENGTH}
              placeholder="微信号 / 手机号 / 邮箱"
              onInput={(event) => onContactInput(event.detail.value)}
              onFocus={() => setContactFocus(true)}
              onBlur={() => setContactFocus(false)}
            />
          </View>
        </View>

        {/* ══ 隐私提示 + 提交（表单末尾，不吸底：键盘会顶起页面） ══ */}
        <View className="fb__privacy">
          <Image className="fb__privacy-ic" src={ICONS.safeAccent} mode="aspectFit" />
          <Text className="fb__privacy-tx">
            提交即表示你同意我们为处理本次反馈使用上述信息，相关规则见
            <Text className="fb__link" onClick={goPrivacy}>
              《隐私政策》
            </Text>
            。
          </Text>
        </View>

        {submitError === null ? null : (
          <View className="fb__submiterr">
            <Image className="fb__submiterr-ic" src={ICONS.warnInk} mode="aspectFit" />
            <Text className="fb__submiterr-tx">{submitError}</Text>
          </View>
        )}

        <View
          className={`fb__submit${busy ? ' is-busy' : canSubmit ? '' : ' is-off'}`}
          onClick={submit}
        >
          <Text>{busy ? '提交中…' : '提交反馈'}</Text>
        </View>
        <Text className="fb__formfoot">
          如涉及交易纠纷或违规内容，请一并提供商品名称、对方昵称与大致时间
        </Text>
      </View>

      {/* ══ 提交结果弹层（成功 / 上一次重放） ══ */}
      {result !== null && resultCopy !== null ? (
        <>
          <View className="fb__scrim" onClick={() => setResult(null)} />
          <View className="fb__sheet">
            <View className="fb__sheet-grip" />
            <View
              className={`fb__sheet-ic${result.outcome === 'submitted' ? ' is-ok' : ' is-warn'}`}
            >
              <Image
                className="fb__sheet-ic-img"
                src={result.outcome === 'submitted' ? ICONS.checkAccent : ICONS.clockMuted}
                mode="aspectFit"
              />
            </View>
            <Text className="fb__sheet-title">{resultCopy.title}</Text>
            <Text className="fb__sheet-text">{resultCopy.text}</Text>

            <View className="fb__result-meta">
              <Text className="fb__result-k">反馈编号</Text>
              <Text className="fb__result-v num">{shortFeedbackId(result.record.id)}</Text>
            </View>

            {result.simulated ? (
              <Text className="fb__result-demo">
                当前是演示构建，这条反馈只存在于本机内存，不会上传。
              </Text>
            ) : null}

            <View className="fb__sheet-acts">
              <View className="fb__btn-primary" onClick={goMyFeedback}>
                <Text>查看我的反馈</Text>
              </View>
              <View
                className="fb__btn-link"
                onClick={() => {
                  setResult(null)
                  // 重放时草稿还在，用户确认后可改内容重新提交（已换新 clientRequestId）
                }}
              >
                <Text>{result.outcome === 'submitted' ? '知道了' : '继续修改'}</Text>
              </View>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
