import { Image, Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import type { FeedbackRecord } from '@/features/feedback/demo'
import { loadMyFeedback } from '@/features/feedback/load'
import { shortFeedbackId } from '@/features/feedback/map'
import {
  FEEDBACK_EMPTY_COPY,
  FEEDBACK_STATUS_META,
  FEEDBACK_TYPE_COPY,
} from '@/features/feedback/meta'
import { readNavMetrics } from '@/lib/nav-metrics'
import './index.scss'

/**
 * 我的反馈（#463；入口：意见反馈页的「我的反馈」行、提交结果弹层的「查看我的反馈」）。
 *
 * ## 形态
 *
 * 与意见反馈页同一套壳：`NavBar glass` 吸顶玻璃栏 + 渐变页头，内容让出栏高后从页头下开始。
 * 单列卡片：类型胶囊 + 状态胶囊 → 内容摘录 → 管理员回复（有才渲染）→ 时间 / 编号脚行。
 *
 * ## 数据口径
 *
 * `GET /feedback/mine`（`features/feedback/load`）：真实构建先发请求，成功渲染真实记录、
 * 失败渲染 `LoadError` + 重试，**不拿演示数据顶替**；只有 `TARO_APP_MOCK=1` 演示构建
 * 请求失败时才回退到 `features/feedback/demo` 的 4 条记录，并在列表上方挂「演示数据」说明带。
 *
 * ## 账号作用域
 *
 * 反馈记录属于当前登录用户：换号时在**渲染期**同步清空 + 加载代次丢弃迟到响应
 * （与「我的举报」同一套写法，见 `pkg-trade/pages/my-reports`）。
 *
 * ## 没有详情页
 *
 * 契约没有单条读取端点，卡片已经把管理员回复完整展示出来 —— 回复上限 500 字，列表里
 * `padding` 内可读，不值得为「点开看全文」再加一页。
 */

export default function MyFeedback() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const nav = useMemo(() => readNavMetrics(), [])

  const [items, setItems] = useState<FeedbackRecord[]>([])
  const [demo, setDemo] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 翻到页数上限时后面还有（`nextCursor` 非 null）→ 脚注不能说「已经到底了」 */
  const [truncated, setTruncated] = useState(false)

  /** 换账号：渲染期同步清空，并用加载代次丢弃迟到响应 */
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
  }

  const read = useCallback(async () => {
    const epoch = ++loadEpoch.current
    setLoading(true)
    const result = await loadMyFeedback()
    if (epoch !== loadEpoch.current) return
    setItems(result.items)
    setDemo(result.demo)
    setFailed(result.failed)
    setTruncated(result.truncated)
    setLoading(false)
  }, [])

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void read()
  }, [authStatus, userId, read])

  /** 空态主按钮：去填写页（redirectTo 不加深栈；返回键回到入口页） */
  const goFeedback = () => {
    void Taro.redirectTo({ url: '/pkg-legal/pages/feedback/index' })
  }

  if (authStatus !== 'authed') {
    return <AuthRequired restoring={authStatus === 'unknown'} />
  }

  return (
    <View className="mfb">
      <NavBar glass title="我的反馈" titleAlign="center" />
      {/* 玻璃栏 fixed：内容让出栏高 */}
      <View style={{ height: `${nav.totalHeight}px` }} />

      <View className="mfb__head">
        <View className="mfb__kicker">
          <Image className="mfb__kicker-ic" src={ICONS.editAccent} mode="aspectFit" />
          <Text>Feedback · 我的反馈</Text>
        </View>
        <Text className="mfb__title">处理进度与回复</Text>
        <Text className="mfb__sub">
          管理员处理后会在这里回复你；提交的联系方式
          <Text className="mfb__strong">只有你与管理员可见</Text>。
        </Text>
      </View>

      {/* 演示说明带：界面上必须能看出列表是演示数据（与「我的举报」同一要求） */}
      {demo && !loading ? (
        <View className="mfb__demoband">
          <Text>演示数据：当前构建没有连上真实接口，以下是演示记录。</Text>
        </View>
      ) : null}

      <View className="mfb__body">
        {loading ? (
          <View className="mfb__skeleton">
            {[0, 1].map((i) => (
              <View key={`sk-${i}`} className="mfb__skel">
                <View className="mfb__skel-bar" style={{ width: '38%' }} />
                <View className="mfb__skel-bar" />
                <View className="mfb__skel-bar" style={{ width: '64%' }} />
              </View>
            ))}
            <Text className="mfb__skel-hint">正在读取反馈记录…</Text>
          </View>
        ) : failed ? (
          <LoadError title="反馈记录加载失败" text="网络似乎不太顺畅，稍后再试试" onRetry={read} />
        ) : items.length === 0 ? (
          <View className="mfb__emptypad">
            <EmptyState
              title={FEEDBACK_EMPTY_COPY.title}
              text={FEEDBACK_EMPTY_COPY.text}
              icon={ICONS.feedbackMuted}
              actionText={FEEDBACK_EMPTY_COPY.actionLabel}
              onAction={goFeedback}
            />
          </View>
        ) : (
          <View className="mfb__list">
            {items.map((record) => {
              const status = FEEDBACK_STATUS_META[record.status]
              return (
                <View key={record.id} className="mfb__card">
                  <View className="mfb__top">
                    <Text className="mfb__type">{FEEDBACK_TYPE_COPY[record.type].label}</Text>
                    <View className={`mfb__chip is-${status.tone}`}>
                      <View className="mfb__chip-dot" />
                      <Text>{status.label}</Text>
                    </View>
                  </View>
                  <Text className="mfb__content">{record.content}</Text>
                  {record.reply === null ? null : (
                    <View className="mfb__reply">
                      <Text className="mfb__reply-k">平台回复</Text>
                      <Text className="mfb__reply-v">{record.reply}</Text>
                    </View>
                  )}
                  <View className="mfb__foot">
                    <Text className="num">{record.timeLabel}</Text>
                    <Text className="mfb__sep">·</Text>
                    <Text className="mfb__id num">{shortFeedbackId(record.id)}</Text>
                  </View>
                </View>
              )
            })}
            <Text className="mfb__more">
              {truncated ? '· 仅显示最近 100 条 ·' : '· 已经到底了 ·'}
            </Text>
          </View>
        )}
      </View>
    </View>
  )
}
