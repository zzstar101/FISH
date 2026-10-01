import type { ConversationDto } from '@fish/contracts/chat/schema'
import { Image, Input, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { randomUuidV4 } from '@/lib/uuid'
import { sendFailureText, sendKeyFor, shouldDropSendKey } from './view'
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
 *   新卡片由会话页的 didShow 重拉带入；商品已下架/已售 → 404，行内 toast 说明；
 * - 每次发送带 `clientRequestId`（#359 3a 审查回合）：同一件商品的重试复用同一个键，
 *   服务端据此重放既有那条而不是落第二条（`./view` 的 `sendKeyFor`）。
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
  /**
   * 每件商品这一次发送的幂等键（发出时生成、失败保持、成功丢弃）。
   *
   * 放 ref 不放 state：它不参与渲染，且必须在同一次点击与随后重试之间**稳定**
   * （`setState` 在闭包里读到的是旧值）。
   */
  const sendKeysRef = useRef(new Map<string, string>())

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
    const key = sendKeyFor(sendKeysRef.current, listingId, randomUuidV4)
    setSendingId(listingId)
    void sendListingMessage(conversationId, listingId, key)
      .then(() => {
        // 成功才丢弃键：这条发送已经落定，下一次点击是另一次新发送。
        sendKeysRef.current.delete(listingId)
        // 回会话页；本页被深链/预览直接打开时栈里没有上一页，回消息列表而不是卡住。
        const pages = Taro.getCurrentPages()
        if (pages.length > 1) void Taro.navigateBack()
        else void Taro.switchTab({ url: '/pages/chat/index' })
      })
      .catch((error) => {
        const code = isApiError(error) ? error.code : null
        // 同键换了内容（服务端指纹不一致）→ 作废旧键，否则下一次点击还会撞 409。
        if (shouldDropSendKey(code)) sendKeysRef.current.delete(listingId)
        void Taro.showToast({ title: sendFailureText(code), icon: 'none' })
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
            {/*
              服务端还有下一页时必须点明「只在已加载的这 N 件里没有匹配」（#359 3a 审查回合）：
              客户端只过滤已加载的那一页，说成「没有匹配」会把「在第 2 页」误报成「不存在」。
            */}
            <Text className="sl__center-tx">
              {side?.hasMore
                ? `前 ${items.length} 件里没有匹配「${query.trim()}」的商品`
                : `没有匹配「${query.trim()}」的商品`}
            </Text>
          </View>
        ) : (
          <>
            {visible.map((item) => (
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
            ))}
            {/*
              服务端还有下一页时如实说明：本页不做无限滚动（单侧在售量级小），
              沉默地截断会让人以为「就这么多」——他人主页为同一件事抽了 list-end 文案。
            */}
            {side?.hasMore ? (
              <View className="sl__center">
                <Text className="sl__center-tx">{`只展示了前 ${items.length} 件在售商品`}</Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  )
}
