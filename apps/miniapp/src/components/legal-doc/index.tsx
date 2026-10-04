import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { usePageScroll, useReady } from '@tarojs/taro'
import { useCallback, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import BackTop, { BACK_TOP_THRESHOLD } from '@/components/back-top'
import NavBar from '@/components/nav-bar'
import { markConsent } from '@/features/legal/entry'
import type { Block, LegalDoc, LegalSection, ListItem, Run } from '@/features/legal/types'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 法务长文档的**页面主体**：用户协议与隐私政策共用一份实现。
 *
 * 两份稿（`小程序1版用户协议.html` / `小程序1版隐私政策.html`）的形态差异只有三处
 * ——「重要提示」块 vs「一句话摘要」卡、有没有信息清单 —— 其余（文档头 / 目录 / 章 /
 * 页脚 / 进度条 / 回到顶部 / 目录抽屉 / 吸底同意条）逐像素同构。抄两份必然漂移，
 * 所以正文形状收进 `features/legal/types.ts` 的数据模型，这里只按 `kind` 分派渲染。
 *
 * ## ⚠️ 内容口径
 *
 * 正文由 `features/legal/terms.ts` / `privacy.ts` 提供，两个文件都标注为
 * **未定内容页面** —— 稿里的法务正文是初稿，**实际内容由 zzstar 决策**。
 * 定稿时只改那两个数据文件，本组件不需要动。稿内虚线标出的待填字段
 * （运营者全称 / 联系邮箱 / 联系地址 / 更新与生效日期）一律按 `ph` 片段渲染成
 * 「虚线 + 警示色」，**不编造内容**。
 *
 * ## 顶栏为什么是 `NavBar` 而不是稿里的 `.mp-nav`
 *
 * 稿是独立 HTML，那个带假胶囊（`.mp-capsule`）的 `.mp-nav` 是在**模拟微信原生导航栏**。
 * 本项目全端 `navigationStyle: 'custom'`，真机上没有原生栏，所有页面都用自己的
 * `components/nav-bar`。落在小程序里就是「`NavBar glass` + 居中标题」，胶囊交给微信。
 *
 * ## 三处稿内取舍的落地方式
 *
 * - **导航标题初始隐藏**（稿取舍 ⑤）：法律页若导航标题常驻，首屏会出现「导航 用户协议 +
 *   正文 用户协议」两行重复。文档头滚出视野后（`headAtRef`，`useReady` 量一次）才淡入 ——
 *   与 `pages/user`、`pages/report-listing` 同一手法。
 * - **阅读进度条**（稿取舍 ⑥）：挂在 `NavBar` 的 `progress` 上，条画在栏的底边 ——
 *   页面对栏的真实高度没有可靠口径（状态栏是设备 px、钮高是 rpx），自绘必然错位。
 * - **目录抽屉**（稿取舍 ④）：稿里抽屉只由机身外的演示状态切换条打开，屏内没有入口；
 *   落地时把**目录卡的标题行**做成入口（点「目录」拉开抽屉），章节条目在卡片内与抽屉里
 *   都能直接跳章。跳章用 `pageScrollTo({ scrollTop, duration: 300 })` 而不是平滑滚到
 *   `selector`：稿实测跨 12 章的平滑滚动要滑约 1.5s，真机上显得卡。
 *
 * ## 渲染开销
 *
 * 滚动事件很密，而进度条每帧都可能变 —— 如果整篇正文跟着重渲染，12 章的树每帧都重建。
 * 所以正文（目录 + 各章 + 页脚）包在 `useMemo` 里：元素引用不变时 React 会跳过整棵子树，
 * 每帧只重渲染顶栏、回到顶部钮与弹层。
 */
type Props = {
  doc: LegalDoc
  /**
   * 是否从**登录/注册流程**进入（稿状态 02）→ 渲染吸底同意条。
   *
   * 从设置页进来是纯阅读：对一个已经生效的协议再点一次「同意」语义是错的（稿取舍 ⑦），
   * 所以这个开关由页面按路由参数决定，组件不猜。
   */
  entry: boolean
}

/**
 * 行内片段 → 嵌套 `Text`。
 *
 * 小程序没有 `dangerouslySetInnerHTML`，也没有「富文本字符串」这条通用路径：
 * `text` 节点的子节点必须是 `text`（不能是 `view` / `image`），所以加粗、等宽说明、
 * 待填占位只能靠 `Text` 嵌套 `Text` + class 表达。
 *
 * key 优先用数据的 `k`（生成时只给「同一数组里有重复文本」的那几个数组补上），
 * 否则用文本本身：片段数组是静态数据，位置就是稳定标识。
 */
function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((run) => (
        <Text key={run.k ?? run.t} className={runClass(run)}>
          {run.t}
        </Text>
      ))}
    </>
  )
}

