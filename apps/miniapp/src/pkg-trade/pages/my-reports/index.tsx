import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import type { ReportRecord } from '@/features/reports/demo'
import { loadMyReports } from '@/features/reports/load'
import {
  emptyCopyOf,
  REPORT_STATUS_META,
  type ReportTarget,
  reasonLabel,
  shortReportId,
} from '@/features/reports/meta'
import './index.scss'

/**
 * 我的举报（稿 `小程序1版我的举报.html`）。
 *
 * ## 页面形态：与「消息」页同构
 *
 * `TopBar glass` 吸顶玻璃栏：主行「我的 + 举报」双色标题，副行「商品 / 用户」纯文字
 * Tab（选中加粗 + 品牌渐变下划线短棒，计数走等宽字体品牌色、0 不显示 —— 与消息页
 * 同一判据）。列表从玻璃底下滚过；副行占位由本页自补（TopBar 的 spacer 只含主行）。
 * 页头放消息页同款渐变 hero，玻璃栏压在其上。
 *
 * ## Tab 是**筛选取数口径**，不是死控件
 *
 * 两个 Tab 的计数来自同一份列表（`GET /reports/mine`，不分目标类型），**列表读完就渲染**
 * ——真实构建也渲染：数据源已经接线，计数为 0 是「你没有举报过」这个事实，不是「系统不知道」。
 * 只有加载中（还不知道有几条）与失败态不渲染 Tab 行，避免先闪一排 0 再跳成真实计数。
 *
 * ## 演示 / 真实双档（与 favorites / comments 同一体系）
 *
 * - **真实构建**：先发 `GET /reports/mine`（`features/reports/load` 翻页拉齐，封顶 250 条）。
 *   成功 → 真实记录；失败 → `LoadError` + 重试（**不**用演示数据顶替）。
 * - **演示构建**（`TARO_APP_MOCK=1`）：真实请求失败才回退到 7 条演示记录（商品 4 + 用户 3，
 *   三态齐）+ 新建态提交追加的进程内记录，列表下有「演示数据」说明带。
 *
 * ## 卡片点击的去向
 *
 * 商品卡 → `pages/report-listing?reportId=…`，用户卡 → `pages/report-user?reportId=…`
 * （两页互不相通，Owner 2026-09-26 拍板）。编号是后端返回的 `rpt_` 记录 id；两个填写页
 * 按这个编号自己再查一次（契约没有单条读取端点，见 `features/reports/load` 的
 * `loadReportRecord`）。
 *
 * ## 账号作用域（#170 A–D）
 *
 * 举报记录属于当前登录用户：`useAuthGuard()` 驱动加载（unknown 不抢跑，authed 才发）；
 * 换号在**渲染期**同步清空列表 + 加载代次丢弃迟到响应（与 `pages/comments` 同一套写法）。
 */

const TABS: { key: ReportTarget; label: string }[] = [
  { key: 'LISTING', label: '商品' },
  { key: 'USER', label: '用户' },
]

