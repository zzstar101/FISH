import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useLoad, useRouter } from '@tarojs/taro'
import { useMemo, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import NavBar from '@/components/nav-bar'
import { useAuthGuard } from '@/features/auth/guard'
import {
  fetchWatchers,
  findListing,
  formatAmount,
  type MockWatcher,
  WATCHER_DEFAULT_LISTING,
  watchersSummary,
} from '@/mock/api'
import './index.scss'

/**
 * C5 想要的人（设计稿 `设计稿_C5-watchers.html`）。
 *
 * 页头：商品摘要条（「这是谁的想要的人」）+ 双格统计（共 N 人想要 / 预算中位）
 * + 中位数口径说明；列表：头像 + 昵称 + 认证徽章 + 院系 + 预算 + 想要时间 + 动作；
 * 末尾是隐私说明条。
 *
 * **预算中位数的口径**（稿子原文：「中位数按已填预算的 12 人计算 · 6 人未填预算不计入」）：
 * 只对**填了预算**的人求中位数，未填的人不计入分母也不参与排序。
 * 一个人都没填时中位数返回 null，页面显示「暂缺」——这不是错误态，是正常结果。
 *
 * **四种行状态**（稿子第 02 帧，本页四种各有一条 fixture）：
 * 1. 已聊过 → 动作换成「继续聊」（`chattedCount > 0`）；
 * 2. 超长昵称 → 单行截断，不换行、不挤压徽章（`.wt__name` 有 `min-width: 0`）；
 * 3. 未公开院系 → 显示「未公开校区」（`department === null`）；
 * 4. 已注销 → 整行降级为冰底灰字 + 动作不可用 + 「对方已注销，无法再发起会话」。
 *
 * **与后端的边界**：契约没有「谁想要我的商品」端点（P1），整页 mock，标 `BLOCKED: 需新 Issue`。
 */

export default function Watchers() {
  const authStatus = useAuthGuard()
  const router = useRouter<{ listingId?: string; title?: string }>()
  const listingId = router.params.listingId ?? WATCHER_DEFAULT_LISTING

  const [items, setItems] = useState<MockWatcher[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  /** 已发起过会话的人 → 动作换成「继续聊」（按 watcher.id 记） */
  const [started, setStarted] = useState<Record<string, boolean>>({})

  const summary = watchersSummary(listingId)
  const listing = findListing(listingId)

  const load = async () => {
    setLoading(true)
    setFailed(false)
    setItems(await fetchWatchers(listingId))
    setLoading(false)
  }

  useLoad(() => {
    void load()
  })

  /**
   * 统计口径的说明文案。
   *
   * 三种情况分开写，是因为它们对用户的含义不同：没有预算中位不是「加载失败」，
   * 而「有人填了预算」与「一个人都没填」要给出不同的解释。
   */
  const statNote = useMemo(() => {
    if (summary.count === 0) return '还没有人填预算，暂时算不出中位数'
    if (summary.medianCents === null) return '想要的人都未填预算，暂时算不出中位数'
    const missing = summary.count - summary.budgetFilled
    return missing > 0
      ? `中位数按已填预算的 ${summary.budgetFilled} 人计算 · ${missing} 人未填预算不计入`
      : `中位数按已填预算的 ${summary.budgetFilled} 人计算`
  }, [summary])

  const chat = (item: MockWatcher) => {
    if (item.deactivated) return
    if (item.chattedCount > 0 && !started[item.id]) {
      // 已经聊过的：真实实现里直接进那条已有会话
      void Taro.showToast({ title: '会话待接入', icon: 'none' })
      return
    }
    if (started[item.id]) {
      void Taro.switchTab({ url: '/pages/chat/index' })
      return
    }
    setStarted((prev) => ({ ...prev, [item.id]: true }))
    void Taro.showToast({ title: '发起会话待接入', icon: 'none' })
  }

  const openListing = () => {
    if (!listing) return
    void Taro.navigateTo({ url: `/pages/listing-detail/index?id=${listing.id}` })
  }

  const share = () => {
    void Taro.showToast({ title: '分享待接入', icon: 'none' })
  }

  const reprice = () => {
    if (!listing) return
    void Taro.navigateTo({ url: `/pages/sell/index?id=${listing.id}` })
  }

  /** 商品摘要条的副行：价格 · 状态 · 上架天数（稿子第 01 帧的 `¥320 · 在售 · 已上架 6 天`） */
  const listingMeta = listing
    ? `¥${formatAmount(listing.priceCents)} · ${listing.status === 'ACTIVE' ? '在售' : '已下架'} · 已上架 ${Math.floor(listing.createdHoursAgo / 24)} 天`
    : ''

  /**
   * 未登录 / 登录态未就绪：守卫在跳转，这里同时**拦住渲染**。
   * 本页数据源全是 `@/mock/api`（同步可得），不拦的话跳转落地前会先画一帧演示账号的数据。
   */
  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />
  return (
    <View className="wt">
      <View className="wt__bg" />

      <NavBar />

      <View className="wt__head">
        <Text className="wt__kicker num">我的发布 · 想要的人</Text>
        <Text className="wt__title">想要的人</Text>

        {listing ? (
          <View className="wt__lchip" onClick={openListing}>
            <View className="wt__lthumb">
              <Image className="wt__lthumb-img" src={listing.coverUrl} mode="aspectFill" />
            </View>
            <View className="wt__lmain">
              <Text className="wt__ltitle">{listing.title}</Text>
              <Text className="wt__lmeta num">{listingMeta}</Text>
            </View>
          </View>
        ) : (
          <Text className="wt__lmeta num">{router.params.title ?? '商品已下架'}</Text>
        )}

        <View className="wt__stats">
          <View className="wt__stat">
            <Text className="wt__stat-num num">
              {loading ? '—' : summary.count}
              {loading ? null : <Text className="wt__stat-unit">人</Text>}
            </Text>
            <Text className="wt__stat-label">共有人想要</Text>
          </View>
          <View className={`wt__stat${summary.medianCents === null ? ' is-na' : ''}`}>
            <Text className="wt__stat-num num">
              {loading
                ? '—'
                : summary.medianCents === null
                  ? '暂缺'
                  : `¥${formatAmount(summary.medianCents)}`}
            </Text>
            <Text className="wt__stat-label">预算中位</Text>
          </View>
        </View>
        <Text className="wt__stat-note num">{loading ? '正在读取统计…' : statNote}</Text>
      </View>

      {/* 加载失败：给出口，不让用户卡在空白页（稿子第 04 帧的对照 A） */}
      {failed ? (
        <View className="wt__fail">
          <View className="wt__fail-ic">
            <Image className="wt__fail-img" src={ICONS.warnInk} mode="aspectFit" />
          </View>
          <View className="wt__fail-main">
            <Text className="wt__fail-title">想要的人列表加载失败，请检查网络后重试</Text>
            <Text className="wt__fail-code num">ERR_NETWORK</Text>
            <View className="wt__fail-act" onClick={() => void load()}>
              <Text>重新加载</Text>
            </View>
          </View>
        </View>
      ) : null}

      <View className="wt__sec">
        <Text className="wt__sec-title">全部想要的人</Text>
        <Text className="wt__sec-cnt num">
          {loading ? '加载中' : `${summary.count} 人 · 按想要时间倒序`}
        </Text>
      </View>

      {loading ? (
        <View className="wt__list">
          {[0, 1, 2].map((i) => (
            <View key={`sk-${i}`} className="wt__skel">
              <View className="wt__skel-av" />
              <View className="wt__skel-col">
                <View className="wt__skel-bar" style={{ width: '38%' }} />
                <View className="wt__skel-bar" style={{ width: '62%' }} />
              </View>
              <View className="wt__skel-act" />
            </View>
          ))}
        </View>
      ) : summary.count === 0 ? (
        <View className="wt__empty">
          <View className="wt__empty-disc">
            <Image className="wt__empty-ic" src={ICONS.starAccent} mode="aspectFit" />
          </View>
          <Text className="wt__empty-title">还没有人想要</Text>
          <Text className="wt__empty-text">
            把它分享到许愿墙或班级群，同学点「想要」后就会出现在这里
          </Text>
          <View className="wt__empty-acts">
            <View className="wt__eact wt__eact--primary" onClick={share}>
              <Text>去分享</Text>
            </View>
            <View className="wt__eact" onClick={reprice}>
              <Text>改价格</Text>
            </View>
          </View>
        </View>
      ) : (
        <ScrollView className="wt__scroll" scrollY>
          <View className="wt__list">
            {items.map((item) => {
              const dead = item.deactivated
              const busy = item.chattedCount > 0
              const on = started[item.id]
              return (
                <View key={item.id} className={`wt__row${dead ? ' is-dead' : ''}`}>
                  <View className="wt__av">
                    {dead || !item.avatarUrl ? (
                      <Text className="wt__av-tx">—</Text>
                    ) : (
                      <Image className="wt__av-img" src={item.avatarUrl} mode="aspectFill" />
                    )}
                  </View>

                  <View className="wt__main">
                    <View className="wt__top">
                      <Text className="wt__name">{dead ? '已注销用户' : item.nickname}</Text>

                      {/* 认证徽章：未认证时整块不渲染，改渲染「未认证」小标签 */}
                      {dead ? (
                        <Text className="wt__tag wt__tag--unv">不可联系</Text>
                      ) : item.authStatus === 'VERIFIED' ? (
                        <View className="wt__badge">
                          <Image
                            className="wt__badge-ic"
                            src={ICONS.verifiedAccent}
                            mode="aspectFit"
                          />
                          <Text>已认证</Text>
                        </View>
                      ) : (
                        <Text className="wt__tag wt__tag--unv">未认证</Text>
                      )}

                      {/* 已聊过：次数不同给不同标签（3 条以上用中性灰，1 次用成功色） */}
                      {busy ? (
                        <Text
                          className={`wt__tag ${item.chattedCount > 1 ? 'wt__tag--chat' : 'wt__tag--ok'}`}
                        >
                          {item.chattedCount > 1 ? `已聊 ${item.chattedCount} 条` : '已聊过 1 次'}
                        </Text>
                      ) : null}
                    </View>

                    <Text className="wt__meta num">
                      {dead
                        ? `账号已注销 · 预算 ¥${formatAmount(item.budgetCents ?? 0)} · ${item.timeLabel}`
                        : `${item.department ?? '未公开校区'} · ${
                            item.budgetCents === null
                              ? '未填预算'
                              : `预算 ¥${formatAmount(item.budgetCents)}`
                          } · ${item.timeLabel}`}
                    </Text>

                    {dead ? (
                      <Text className="wt__dead-note">对方已注销，无法再发起会话</Text>
                    ) : null}
                  </View>

                  <View
                    className={`wt__act${dead ? ' is-dead' : busy || on ? ' is-ghost' : ''}`}
                    onClick={() => chat(item)}
                  >
                    <Text>{dead ? '聊一聊' : busy || on ? '继续聊' : '聊一聊'}</Text>
                  </View>
                </View>
              )
            })}
          </View>

          <View className="wt__banner">
            <Image className="wt__banner-ic" src={ICONS.info} mode="aspectFit" />
            <Text className="wt__banner-tx">
              只展示对方愿意公开的信息：昵称、认证徽章、校区与预算。对方隐藏校区或未填预算时按「未公开
              / 未填」显示。
            </Text>
          </View>

          {summary.count > 0 ? (
            <View className="wt__tail">
              <View className="wt__tail-line" />
              <Text className="wt__tail-tx num">{`已显示全部 ${summary.count} 人`}</Text>
              <View className="wt__tail-line" />
            </View>
          ) : null}
        </ScrollView>
      )}
    </View>
  )
}
