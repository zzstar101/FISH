import type { ConversationDto } from '@fish/contracts/chat/schema'
import { Image, Input, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { sendListingMessage } from '@/features/chat/api'
import {
  type LoadedListingCandidates,
  loadConversation,
  loadCounterpartListings,
  loadMyListings,
} from '@/features/fetchers'
import { formatAmount } from '@/lib/money'
import { isApiError } from '@/lib/request'
import './index.scss'

type TabKey = 'mine' | 'theirs'

/**
 * 发送商品选择页（#359，三任务并行计划 3a）：会话页「+」→「商品」进入，
 * 把一侧的在售商品作为**商品卡消息**发进会话。
 *
 * - 两侧数据同源「他人主页」的公开在售端点（`GET /users/:id/listings`，只含 ACTIVE），
 *   因此发送侧的服务端校验（在售才可发）与本页展示口径天然一致；
 * - 初始 tab 按 `ConversationDto.role`：我是买家 → 「TA的宝贝」（对面卖家在售）；
 *   我是卖家 → 「我的宝贝」（我在售）；
 * - 点「发送」→ `POST /conversations/:id/messages`（type=LISTING）成功后返回会话页，
 *   新卡片由会话页的 didShow 重拉带入；商品已下架/已售 → 404，行内 toast 说明。
 */
export default function SendListing() {
  const authStatus = useAuthGuard()
  const { user: me } = useAuth()
  const router = useRouter<{ id?: string }>()
  const conversationId = router.params.id ?? ''

  const [conversation, setConversation] = useState<ConversationDto | null>(null)
  const [convState, setConvState] = useState<'loading' | 'ok' | 'missing' | 'failed'>('loading')
  /** 当前 tab：会话加载完成后按 role 初始化（null = 还没定） */
  const [activeTab, setActiveTab] = useState<TabKey | null>(null)
  /** 每侧各自缓存：切过一次再切回不重新拉（双侧列表都很小，不值得为省内存丢体验） */
  const [tabData, setTabData] = useState<{
    mine: LoadedListingCandidates | null
    theirs: LoadedListingCandidates | null
  }>({ mine: null, theirs: null })
  const [tabLoading, setTabLoading] = useState(false)
  const [query, setQuery] = useState('')
  /** 在途发送的商品 id：一行一个在飞锁，防止连点重复发送 */
  const [sendingId, setSendingId] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!conversationId) {
      setConvState('missing')
      return undefined
    }
    setConvState('loading')
    let alive = true
    void loadConversation(conversationId).then((result) => {
      if (!alive) return
      if (result.status === 'ok') {
        setConversation(result.conversation)
        setConvState('ok')
        setActiveTab(result.conversation.role === 'buyer' ? 'theirs' : 'mine')
      } else {
        setConvState(result.status)
      }
    })
    return () => {
      alive = false
    }
  }, [conversationId])

  useEffect(load, [load])

  /** 懒加载当前 tab：缓存未命中才发请求（deps 里 tabData[activeTab] 变化自然停掉重复拉取） */
  useEffect(() => {
    if (convState !== 'ok' || !conversation || !activeTab) return undefined
    if (tabData[activeTab]) {
      // 缓存命中也要清 loading：前一个 tab 的在途请求被 cleanup 跳过后，
      // 不会有人再替它复位，留着会把已缓存的这侧永久挡在「正在加载…」后面
      setTabLoading(false)
      return undefined
    }
    let alive = true
    setTabLoading(true)
    const request =
      activeTab === 'mine'
        ? loadMyListings(me?.id ?? '')
        : loadCounterpartListings(conversation.counterpart.id)
    void request.then((result) => {
      if (!alive) return
      setTabData((prev) => ({ ...prev, [activeTab]: result }))
      setTabLoading(false)
    })
    return () => {
      alive = false
    }
  }, [convState, conversation, activeTab, tabData, me?.id])

  const retryTab = () => {
    if (!activeTab) return
    setTabData((prev) => ({ ...prev, [activeTab]: null }))
  }

  const handleSend = (listingId: string) => {
    if (sendingId || !conversationId) return
    setSendingId(listingId)
    void sendListingMessage(conversationId, listingId)
      .then(() => {
        void Taro.navigateBack()
      })
      .catch((error) => {
        // 404 LISTING_NOT_FOUND：列表拉到之后商品刚好被卖掉/下架（或会话已失效）。
        void Taro.showToast({
          title:
            isApiError(error) && error.code === 'LISTING_NOT_FOUND'
              ? '商品已下架或已售出'
              : '发送失败，请重试',
          icon: 'none',
        })
      })
      .finally(() => {
        setSendingId(null)
      })
  }

  if (authStatus !== 'authed') return <AuthRequired restoring={authStatus === 'unknown'} />

  if (convState !== 'ok' || !conversation) {
    return (
      <View className="sl">
        <TopBar variant="glass" spacer back title="发送" titleEm="商品" />
        <View className="sl__body">
          {convState === 'loading' ? (
            <View className="sl__center">
              <Text className="sl__center-tx">正在加载…</Text>
            </View>
          ) : convState === 'failed' ? (
            <LoadError title="会话加载失败" text="检查网络后重试" onRetry={load} />
          ) : (
            <LoadError title="会话不存在或已结束" text="回消息列表看看其它同学的消息吧" />
          )}
        </View>
      </View>
    )
  }

  const side = activeTab ? tabData[activeTab] : null
  const items = side?.items ?? []
  const keyword = query.trim().toLowerCase()
  const visible = keyword
    ? items.filter((item) => item.title.toLowerCase().includes(keyword))
    : items

  return (
    <View className="sl">
      <TopBar variant="glass" spacer back title="发送" titleEm="商品" />

      {/* 双 tab（我的宝贝 / TA的宝贝）：与消息页/关注页的两档下划线 tab 同一套观感 */}
      <View className="sl__tabs">
        {(['mine', 'theirs'] as const).map((tab) => (
          <View
            key={tab}
            className={`sl__tab${activeTab === tab ? ' is-on' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            <Text>
              {tab === 'mine' ? '我的宝贝' : `${conversation.counterpart.nickname}的宝贝`}
            </Text>
          </View>
        ))}
      </View>

      {/* 按标题过滤（客户端过滤：单侧在售量级小，不值得为它加一次服务端往返） */}
      <View className="sl__search">
        <Image className="sl__search-ic" src={ICONS.search} mode="aspectFit" />
        <Input
          className="sl__search-in"
          placeholder="搜索商品标题"
          placeholderClass="sl__search-ph"
          value={query}
          onInput={(event) => setQuery(event.detail.value)}
        />
      </View>

      <ScrollView className="sl__list" scrollY>
        {side?.failed ? (
          <LoadError title="列表加载失败" text="检查网络后重试" onRetry={retryTab} />
        ) : tabLoading || !side ? (
          <View className="sl__center">
            <Text className="sl__center-tx">正在加载…</Text>
          </View>
        ) : items.length === 0 ? (
          <View className="sl__center">
            <Text className="sl__center-tx">
              {activeTab === 'mine' ? '我还没有在售商品' : 'TA 暂无在售商品'}
            </Text>
          </View>
        ) : visible.length === 0 ? (
          <View className="sl__center">
            <Text className="sl__center-tx">没有匹配「{query.trim()}」的商品</Text>
          </View>
        ) : (
          visible.map((item) => (
            <View key={item.id} className="sl__row">
              <Image className="sl__row-cover" src={item.coverUrl} mode="aspectFill" />
              <View className="sl__row-main">
                <Text className="sl__row-title">{item.title}</Text>
                <Text className="sl__row-price num">
                  {item.free ? '免费送' : `¥${formatAmount(item.priceCents)}`}
                </Text>
              </View>
              <View
                className={`sl__row-send${sendingId === item.id ? ' is-busy' : ''}`}
                onClick={() => handleSend(item.id)}
              >
                <Text>{sendingId === item.id ? '发送中…' : '发送'}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  )
}
