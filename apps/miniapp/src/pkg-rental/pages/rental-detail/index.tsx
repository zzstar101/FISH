import { RENTAL_DEPOSIT_NOTICE, type RentalDetail } from '@fish/contracts/rentals/schema'
import { Image, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useState } from 'react'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { fetchRentalDetail, offlineRental, onlineRental } from '@/features/rental/api'
import { formatAmount } from '@/lib/money'
import './index.scss'

/**
 * 出租详情（#706 RNT-02）。
 *
 * ## 押金说明常驻
 *
 * `RENTAL_DEPOSIT_NOTICE.full` 在本页**默认可见、不得折叠** —— 它是免责声明的核心
 * （平台不代收 / 不托管 / 不垫付 / 不赔付），小程序审核会看这一段。所以它是一块独立卡片，
 * 不与规则文字挤在一起。
 *
 * ## 联系出租人
 *
 * 复用买卖域的会话（同一个 `POST /conversations`）—— 出租与出售共用「双人会话」这张表，
 * 会话头部的商品卡按 `listingId` 取。本页只负责发起，聊天页本身不改。
 *
 * ## 预约入口
 *
 * **本单不提供**：租期计算、档期占用与预约提交归 #707。这里只显示「档期以预约时为准」，
 * 不给一个点了会 404 的按钮。
 */
export default function RentalDetailPage() {
  const router = useRouter()
  const id = router.params.id ?? ''

  const [detail, setDetail] = useState<RentalDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false)
      return
    }
    setLoading(true)
    setFailed(false)
    try {
      const result = await fetchRentalDetail(id)
      setDetail(result)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  const toggleStatus = useCallback(async () => {
    if (!detail || busy) return
    setBusy(true)
    try {
      const next =
        detail.status === 'ACTIVE' ? await offlineRental(detail.id) : await onlineRental(detail.id)
      setDetail(next)
      await Taro.showToast({
        title: next.status === 'ACTIVE' ? '已重新上架' : '已下架',
        icon: 'none',
      })
    } catch {
      await Taro.showToast({ title: '操作失败，请重试', icon: 'none' })
    } finally {
      setBusy(false)
    }
  }, [detail, busy])

  if (loading) {
    return (
      <View className="rd">
        <TopBar variant="glass" spacer back center={<Text className="rd__title">出租详情</Text>} />
        <View className="rd__skeleton" />
      </View>
    )
  }

  if (failed) {
    return (
      <View className="rd">
        <TopBar variant="glass" spacer back center={<Text className="rd__title">出租详情</Text>} />
        <LoadError onRetry={() => void load()} />
      </View>
    )
  }

  if (!detail) {
    return (
      <View className="rd">
        <TopBar variant="glass" spacer back center={<Text className="rd__title">出租详情</Text>} />
        <View className="rd__empty">
          <Text className="rd__empty-title">这件出租不存在或已下架</Text>
          <Text className="rd__empty-hint">看看广场上的其它物品</Text>
        </View>
      </View>
    )
  }

  return (
    <View className="rd">
      <TopBar variant="glass" spacer back center={<Text className="rd__title">出租详情</Text>} />

      {/* —— 图片 —— */}
      <View className="rd__gallery">
        {detail.images.length > 0 ? (
          <Image className="rd__cover" src={detail.images[0]?.url ?? ''} mode="aspectFill" />
        ) : (
          <View className="rd__cover rd__cover--empty">暂无图片</View>
        )}
      </View>

      <View className="rd__body">
        {/* —— 价格与基本信息 —— */}
        <View className="rd__card">
          <Text className="rd__name">{detail.title}</Text>
          <View className="rd__price-row">
            <Text className="rd__price">¥{formatAmount(detail.dailyPriceCents)}</Text>
            <Text className="rd__unit">/天</Text>
          </View>
          <View className="rd__meta">
            <Text className="rd__meta-item">
              {detail.depositCents === 0 ? '免押' : `押金 ¥${formatAmount(detail.depositCents)}`}
            </Text>
            <Text className="rd__meta-item">
              可租 {detail.minDays}–{detail.maxDays} 天
            </Text>
            <Text className="rd__meta-item">{CONDITION_LABEL[detail.condition]}</Text>
          </View>
          {/*
           * REVIEW 与「自己下架」必须分开说：两者在库里的 `status` 都是 OFFLINE，
           * 但对卖家是两件完全不同的事（一个是等审核，一个是他自己按的）。
           * 只有前者不能「重新上架」—— 上架要求 `moderation_status = 'APPROVED'`。
           */}
          {detail.moderationStatus === 'REVIEW' ? (
            <Text className="rd__offline-note">审核中，通过后自动公开</Text>
          ) : detail.status !== 'ACTIVE' ? (
            <Text className="rd__offline-note">当前已下架，其他用户看不到这件出租</Text>
          ) : null}
        </View>

        {/* —— 出租规则（契约要求：位于押金说明**上方**） —— */}
        {detail.rules ? (
          <View className="rd__card">
            <Text className="rd__section-title">出租规则</Text>
            <Text className="rd__desc">{detail.rules}</Text>
          </View>
        ) : null}

        {/* —— 押金说明：常驻、不折叠 —— */}
        <View className="rd__card rd__card--notice">
          <Text className="rd__section-title">押金说明</Text>
          <Text className="rd__notice">{RENTAL_DEPOSIT_NOTICE.full}</Text>
        </View>

        {/* —— 描述 —— */}
        <View className="rd__card">
          <Text className="rd__section-title">物品描述</Text>
          <Text className="rd__desc">{detail.description}</Text>
        </View>

        {/* —— 出租人 —— */}
        <View className="rd__card rd__owner">
          <View className="rd__owner-info">
            <Text className="rd__owner-name">{detail.owner.nickname}</Text>
            {detail.owner.authStatus === 'VERIFIED' ? (
              <Text className="rd__owner-badge">已认证</Text>
            ) : null}
          </View>
        </View>

        {/* 预约入口归 #707：这里如实说明，而不是给一个点了会失败的空按钮。 */}
        <Text className="rd__footnote">档期与预约将在下一版开放，可先联系出租人</Text>
      </View>

      <View className="rd__bar">
        {detail.isOwner ? (
          detail.moderationStatus === 'REVIEW' ? (
            // 审核中不给上下架入口：`POST /online` 要求 APPROVED，按下去必然 409。
            <View className="rd__action rd__action--disabled">审核中，暂不可操作</View>
          ) : (
            <View
              className={`rd__action rd__action--ghost${busy ? ' is-off' : ''}`}
              onClick={busy ? undefined : toggleStatus}
            >
              {detail.status === 'ACTIVE' ? '下架' : '重新上架'}
            </View>
          )
        ) : (
          /*
           * 「联系出租人」需要租赁域的会话通道：`POST /conversations` 在 #705 已被限定为
           * 只服务 SALE（出租会话由租赁域自己建），而那条通道归 #709（聊天系统卡与站内通知）。
           * 在此之前给一个按下去必然 404 的按钮比不给更糟 —— 用户会以为出租人失联。
           * 所以这里如实标注「即将开放」，等 #709 接通后换成真入口。
           */
          <View className="rd__action rd__action--disabled">联系出租人（即将开放）</View>
        )}
      </View>
    </View>
  )
}

const CONDITION_LABEL: Record<RentalDetail['condition'], string> = {
  NEW: '全新',
  LIKE_NEW: '几乎全新',
  GOOD: '成色良好',
  FAIR: '有明显使用痕迹',
}