/**
 * 片段标记 → class（**可叠加**）。
 *
 * 稿里 `<strong>` 与 `<span class="ph">` 会嵌套（第 11.2 条的
 * `<strong>… <span class="ph">运营者全称</span> …</strong>`），所以一个片段可能同时是
 * 加粗与待填占位 —— 早先写成「命中即 return」会让 `ph` 静默失效（占位提示消失）。
 */
function runClass(run: Run): string | undefined {
  const cls: string[] = []
  if (run.b) cls.push('ld__b')
  if (run.em) cls.push('ld__em')
  if (run.ph) cls.push('ld__ph')
  return cls.length > 0 ? cls.join(' ') : undefined
}

/** 法务文档之间互链的两个目标；只有它们需要继承「从登录流程进入」这个来源 */
const LEGAL_PAGES = new Set(['/pkg-legal/pages/terms/index', '/pkg-legal/pages/privacy/index'])

/**
 * 页脚互链的落点。
 *
 * 从登录流程进来的实例带着 `?from=login`（同意条据此显示）。互链**必须把它传下去**，
 * 否则：登录 → 用户协议（有同意条）→ 页脚《隐私政策》（**没有**同意条）→ 再互链回用户协议
 * 又是个新实例、仍然没有 —— 用户读到一半发现同意条整段消失，得连按几次返回才回到有它的那层。
 * 稿的页脚是裸 `<a href>`（静态稿里没有「来源」这个概念），这里按落地需要补上。
 * 意见反馈不是法务文档，不带这个参数。
 */
function crossLinkUrl(page: string, entry: boolean): string {
  return entry && LEGAL_PAGES.has(page) ? `${page}?from=login` : page
}

/** 信息清单的一条：名称 + 必要性标签 + 用途 */
function ItemRow({ item }: { item: ListItem }) {
  return (
    <View className="ld__item">
      <View className="ld__item-top">
        <Text className="ld__item-name">
          <Runs runs={item.name} />
        </Text>
        <Text className={`ld__tag ld__tag--${item.tag.tone}`}>{item.tag.text}</Text>
      </View>
      <Text className="ld__item-use">
        <Runs runs={item.use} />
      </Text>
    </View>
  )
}

/** 正文块分派。稿里六种块的标记结构各自固定，所以这里按 `kind` 直出，不做通用化。 */
function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    /** 条款行：编号单独成列（稿取舍 ②，编号进正文会让换行后对不齐） */
    case 'clause':
      return (
        <View className="ld__clause">
          <Text className="ld__clause-no num">{block.no}</Text>
          <Text className="ld__clause-tx">
            <Runs runs={block.runs} />
          </Text>
        </View>
      )

    /** 左竖线强调块（稿 `.key`）：免责、平台角色、注销这类需要单独跳出来的条款 */
    case 'key':
      return (
        <View className="ld__key">
          <Text className="ld__key-tx">
            <Runs runs={block.runs} />
          </Text>
        </View>
      )

    /** 禁止事项 / 联系方式这类编号子项（稿 `.sub`） */
    case 'sub':
      return (
        <View className="ld__sub">
          <Text className="ld__sub-no num">{block.no}</Text>
          <Text className="ld__sub-tx">
            <Runs runs={block.runs} />
          </Text>
        </View>
      )

    /** 文档头下方的「请先阅读这一段」（稿 `.callout`） */
    case 'callout':
      return (
        <View className="ld__callout">
          <View className="ld__callout-hd">
            <Image className="ld__callout-hd-ic" src={ICONS.warnInk} mode="aspectFit" />
            <Text>{block.head}</Text>
          </View>
          <Text className="ld__callout-tx">
            <Runs runs={block.runs} />
          </Text>
        </View>
      )

    /**
     * 信息清单（稿 `.list`）：**刻意不用四列表格** —— 390pt 画布扣掉 gutter 只剩 350pt，
     * 四列每列不足 90pt，中文两字就换行（稿取舍 ③）。改成「信息项 + 必要性标签 + 用途」三段式。
     */
    case 'list':
      return (
        <View className="ld__list">
          <View className="ld__list-hd">
            <Image className="ld__list-hd-ic" src={ICONS[block.head.icon]} mode="aspectFit" />
            <Text>{block.head.text}</Text>
          </View>
          {block.items.map((item) => (
            <ItemRow key={item.key} item={item} />
          ))}
        </View>
      )

    /** 「我们不会收集这些」（稿 `.notlist`，成功色） */
    case 'notlist':
      return (
        <View className="ld__notlist">
          <View className="ld__notlist-hd">
            <Image className="ld__notlist-hd-ic" src={ICONS[block.head.icon]} mode="aspectFit" />
            <Text>{block.head.text}</Text>
          </View>
          <Text className="ld__notlist-tx">
            <Runs runs={block.runs} />
          </Text>
        </View>
      )
  }
}

