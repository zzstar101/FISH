/**
 * 消息页搜索（#669）——**展示层**：搜索栏 + 三段结果。
 *
 * 与 `search.ts` 的分工：这里只画，所有匹配/截断在纯函数层。
 * 三个交互口径来自 Issue #669：
 * 1. 搜索栏在顶部栏**下方、不吸顶**（随内容滚动）——位置由 `index.tsx` 决定，本文件只管长相；
 * 2. 输入即搜，没有「搜索」按钮；
 * 3. 进入搜索模式后最右是 **X**：清空并退出搜索模式回到会话列表。
 */

import { Image, Input, Text, View } from '@tarojs/components'
import { ICONS } from '@/assets/lib-icons'
import UserAvatar from '@/components/user-avatar'
import { formatYuan } from '@/lib/money'
import type { ChatSearchResults, ContactHit, ListingHit, MessageHit } from './search'
import { isEmptyResults } from './search'

/** 占位文案：三段能力一次说清（#669 验收标准） */
export const SEARCH_PLACEHOLDER = '搜索记录/联系人/商品'

interface BarProps {
  value: string
  /** 搜索模式（已点进搜索框）；决定 X 是否出现 */
  active: boolean
  onChange: (value: string) => void
  /** 点进搜索框：进搜索模式并让输入框拿到焦点 */
  onActivate: () => void
  /** X：清空 + 退出搜索模式 */
  onClose: () => void
}

/**
 * 搜索栏。**不是**吸顶的 TopBar 部件：它是内容流里的普通一行，
 * 由 `index.tsx` 插在 `chat__header-gap` 之后（见该页注释）。
 */
export function ChatSearchBar({ value, active, onChange, onActivate, onClose }: BarProps) {
  return (
    <View className={`csearch${active ? ' is-active' : ''}`}>
      <View className="csearch__field" onClick={onActivate}>
        <Image className="csearch__ic" src={ICONS.searchMuted} mode="aspectFit" />
        <Input
          className="csearch__input"
          value={value}
          type="text"
          confirmType="search"
          placeholder={SEARCH_PLACEHOLDER}
          placeholderClass="csearch__ph"
          // 只有进了搜索模式才抢焦点：不点搜索框时不该一进消息页就弹键盘
          focus={active}
          onInput={(event) => onChange(event.detail.value)}
          onConfirm={() => undefined}
        />
      </View>
      {active ? (
        <View className="csearch__close" onClick={onClose}>
          <Image className="csearch__close-ic" src={ICONS.closeFg} mode="aspectFit" />
        </View>
      ) : null}
    </View>
  )
}

interface ResultsProps {
  query: string
  results: ChatSearchResults
  /** 请求在途（含防抖等待）：显示「正在搜索…」而不是「没有找到」 */
  searching: boolean
  /** 全站商品检索失败：只影响商品段，联系人/聊天记录照常显示 */
  marketFailed: boolean
  /** 这次实际扫了几个会话的消息（结果区底注用） */
  scannedConversations: number
  scanLimit: number
  onOpenContact: (hit: ContactHit) => void
  onOpenListing: (hit: ListingHit) => void
  onOpenMessage: (hit: MessageHit) => void
}

/** 命中条目的时间：今天只给时分，更早给月-日（跨年再补年份） */
function hitTimeLabel(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const then = new Date(at)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const sameDay =
    then.getFullYear() === now.getFullYear() &&
    then.getMonth() === now.getMonth() &&
    then.getDate() === now.getDate()
  if (sameDay) return `${pad(then.getHours())}:${pad(then.getMinutes())}`
  if (then.getFullYear() === now.getFullYear())
    return `${then.getMonth() + 1} 月 ${then.getDate()} 日`
  return `${then.getFullYear()}/${then.getMonth() + 1}/${then.getDate()}`
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <View className="csres__head">
      <Text className="csres__head-tx">{label}</Text>
      <Text className="csres__head-n num">{count}</Text>
    </View>
  )
}

