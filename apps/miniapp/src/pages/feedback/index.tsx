import { Image, Input, Text, Textarea, View } from '@tarojs/components'
import Taro, { usePageScroll } from '@tarojs/taro'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ICONS, type IconName } from '@/assets/lib-icons'
import NavBar from '@/components/nav-bar'
import { readNavMetrics } from '@/lib/nav-metrics'
import {
  FEEDBACK_DRAFT_KEY,
  type FeedbackDraft,
  type FeedbackTypeKey,
  parseFeedbackDraft,
} from './draft'
import './index.scss'

/**
 * 意见反馈（稿 `小程序1版意见反馈.html`，入口：我的 → 帮助与设置「意见反馈」）。
 *
 * ## 本页的实际内容由 zzstar 决策（未定内容页面）
 *
 * 稿是设计演示，**反馈类型清单、各类型引导文案、客服邮箱**都还没有 Owner 决策定稿。
 * 所以本文件照稿落地，并**原样保留所有「待定 / 待填」占位**：
 * - 客服邮箱 `SUPPORT_MAIL` 是**空串**（稿里用虚线 `.ph` 标出的那一处），页面照稿渲染
 *   「待填」，**没有编造任何邮箱**；空值时「复制」只提示待定，不把占位符当邮箱复制走。
 * - 6 个反馈类型的 label 与 hint 逐字取自稿内 `TYPES`；它们是待 Owner 确认的内容，
 *   不是已经拍板的枚举（后端也没有对应枚举 —— 见下）。
 * 待 zzstar 定稿后只改这些常量，不动结构。
 *
 * ## 后端不存在，**不假装提交成功**（稿注释 ⑤ / ⚠️ 上线前必须替换）
 *
 * `apps/api` 里没有 feedback 模块（稿注释原文：`apps/api/src/modules/feedback/` 不存在），
 * 所以提交动线是：**校验 → 「提交中…」短暂态 → 结果弹层**。弹层说的是实话：
 * 「后端反馈接口尚未上线 / 你的内容已暂存在本机 / 可复制客服邮箱发给我们」，
 * 并给出「清空本机暂存的内容」。等真有了 `POST /feedback`，这一段换成成功态即可。
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
 * `ic-alert`→`warnInk`（行内错误 / 弹层警示）、`ic-edit`→`editAccent`（页头 kicker）、
 * `ic-chat`→`chatInk`（交易纠纷）、`ic-shield`→`safeAccent`（违规举报 / 隐私提示）、
 * `ic-phone`→`serviceMuted`（账号与认证 / 联系方式输入框）、`ic-mail`→`mail`（其他 / 客服邮箱行）、
 * `ic-copy`→`docMuted`（复制）、`ic-trash`→`delete`（清空本机暂存）、
 * `ic-clock`→`clockMuted`（暂存恢复提示）、`ic-check`→`checkAccent`（知道了）。
 * 稿里没有 `ic-chevron` 这个 symbol（返回箭头由 `components/nav-bar` 自绘），
 * 所以 `chevronRightMuted` 本页用不到。
 *
 * ## 行为口径（照稿）
 *
 * - 6 个类型胶囊：选中后**描述框 placeholder 与副标题文案跟着变**
 *   （交易纠纷 / 违规举报换成「需要能核对的信息」那一段）—— 稿注释 ②，本页最值钱的一处设计。
 * - 描述框 `maxlength=600`（多留 100 让用户写完再看到超限），**上限判 500 字**、
 *   计数 `n / 500`、少于 5 字算不合格；超限时计数变警示色并拦住提交（稿注释 ⑦）。
 * - 提交按钮**在表单末尾、不吸底**：textarea 聚焦后键盘会顶起页面（稿注释 ③）。
 * - 内容本机暂存 `fish:feedback:draft`（与 `fish:settings` 同一命名风格），
 *   恢复时顶部给一行「已恢复上次未提交的内容 · 清空」；存储失败静默、不崩页面（稿注释 ⑥）。
 * - 校验不过**不弹层**：标红对应卡片 + 滚动到第一个出错处 + `Taro.showToast` 提示。
 * - 页面级滚动（`usePageScroll`）：根节点**不写 `overflow`**，否则页面自身成了滚动容器，
 *   `Taro.pageScrollTo` 会失真（见 `pages/favorites/index.scss` 的同类说明）。
 */