/**
 * 组件名带 `View` 后缀：`LegalDoc` 已经是**数据模型**的类型名（`features/legal/types`），
 * 同名会让 `noRedeclare` 报错，也会让「文档数据」与「文档渲染」在阅读时分不清。
 */
export default function LegalDocView({ doc, entry }: Props) {
  /** 顶栏总高（设备 px）：正文与固定玻璃栏的让位、跳章的偏移都用它 */
  const navHeight = useMemo(() => readNavMetrics().totalHeight, [])

  const [titled, setTitled] = useState(false)
  const [showTop, setShowTop] = useState(false)
  const [progress, setProgress] = useState(0)
  const [tocOpen, setTocOpen] = useState(false)

  /** 当前滚动量（设备 px）。跳章要把它加回视口坐标才是页面坐标 */
  const scrollTopRef = useRef(0)
  /** 可滚动总长 = 页面高 − 视口高；`useReady` 量一次（正文是静态的，不会变） */
  const scrollableRef = useRef(0)
  /** 文档头下沿在**页面坐标**里的位置：滚过它才让导航标题淡入 */
  const headAtRef = useRef(Number.POSITIVE_INFINITY)
  /** 已提交的进度值。用 ref 而不是读 state：`usePageScroll` 的回调闭包不保证是最新一帧的 */
  const progressRef = useRef(0)
  /**
   * 吸底同意条按钮的**同步**防连点闸门。
   *
   * 同意条在页面卸载前一直渲染，两次快速点击会连发两次 `navigateBack()`，把登录页一起弹掉
   * （仓库对同类问题有先例：`pages/login` 的 `wechatBusyRef`，#198 P3-2 —— `setState`
   * 要下一轮渲染才可见，同一帧的第二次点击读到的仍是旧值，所以必须用 ref 判）。
   */
  const consentTapRef = useRef(false)

  const claimConsentTap = () => {
    if (consentTapRef.current) return false
    consentTapRef.current = true
    return true
  }

  /**
   * 同意条按下之后的返回。
   *
   * `navigateBack` 也可能失败（冷启动直接落在这一页、或栈里只有这一页）——失败时**把闸门放开**，
   * 否则两个按钮会永久无响应且没有任何提示（先例 `pages/login` 的 `setBusy(false)` 就在
   * 失败路径上复位）。决定已经 `markConsent` 落值，所以即使返回失败，用户用导航栏返回时
   * 登录页仍能兑现它。
   */
  const leaveAfterConsent = () => {
    void Taro.navigateBack().catch(() => {
      consentTapRef.current = false
      void Taro.showToast({ title: '返回失败，请用左上角返回', icon: 'none' })
    })
  }

  useReady(() => {
    Taro.createSelectorQuery()
      .select('.ld')
      .boundingClientRect()
      .exec((res) => {
        const rect = res?.[0] as { height?: number } | undefined
        const windowHeight = Taro.getWindowInfo().windowHeight ?? 0
        // 量不到（节点还没上屏）就留 0：进度条不显示，比显示一个错的比例好
        scrollableRef.current =
          typeof rect?.height === 'number' ? Math.max(1, rect.height - windowHeight) : 0
      })

    Taro.createSelectorQuery()
      .select('.ld__head')
      .boundingClientRect()
      .exec((res) => {
        const rect = res?.[0] as { top?: number; height?: number } | undefined
        // `boundingClientRect` 给的是视口坐标，加上当时的滚动量才是它在页面里的位置
        if (typeof rect?.top === 'number' && typeof rect?.height === 'number') {
          headAtRef.current = rect.top + scrollTopRef.current + rect.height
        }
      })
  })

  usePageScroll(({ scrollTop }) => {
    scrollTopRef.current = scrollTop
    const nextTitled = scrollTop > headAtRef.current
    setTitled((prev) => (prev === nextTitled ? prev : nextTitled))
    setShowTop(scrollTop > BACK_TOP_THRESHOLD)
    const next =
      scrollableRef.current > 0 ? Math.min(1, Math.max(0, scrollTop / scrollableRef.current)) : 0
    // 千分之二以内不动：进度条视觉上分不出来，省掉大量无谓渲染
    if (Math.abs(next - progressRef.current) >= 0.002 || next === 0 || next === 1) {
      progressRef.current = next
      setProgress(next)
    }
  })

  /**
   * 跳章：先量该章相对视口的位置，换算成页面坐标，再让页面滚过去。
   *
   * 不用 `pageScrollTo({ selector })`：那给不了 `duration`，长距离跳转会滑 1.5s 以上
   * （稿取舍 ④ 的实测）。偏移留 `navHeight + 8`，否则章标题会停在固定玻璃栏底下。
   */
  const goToSection = useCallback(
    (id: string) => {
      setTocOpen(false)
      Taro.createSelectorQuery()
        .select(`#${id}`)
        .boundingClientRect()
        .exec((res) => {
          const rect = res?.[0] as { top?: number } | undefined
          if (typeof rect?.top !== 'number') return
          const target = scrollTopRef.current + rect.top - navHeight - 8
          void Taro.pageScrollTo({ scrollTop: Math.max(0, target), duration: 300 })
        })
    },
    [navHeight],
  )

  const backToTop = useCallback(() => {
    void Taro.pageScrollTo({ scrollTop: 0, duration: 300 })
  }, [])

  /** 目录条目（正文目录卡与抽屉共用同一份标记，避免两处漂移） */
  const tocRow = useCallback(
    (sec: LegalSection) => (
      <View key={sec.id} className="ld__toc-item" onClick={() => goToSection(sec.id)}>
        <Text className="ld__toc-no num">{sec.num}</Text>
        <Text className="ld__toc-tx">{sec.title}</Text>
        <Image className="ld__toc-chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
      </View>
    ),
    [goToSection],
  )

  /**
   * 正文（文档头 → 摘要/提示 → 目录卡 → 各章 → 页脚）。
   *
   * `useMemo` 是**性能要求**而不是洁癖：进度条每帧都可能改 `progress`，没有这一层的话
   * 12 章的树会跟着每帧重建。元素引用不变时 React 直接跳过这棵子树。
   */
  const body = useMemo(
    () => (
      <View className="ld__body">
        <View className="ld__head">
          <View className="ld__kicker">
            <Image className="ld__kicker-ic" src={ICONS[doc.kicker.icon]} mode="aspectFit" />
            <Text className="ld__kicker-tx">{doc.kicker.text}</Text>
          </View>
          <Text className="ld__title">{doc.title}</Text>
          <View className="ld__meta">
            {doc.meta.map((line) => (
              <Text key={line.map((run) => run.t).join('')} className="ld__meta-item">
                <Runs runs={line} />
              </Text>
            ))}
          </View>
        </View>

        {/* 隐私政策：一句话摘要卡（稿 `.brief`） */}
        {doc.brief ? (
          <View className="ld__brief">
            <View className="ld__brief-hd">
              <Image className="ld__brief-hd-ic" src={ICONS.lock} mode="aspectFit" />
              <Text>{doc.brief.head}</Text>
            </View>
            <Text className="ld__brief-lead">
              <Runs runs={doc.brief.lead} />
            </Text>
            <View className="ld__brief-ul">
              {doc.brief.items.map((item) => (
                <View key={item.map((run) => run.t).join('')} className="ld__brief-li">
                  <Image className="ld__brief-li-ic" src={ICONS.checkAccent} mode="aspectFit" />
                  <Text className="ld__brief-li-tx">
                    <Runs runs={item} />
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* 用户协议：请先阅读这一段（稿 `.callout`） */}
        {doc.callout ? (
          <BlockView block={{ key: 'callout', kind: 'callout', ...doc.callout }} />
        ) : null}

        <View className="ld__toc">
          {/* 标题行即抽屉入口（稿里抽屉只由机身外控制条打开，屏内没有入口） */}
          <View className="ld__toc-hd" onClick={() => setTocOpen(true)}>
            <Image className="ld__toc-hd-ic" src={ICONS.category} mode="aspectFit" />
            <Text className="ld__toc-hd-tx">目录</Text>
            <Text className="ld__toc-hd-cnt num">{`共 ${doc.sections.length} 章`}</Text>
          </View>
          <View className="ld__toc-list">{doc.sections.map(tocRow)}</View>
        </View>

        {doc.sections.map((sec) => (
          <View key={sec.id} id={sec.id} className="ld__sec">
            <View className="ld__sec-hd">
              <Text className="ld__sec-num num">{sec.num}</Text>
              <Text className="ld__sec-title">{sec.title}</Text>
            </View>
            {sec.blocks.map((block) => (
              <BlockView key={block.key} block={block} />
            ))}
          </View>
        ))}

        <View className="ld__foot">
          <View className="ld__foot-note">
            {doc.footNote.map((line) => (
              <Text key={line.map((run) => run.t).join('')} className="ld__foot-line num">
                <Runs runs={line} />
              </Text>
            ))}
          </View>
          <View className="ld__foot-links">
            {doc.links.map((link) => (
              <View
                key={link.page}
                className="ld__foot-link"
                onClick={() => void Taro.navigateTo({ url: crossLinkUrl(link.page, entry) })}
              >
                <Image className="ld__foot-link-ic" src={ICONS[link.icon]} mode="aspectFit" />
                <Text>{link.label}</Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    ),
    // `tocRow` 已经把 `goToSection` 收进自己的依赖，所以这里不必再列一次；
    // `doc` 是静态数据，`entry` 只影响页脚互链要不要带上 `?from=login`
    [doc, tocRow, entry],
  )

  return (
    <View className="ld" style={{ paddingTop: `${navHeight}px` }}>
      <NavBar
        glass
        titleAlign="center"
        title={titled ? doc.navTitle : undefined}
        progress={progress}
      />

      {/* 顶部让位在根节点（设备 px，内联下发不走 pxtransform）；固定玻璃栏会让出整条栏高。
          吸底同意条出现时正文再让出条高 —— 由 `.ld__doc.is-entry` 的下内边距承担 */}
      <View className={`ld__doc${entry ? ' is-entry' : ''}`}>{body}</View>

      <BackTop
        show={showTop}
        onTop={backToTop}
        right="28rpx"
        bottom={entry ? 'calc(360rpx + env(safe-area-inset-bottom))' : '40rpx'}
      />

      {entry ? (
        <View className="ld__agree">
          <View className="ld__agree-note">
            <Image className="ld__agree-note-ic" src={ICONS.checkAccent} mode="aspectFit" />
            <Text>{doc.agree.note}</Text>
          </View>
          <View
            className="ld__agree-ok"
            onClick={() => {
              if (!claimConsentTap()) return
              // 把「同意」带回登录页勾上：用户可能先取消过勾选，不回传的话回来 CTA 仍是禁用的
              markConsent('agreed')
              void Taro.showToast({ title: '已同意', icon: 'none' })
              leaveAfterConsent()
            }}
          >
            <Image className="ld__agree-ok-ic" src={ICONS.checkWhite} mode="aspectFit" />
            <Text>{doc.agree.ok}</Text>
          </View>
          <View
            className="ld__agree-no"
            onClick={() => {
              if (!claimConsentTap()) return
              // 把「不同意」带回登录页取消勾选，否则这句提示是假的（见 `entry.ts` 的说明）
              markConsent('declined')
              void Taro.showToast({ title: '未同意，无法继续使用', icon: 'none' })
              leaveAfterConsent()
            }}
          >
            <Text>{doc.agree.no}</Text>
          </View>
        </View>
      ) : null}

      {tocOpen ? (
        <>
          <View className="ld__scrim" onClick={() => setTocOpen(false)} />
          <View className="ld__sheet">
            <View className="ld__sheet-grip" />
            <View className="ld__sheet-hd">
              <Image className="ld__sheet-hd-ic" src={ICONS.category} mode="aspectFit" />
              <Text className="ld__sheet-title">章节导航</Text>
              <Text className="ld__sheet-cnt num">{`共 ${doc.sections.length} 章`}</Text>
              <View className="ld__sheet-close" onClick={() => setTocOpen(false)}>
                <Image className="ld__sheet-close-ic" src={ICONS.closeInk} mode="aspectFit" />
              </View>
            </View>
            <ScrollView className="ld__sheet-body" scrollY>
              {doc.sections.map(tocRow)}
            </ScrollView>
          </View>
        </>
      ) : null}
    </View>
  )
}