/**
 * 三段结果。空态与失败态的分工：
 * - `searching` 优先（还没结果就别说没有）；
 * - 三段全空 → 一句「没有找到」，并说明搜索范围（不让用户以为能搜全站）；
 * - 商品段失败单独一行提示 + 重试（其余两段仍可用）。
 */
export function ChatSearchResultsView({
  query,
  results,
  searching,
  marketFailed,
  scannedConversations,
  scanLimit,
  onOpenContact,
  onOpenListing,
  onOpenMessage,
}: ResultsProps) {
  const empty = isEmptyResults(results)
  return (
    <View className="csres">
      {searching ? (
        <View className="csres__hint">
          <Text className="csres__hint-tx">正在搜索…</Text>
        </View>
      ) : empty ? (
        <View className="csres__hint">
          <Text className="csres__hint-title">没有找到「{query.trim()}」</Text>
          <Text className="csres__hint-tx">
            只搜你聊过的会话（最近 {scanLimit} 个）和全站商品，换个词试试
          </Text>
        </View>
      ) : null}

      {results.contacts.length > 0 ? (
        <>
          <SectionHeader label="联系人" count={results.contacts.length} />
          {results.contacts.map((item) => (
            <View
              key={item.conversationId}
              className="csres__row"
              onClick={() => onOpenContact(item)}
            >
              <UserAvatar className="csres__ava" src={item.avatarUrl} />
              <View className="csres__corp">
                <Text className="csres__nm">{item.nickname}</Text>
                <Text className="csres__sub">在聊「{item.listingTitle}」</Text>
              </View>
              <Image className="csres__arrow" src={ICONS.chevronRightMuted} mode="aspectFit" />
            </View>
          ))}
        </>
      ) : null}

      {results.listings.length > 0 ? (
        <>
          <SectionHeader label="商品" count={results.listings.length} />
          {results.listings.map((item) => (
            <View
              key={`${item.source}-${item.listingId}`}
              className="csres__row"
              onClick={() => onOpenListing(item)}
            >
              {item.coverUrl ? (
                <Image className="csres__cover" src={item.coverUrl} mode="aspectFill" />
              ) : (
                <View className="csres__cover csres__cover--empty">
                  <Image className="csres__cover-ic" src={ICONS.imageMuted} mode="aspectFit" />
                </View>
              )}
              <View className="csres__corp">
                <Text className="csres__nm">{item.title}</Text>
                <Text className="csres__price num">{formatYuan(item.priceCents)}</Text>
              </View>
              <Text className="csres__tag">{item.source === 'conversation' ? '在聊' : '全站'}</Text>
            </View>
          ))}
        </>
      ) : null}

      {results.messages.length > 0 ? (
        <>
          <SectionHeader label="聊天记录" count={results.messages.length} />
          {results.messages.map((item) => (
            <View
              key={`${item.conversationId}-${item.messageId}`}
              className="csres__row"
              onClick={() => onOpenMessage(item)}
            >
              <UserAvatar className="csres__ava" src={item.avatarUrl} />
              <View className="csres__corp">
                <View className="csres__corp-top">
                  <Text className="csres__nm">{item.nickname}</Text>
                  <Text className="csres__tm num">{hitTimeLabel(item.createdAt)}</Text>
                </View>
                <Text className="csres__msg">{item.snippet}</Text>
              </View>
            </View>
          ))}
        </>
      ) : null}

      {marketFailed ? (
        <View className="csres__warn">
          <Text className="csres__warn-tx">商品搜索没连上服务器，只显示了你聊过的东西</Text>
        </View>
      ) : null}

      {/* 如实交代范围：V1 没有全站消息搜索，不写这句会让用户以为「搜不到了」就是没有 */}
      {!searching && !empty ? (
        <View className="csres__foot">
          <Text className="csres__foot-tx">
            {results.messages.length > 0
              ? `聊天记录仅搜索最近 ${scannedConversations} 个会话，点结果进入该会话`
              : `聊天记录只搜了最近 ${scannedConversations} 个会话，没有命中`}
          </Text>
        </View>
      ) : null}
    </View>
  )
}