/** 反馈类型：label 给胶囊，hint 给 placeholder（见文件头「本页的实际内容由 zzstar 决策」） */
type FeedbackType = {
  key: FeedbackTypeKey
  label: string
  /** 图标只从 `ICONS` 取；稿的内联 SVG 描边图标按语义就近映射（见本页实现说明） */
  icon: IconName
  hint: string
}

/**
 * hint 的写法直接决定运营方能拿到什么：举报与纠纷必须点名「商品名 / 对方昵称 / 时间」，
 * 否则用户只会写一句「有人骗我」，无法核查（稿注释 ②）。
 */
const TYPES: readonly FeedbackType[] = [
  {
    key: 'bug',
    label: '功能异常',
    icon: 'warnInk',
    hint: '请描述出现问题的页面、你的操作步骤，以及你期望的结果，便于我们复现',
  },
  {
    key: 'ux',
    label: '体验建议',
    icon: 'editAccent',
    hint: '请描述你觉得不顺手的地方，以及你希望改成什么样',
  },
  {
    key: 'dispute',
    label: '交易纠纷',
    icon: 'chatInk',
    hint: '请提供商品名称、对方昵称与大致交易时间，便于我们核对交易记录',
  },
  {
    key: 'report',
    label: '违规举报',
    icon: 'safeAccent',
    hint: '请提供违规内容的位置（商品 / 会话 / 用户昵称）与具体情形，我们会尽快核查',
  },
  {
    key: 'account',
    label: '账号与认证',
    icon: 'serviceMuted',
    hint: '请描述你遇到的问题，例如收不到验证码、认证状态异常、无法登录等',
  },
  {
    key: 'other',
    label: '其他',
    icon: 'mail',
    hint: '请描述你遇到的问题或建议，包含出现的位置、操作步骤与期望结果，便于我们定位',
  },
]

const DEFAULT_HINT = '请描述你遇到的问题或建议，包含出现的位置、操作步骤与期望结果，便于我们定位'
const DESC_SUB_DEFAULT = '请尽量写清出现的位置与操作步骤，越具体越容易定位。'
/** 交易纠纷 / 违规举报：这两类没有可核对的信息就无法处理（稿 `syncDescHint`） */
const DESC_SUB_CHECKABLE = '这一类需要能核对的信息：请写清商品名称、对方昵称与大致时间。'
const ERR_TYPE = '请先选择反馈类型'
const ERR_DESC_SHORT = '请至少填写 5 个字，便于我们定位问题'
const ERR_DESC_LONG = '描述不能超过 500 字，请精简后再提交'

/** 上限判 500（计数与拦截都用它）；输入框多留 100，让用户写完再看到超限（稿注释 ⑦） */
const DESC_MAX = 500
const DESC_MIN = 5
const DESC_MAXLENGTH = 600
const CONTACT_MAXLENGTH = 40

/**
 * 客服邮箱：**待 zzstar 决策后填写**（稿里用虚线 `.ph` 标出的占位）。
 * 留空 = 还没定，页面照稿渲染「待填」，复制按钮只提示待定。
 */
const SUPPORT_MAIL = ''

function hintOf(key: FeedbackTypeKey | ''): string {
  const hit = TYPES.find((item) => item.key === key)
  return hit ? hit.hint : DEFAULT_HINT
}

/**
 * 读本机暂存。**存储不可用 / 内容为空都当作「没有草稿」**，不该让页面崩。
 *
 * 解析本身（两种存储形态、字段级容错、空草稿判据）在 `./draft`，是纯函数、有单测；
 * 这里只剩「取 → 解析」这一步必须碰 Taro 的部分。
 */
function readStoredDraft(): FeedbackDraft | null {
  try {
    return parseFeedbackDraft(Taro.getStorageSync(FEEDBACK_DRAFT_KEY))
  } catch {
    return null
  }
}

