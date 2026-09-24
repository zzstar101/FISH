/**
 * 举报浮层（#73 治理半场，用户端）。
 *
 * 商品详情页与他人主页**共用**这一个组件：两处要提交的是同一个端点、同一套原因子集
 * 口径、同一个「重复举报也算受理」的返回语义。在两边各写一遍，早晚会漂出一边
 * （一边把重复举报提示成失败，另一边不会）。
 *
 * ## 交互
 *
 * 调用方只负责两件事：给出目标（`targetType` / `targetId` / `subject`）与当前选中的
 * 原因（`reason`，`null` = 关）。**选原因这一步故意留在调用方**（`pickReportReason`
 * 的 `showActionSheet`）：原生列表在点入口的那个手势里弹出最稳，放进 effect 里会在
 * 浮层挂载的同一帧再弹一次面板，两层面板叠在一起。
 *
 * `detailText` 与「提交中」是本组件的本地状态：它们与「这次要举报谁」无关，
 * 泄到页面 state 里只会让页面多两个用不上的变量。
 *
 * ## 视觉
 *
 * 抄 `pages/sell` 的 AI 润色底部浮层（`sell__scrim` + `sell__sheet`）：遮罩点击关闭、
 * 贴底卡片、`scrim` / `sheet` 两个 mixin 直接复用。**不新增路由** —— 浮层不是页面，
 * `app.config.ts` 的页面注册表因此不用改（sell 的润色卡即先例）。
 */
import type { ReportReason, ReportTargetType } from '@fish/contracts/reports/schema'
import { Image, Text, Textarea, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useEffect, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import { submitReport } from '@/features/report/api'
import {
  pickReportReason,
  REPORT_REASON_LABELS,
  reportFailureMessage,
} from '@/features/report/reasons'
import './index.scss'

/** 契约 `ReportCreateInputSchema.detailText` 的上限（`max(200)`）。 */
const DETAIL_MAX = 200

type ReportSheetProps = {
  targetType: ReportTargetType
  targetId: string
  /** 举报对象的人类称呼，进标题与提示语（「这个商品」/「这位用户」） */
  subject: string
  /** 已选原因；`null` = 不渲染 */
  reason: ReportReason | null
  /** 换原因 / 关闭都走它；传 `null` 即关闭 */
  onReasonChange: (reason: ReportReason | null) => void
}

export default function ReportSheet({
  targetType,
  targetId,
  subject,
  reason,
  onReasonChange,
}: ReportSheetProps) {
  const [detailText, setDetailText] = useState('')
  /** 提交飞行中：按钮禁用 + 遮罩点不动 —— 连点会发出多张单（后端有未决单唯一索引兜底，但那是 200 复用，不该靠它替 UI 防火） */
  const [submitting, setSubmitting] = useState(false)

  // 关掉时把本地状态一起复位：下次打开应当是一张干净的表单，
  // 留着上一次的补充说明会让人以为「已经写好了」。
  useEffect(() => {
    if (reason === null) {
      setDetailText('')
      setSubmitting(false)
    }
  }, [reason])

  if (reason === null) return null

  const toast = (title: string, success = false) => {
    void Taro.showToast({ title, icon: success ? 'success' : 'none' })
  }

  /** 换一个原因：重新唤起原生列表；取消则保持原样（不是「关闭浮层」） */
  const changeReason = () => {
    if (submitting) return
    void pickReportReason(targetType).then((next) => {
      if (next !== null) onReasonChange(next)
    })
  }

  const submit = () => {
    if (submitting) return
    setSubmitting(true)
    void submitReport({
      targetType,
      targetId,
      reason,
      detailText: detailText.trim() === '' ? undefined : detailText.trim(),
    })
      .then((response) => {
        // 重复举报（created:false）**不是失败**：服务端把已存在的那张单原样交回。
        // 提示成「提交失败」会让用户反复重试，而单子其实一直都在。
        toast(
          response.created ? '已提交举报，管理员会尽快处理' : '你已举报过同一个对象，无需重复提交',
          true,
        )
        onReasonChange(null)
      })
      .catch((error: unknown) => {
        setSubmitting(false)
        toast(reportFailureMessage(error))
      })
  }

  return (
    <>
      <View
        className="report__scrim"
        onClick={() => (submitting ? undefined : onReasonChange(null))}
      />
      <View className="report__sheet">
        <View className="report__hd">
          <Image className="report__hd-ic" src={ICONS.warnInk} mode="aspectFit" />
          <Text className="report__hd-tx">{`举报${subject}`}</Text>
        </View>

        <View className="report__reason">
          <Text className="report__reason-label">举报原因</Text>
          <View className="report__reason-chip" onClick={changeReason}>
            <Text className="report__reason-chip-tx">{REPORT_REASON_LABELS[reason]}</Text>
            <Text className="report__reason-change">更换</Text>
          </View>
        </View>

        <View className="report__field">
          <View className="report__frow">
            <Text className="report__flabel">补充说明</Text>
            <Text className="report__fhint num">{`选填 ≤${DETAIL_MAX} 字（${detailText.length}）`}</Text>
          </View>
          <Textarea
            className="report__input report__input--area"
            value={detailText}
            maxlength={DETAIL_MAX}
            disableDefaultPadding
            placeholder="客观描述你看到的问题，便于管理员判断"
            onInput={(event) => setDetailText(event.detail.value)}
          />
        </View>

        <Text className="report__note">
          举报由管理员人工核实，处理结果不单独通知你；恶意举报可能影响你的账号。
        </Text>

        <View className="report__acts">
          <View
            className={`report__btn report__btn--ghost${submitting ? ' is-off' : ''}`}
            onClick={() => (submitting ? undefined : onReasonChange(null))}
          >
            <Text>取消</Text>
          </View>
          <View
            className={`report__btn report__btn--solid${submitting ? ' is-off' : ''}`}
            onClick={submit}
          >
            <Text>{submitting ? '提交中…' : '提交举报'}</Text>
          </View>
        </View>
      </View>
    </>
  )
}