export default function MyReports() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [items, setItems] = useState<ReportRecord[]>([])
  /**
   * `demo` 初值恒 false、`loading` 初值恒 true：真实接口已接线（#252），登录后一定有一次
   * 在途请求，`loading` 初值为 false 会先闪一帧空态再跳成列表。
   */
  const [demo, setDemo] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 翻到页数上限时后面还有（`nextCursor` 非 null）→ 脚注不能说「已经到底了」 */
  const [truncated, setTruncated] = useState(false)
  const [target, setTarget] = useState<ReportTarget>('LISTING')

  /**
   * 账号作用域：换账号时在**渲染期**同步清空，并用加载代次丢弃迟到响应 ——
   * 否则会出现「B 的身份已经渲染、画的却还是 A 的举报」（与 `pages/comments` 同一套写法）。
   */
  const [prevUserId, setPrevUserId] = useState<string | null>(userId)
  const loadEpoch = useRef(0)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    loadEpoch.current += 1
    setItems([])
    setDemo(false)
    setFailed(false)
    setLoading(true)
    setTruncated(false)
    setTarget('LISTING')
  }

  const read = useCallback(async () => {
    // 本次读取的代次：返回时若已不是最新一次，整批结果丢弃（换号 / 重试竞态）
    const epoch = ++loadEpoch.current
    setLoading(true)
    const result = await loadMyReports()
    if (epoch !== loadEpoch.current) return
    setItems(result.items)
    setDemo(result.demo)
    setFailed(result.failed)
    setTruncated(result.truncated)
    setLoading(false)
  }, [])

  useEffect(() => {
    // 未登录不发请求；demo 的演示登录态同样要先拿到身份（userId）再读
    if (authStatus !== 'authed' || userId === null) return
    void read()
  }, [authStatus, userId, read])

  const shown = items.filter((item) => item.target === target)
  const counts = {
    LISTING: items.filter((item) => item.target === 'LISTING').length,
    USER: items.filter((item) => item.target === 'USER').length,
  }

  const copyEmpty = emptyCopyOf(demo)

  /** 卡片点击：按目标类型进对应填写页的只读态（两页互不相通） */
  const openRecord = (record: ReportRecord) => {
    const page = record.target === 'LISTING' ? 'report-listing' : 'report-user'
    // 两个落点都在 pkg-trade 分包里，拼接时必须带上分包 root（`/pages/<name>/index` 已不存在）
    void Taro.navigateTo({
      url: `/pkg-trade/pages/${page}/index?reportId=${encodeURIComponent(record.id)}`,
    })
  }

  const retry = () => {
    void read()
  }

  /** 空态主按钮：真实构建给「去逛逛」回到首页（favorites 同款） */
  const onEmptyAction = () => {
    void Taro.switchTab({ url: '/pages/home/index' })
  }

  if (authStatus !== 'authed') {
    return <AuthRequired restoring={authStatus === 'unknown'} />
  }

  return (
    <View className="rpts">
      {/* 页头渐变：与消息页同一形态，玻璃栏压在其上 */}
      <View className="rpts__bg" />

      <TopBar
        variant="glass"
        spacer
        back
        title="我的"
        titleEm="举报"
        below={
          /* 加载中 / 失败时不渲染：还不知道有几条，先摆一排 0 再跳成真实计数比不摆更差 */
          loading || failed ? null : (
            <View className="rpts__filters">
              <View className="rpts__tabs">
                {TABS.map((tab) => {
                  const on = tab.key === target
                  const n = counts[tab.key]
                  return (
                    <View
                      key={tab.key}
                      className={`rpts__tab${on ? ' is-on' : ''}`}
                      onClick={() => setTarget(tab.key)}
                    >
                      <Text>{tab.label}</Text>
                      {n > 0 ? <Text className="rpts__tab-n num">{`${n}`}</Text> : null}
                    </View>
                  )
                })}
              </View>
            </View>
          )
        }
      />
      {/* 副行占位：20（上衬）+ 68（Tab 高）+ 8（下衬）= 96px，与 .rpts__filters 对应；
          加载中 / 失败时没有副行，只留主行让位（TopBar 的 spacer 已出） */}
      {loading || failed ? null : <View className="rpts__header-gap" />}

      {/* 演示口径说明带：界面上必须能看出列表是演示数据（comments 同款要求） */}
      {demo && !loading ? (
        <View className="rpts__demoband">
          <Text>演示数据：当前构建没有连上真实接口，以下是演示记录。</Text>
        </View>
      ) : null}

      <View className="rpts__body">
        {loading ? (
          <View className="rpts__skeleton">
            {[0, 1, 2].map((i) => (
              <View key={`sk-${i}`} className="rpts__skel">
                <View className="rpts__skel-thumb" />
                <View className="rpts__skel-lines">
                  <View className="rpts__skel-bar" />
                  <View className="rpts__skel-bar" style={{ width: '52%' }} />
                </View>
              </View>
            ))}
            <Text className="rpts__skel-hint">正在读取举报…</Text>
          </View>
        ) : failed ? (
          <LoadError title="举报列表加载失败" text="网络似乎不太顺畅，稍后再试试" onRetry={retry} />
        ) : shown.length === 0 ? (
          <View className="rpts__emptypad">
            <EmptyState
              title={copyEmpty.title}
              text={copyEmpty.text}
              icon={demo ? ICONS.docMuted : ICONS.shieldLine}
              actionText={copyEmpty.actionLabel ?? undefined}
              onAction={copyEmpty.actionLabel ? onEmptyAction : undefined}
            />
          </View>
        ) : (
          <View className="rpts__list">
            {shown.map((record) => {
              const meta = REPORT_STATUS_META[record.status]
              return (
                <View key={record.id} className="rpts__card" onClick={() => openRecord(record)}>
                  {record.target === 'LISTING' ? (
                    <View className="rpts__thumb">
                      <Image className="rpts__thumb-ic" src={ICONS.imageMuted} mode="aspectFit" />
                    </View>
                  ) : (
                    <View className="rpts__thumb rpts__thumb--ava">
                      <Image className="rpts__thumb-ic" src={ICONS.user} mode="aspectFit" />
                    </View>
                  )}
                  <View className="rpts__main">
                    <View className="rpts__top">
                      <Text className="rpts__name">{record.objTitle}</Text>
                      <View className={`rpts__chip is-${meta.tone}`}>
                        <View className="rpts__chip-dot" />
                        <Text>{meta.label}</Text>
                      </View>
                    </View>
                    <View className="rpts__mid">
                      <Text className="rpts__reason">
                        {reasonLabel(record.target, record.reason)}
                      </Text>
                      {record.desc ? <Text className="rpts__desc">{record.desc}</Text> : null}
                    </View>
                    <View className="rpts__foot">
                      <Text className="num">{record.timeLabel}</Text>
                      <Text className="rpts__sep">·</Text>
                      {/* 真实记录的 objTitle 是中性称呼（契约不返回对象摘要），
                          这行目标公开 ID 让用户认出自己举报的是哪一件 / 哪个人 */}
                      {record.objId ? (
                        <>
                          <Text className="rpts__id num">{shortReportId(record.objId)}</Text>
                          <Text className="rpts__sep">·</Text>
                        </>
                      ) : null}
                      <Text className="rpts__id num">{shortReportId(record.id)}</Text>
                    </View>
                  </View>
                  <Image className="rpts__chev" src={ICONS.chevronRightMuted} mode="aspectFit" />
                </View>
              )
            })}
            {/* 翻到页数上限时后面还有，脚注不能说「已经到底了」（`ReportsLoad.truncated`） */}
            <Text className="rpts__more">
              {truncated ? '· 仅显示最近的处理记录 ·' : '· 已经到底了 ·'}
            </Text>
          </View>
        )}
      </View>
    </View>
  )
}