export default function Feedback() {
  /** 冷启动读一次本机暂存；`null` = 没有可恢复的内容 */
  const [draft] = useState(readStoredDraft)
  const [type, setType] = useState<FeedbackTypeKey | ''>(draft?.type ?? '')
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
  /** 结果弹层（兜底渠道）是否打开 */
  const [sheetOpen, setSheetOpen] = useState(false)

  const nav = useMemo(() => readNavMetrics(), [])
  const scrollTopRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 表单当前值的**最新**快照（每次渲染同步刷新）。
   *
   * 「提交中…」那 700ms 里输入框没有禁用（用户还在打字，输入会即时落暂存），
   * 而定时器回调是个**旧闭包**：直接读 `type/desc/contact` 拿到的是点击那一刻的值，
   * 一旦用户在等待期间补了字，回调落地时会把新内容**覆盖回旧值** —— 恰好违背弹层那句
   * 「你的内容已暂存在本机」。定时器里一律读这个 ref。
   */
  const stateRef = useRef({ type, desc, contact })
  stateRef.current = { type, desc, contact }

  usePageScroll(({ scrollTop }) => {
    scrollTopRef.current = scrollTop
  })

  useEffect(
    () => () => {
      // 卸载作废「提交中…」的定时：迟到的回调不得写回已离开的页面
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const toast = (title: string) => {
    void Taro.showToast({ title, icon: 'none' })
  }

  /**
   * 写本机暂存。失败静默（稿注释 ⑥「存储失败不致命」）。
   *
   * **必须显式传整份草稿**，不能在回调里读 state：`setState` 要下一轮渲染才生效，
   * 事件回调里读到的是**改动前**的值，那样刚输入的字不会进暂存。
   */
  const persistDraft = (next: FeedbackDraft) => {
    try {
      Taro.setStorageSync(FEEDBACK_DRAFT_KEY, next)
    } catch {
      // 存储失败不影响页面交互
    }
  }

  /** 清空本机暂存并复位表单（提示条的「清空」与弹层的「清空本机暂存的内容」共用） */
  const resetForm = () => {
    try {
      Taro.removeStorageSync(FEEDBACK_DRAFT_KEY)
    } catch {
      // 忽略：清不掉也只是留着一份草稿，不该让页面崩
    }
    setType('')
    setDesc('')
    setContact('')
    setTypeErr(false)
    setDescErr(null)
    setRestored(false)
  }

  const selectType = (key: FeedbackTypeKey) => {
    setType(key)
    setTypeErr(false)
    persistDraft({ type: key, desc, contact })
  }

  const onDescInput = (value: string) => {
    setDesc(value)
    // 够 5 个字就撤掉行内错误（同稿 desc 的 input 处理）
    if (value.trim().length >= DESC_MIN) setDescErr(null)
    persistDraft({ type, desc: value, contact })
  }

  const onContactInput = (value: string) => {
    setContact(value)
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
   * 提交：校验 → 「提交中…」→ 结果弹层。
   *
   * 真实端点（`POST /feedback`）不存在，所以**不假装成功**：弹层把「内容没丢 + 怎么送到」
   * 一次说清。校验不过时不弹层：标红对应卡片 + 滚到第一个出错处 + toast。
   */
  const submit = () => {
    if (busy) return
    const missingType = type === ''
    const descTooLong = desc.length > DESC_MAX
    const descTooShort = desc.trim().length < DESC_MIN
    if (missingType || descTooShort || descTooLong) {
      if (missingType) setTypeErr(true)
      if (descTooShort || descTooLong) setDescErr(descTooLong ? ERR_DESC_LONG : ERR_DESC_SHORT)
      scrollToCard(missingType ? '#fb-type' : '#fb-desc')
      toast('还有必填项没有填完')
      return
    }
    setBusy(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setBusy(false)
      // 内容落本机暂存，弹层才敢说「你的内容已暂存在本机」（稿的 submit 同款顺序）。
      // 读 `stateRef` 而不是闭包里的 state：这 700ms 内用户可能又补了字（见 stateRef 的说明）
      persistDraft(stateRef.current)
      setSheetOpen(true)
    }, 700)
  }

  /**
   * 复制客服邮箱。
   *
   * 稿里复制的是 `.mail-txt b` 的可见文字（虚线占位「待填」）—— 邮箱还没定，
   * 把占位符当邮箱复制走是假信息，所以空值时只提示待定，不碰剪贴板。
   * 复制成功后微信自己会弹「内容已复制」，这里不再叠一层 toast（同 `pages/report-listing`）。
   */
  const copyMail = () => {
    if (SUPPORT_MAIL === '') {
      toast('客服邮箱待定，暂时无法复制')
      return
    }
    void Taro.setClipboardData({ data: SUPPORT_MAIL }).catch(() => toast('复制失败，请长按选中'))
  }

  const goPrivacy = () => {
    void Taro.navigateTo({ url: '/pages/privacy/index' })
  }

  const tooLong = desc.length > DESC_MAX
  const canSubmit = type !== '' && desc.trim().length >= DESC_MIN && !tooLong
  const descSub = type === 'dispute' || type === 'report' ? DESC_SUB_CHECKABLE : DESC_SUB_DEFAULT

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
          你的反馈我们
          <Text className="fb__strong fb__strong--fg">会逐条阅读</Text>
          。需要向你了解情况时，我们会通过你留下的联系方式与你联系。
        </Text>
      </View>

      {/* ── 本机暂存恢复提示（有内容才出现，空草稿不打扰用户） ── */}
      {restored ? (
        <View className="fb__draft">
          <Image className="fb__draft-ic" src={ICONS.clockMuted} mode="aspectFit" />
          <Text className="fb__draft-tx">
            已恢复上次未提交的内容。提交前它会一直保存在你的手机本地。
          </Text>
          <View
            className="fb__draft-clear"
            onClick={() => {
              resetForm()
              toast('已清空')
            }}
          >
            <Text>清空</Text>
          </View>
        </View>
      ) : null}

      <View className="fb__form">
        {/* ══ 反馈类型（必填） ══ */}
        <View className={`fb__card${typeErr ? ' is-err' : ''}`} id="fb-type">
          <View className="fb__card-hd">
            <Text className="fb__card-h2">反馈类型</Text>
            <Text className="fb__req">*</Text>
            <Text className="fb__opt">必填</Text>
          </View>
          <Text className="fb__card-sub">选择最接近的一项，我们会转给对应的同学处理。</Text>
          <View className="fb__pills">
            {TYPES.map((item) => (
              <View
                key={item.key}
                className={`fb__pill${type === item.key ? ' is-on' : ''}`}
                onClick={() => selectType(item.key)}
              >
                <Image className="fb__pill-ic" src={ICONS[item.icon]} mode="aspectFit" />
                <Text>{item.label}</Text>
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

      {/* ══ 提交结果 · 兜底渠道弹层（后端不存在，这里不假装成功） ══ */}
      {sheetOpen ? (
        <>
          <View className="fb__scrim" onClick={() => setSheetOpen(false)} />
          <View className="fb__sheet">
            <View className="fb__sheet-grip" />
            <View className="fb__sheet-ic">
              <Image className="fb__sheet-ic-img" src={ICONS.warnInk} mode="aspectFit" />
            </View>
            <Text className="fb__sheet-title">提交功能待接入</Text>
            <Text className="fb__sheet-text">
              后端反馈接口尚未上线。
              <Text className="fb__strong fb__strong--fg">你的内容已暂存在本机</Text>
              ，可直接复制后通过下面的客服邮箱发给我们。
            </Text>

            <View className="fb__mailrow">
              <Image className="fb__mail-ic" src={ICONS.mail} mode="aspectFit" />
              <View className="fb__mail-txt">
                <Text className="fb__mail-em">客服邮箱</Text>
                <Text className="fb__mail-b">
                  {SUPPORT_MAIL === '' ? <Text className="fb__ph">待填</Text> : SUPPORT_MAIL}
                </Text>
              </View>
              <View className="fb__mail-copy" onClick={copyMail}>
                <Image className="fb__copy-ic" src={ICONS.docMuted} mode="aspectFit" />
                <Text>复制</Text>
              </View>
            </View>

            <View className="fb__sheet-acts">
              <View className="fb__btn-ghost" onClick={() => setSheetOpen(false)}>
                <Image className="fb__btn-ic" src={ICONS.checkAccent} mode="aspectFit" />
                <Text>知道了，我稍后再发</Text>
              </View>
              <View
                className="fb__btn-link"
                onClick={() => {
                  resetForm()
                  setSheetOpen(false)
                  toast('已清空本机暂存')
                }}
              >
                <Image className="fb__btn-ic" src={ICONS.delete} mode="aspectFit" />
                <Text>清空本机暂存的内容</Text>
              </View>
            </View>
          </View>
        </>
      ) : null}
    </View>
  )
}
