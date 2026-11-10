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
import { MESSAGE_PAGE_LIMIT } from '@/features/chat/api'
import { formatYuan } from '@/lib/money'
import type { ChatListState } from './list-view'
import type { ChatSearchResults, ContactHit, ListingHit, MessageHit } from './search'
import {
  describeMessageFooter,
  describeSearchCoverage,
  hasQuery,
  isEmptyResults,
  MAX_CONTACT_HITS,
  MAX_MARKET_HITS,
  MAX_MESSAGE_HITS,
  SEARCH_MAX_QUERY_LENGTH,
} from './search'

/**
 * 每个会话只取最近一页消息 —— 直接用取数层的分页大小，不再抄一份常量：
 * 两处各写一个数字时，改一处漏一处，底注就开始撒谎。
 */
const MESSAGE_SCAN_DEPTH = MESSAGE_PAGE_LIMIT

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
          // 契约里 `q` 上限 50 字（`packages/contracts/src/listings/schema.ts`），
          // 不挡的话粘贴长文会被服务端 422 拒掉，商品段还会报成「没连上服务器」
          maxlength={SEARCH_MAX_QUERY_LENGTH}
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
  /**
   * 会话列表的形态（`chatListState` 的三态 + `list`）。必须整态传进来而不是一个
   * `localFailed` 布尔：`loading`（还没搜到）与 `empty`（确实没有会话）对用户
   * 是两件事，用一个布尔会把后者说成前者。
   */
  listState: ChatListState
  /** 重拉会话列表（本地失败时的出口） */
  onRetryLocal: () => void
  /** 这次实际扫了几个会话的消息（结果区底注用，**不是**常量上限） */
  scannedConversations: number
  /** 扫描时没连上服务器的会话数：也算「没搜到」会给出静默缺失的结果 */
  failedConversations: number
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

function SectionHeader({
  label,
  count,
  truncated,
}: {
  label: string
  count: number
  /** 本条是否被上限截断（段头显示「10+」）——「就这些」和「还有更多」是两回事 */
  truncated: boolean
}) {
  return (
    <View className="csres__head">
      <Text className="csres__head-tx">{label}</Text>
      <Text className="csres__head-n num">
        {count}
        {truncated ? '+' : ''}
      </Text>
    </View>
  )
}

/**
 * 三段结果。四种状态的分工（顺序即优先级）：
 * - `searching`：还在搜（防抖等待也算）—— 不能说「没有」；
 * - **没输入**（`hasQuery` 为假）：只提示能搜什么，绝不出现「没有找到「」」；
 * - 三段全空 → 一句「没有找到」，并如实说明这次搜了哪些范围；
 * - 有结果 → 三段 + 底注交代覆盖范围（含失败/没连上的会话数）。
 *
 * 「会话列表没加载出来」单独一行提示 + 重试：空态会被读成「恰好没有内容」。
 */
export function ChatSearchResultsView({
  query,
  results,
  searching,
  marketFailed,
  listState,
  onRetryLocal,
  scannedConversations,
  failedConversations,
  onOpenContact,
  onOpenListing,
  onOpenMessage,
}: ResultsProps) {
  const empty = isEmptyResults(results)
  const typed = hasQuery(query)
  /** 本地两段这次到底搜没搜得动（`listState === 'error'` 时一段都没搜） */
  const localFailed = listState === 'error'
  /**
   * 空态那句范围说明与结果区底注**共用同一份**（`describeSearchCoverage`）：
   * 分开写时，空态会把「没连上」说成「没有」、结果区又提失败数，同屏两套口径。
   */
  const coverage = describeSearchCoverage({
    listState,
    scanned: scannedConversations,
    failedScans: failedConversations,
    marketFailed,
  })
  /** 只有本地段真的搜过，才谈得上「换个词试试」（失败/加载中时换词也没用） */
  const canRetype = listState === 'list' || listState === 'empty'
  /**
   * 三段各自有上限（联系人 `MAX_CONTACT_HITS`、商品 `MAX_MARKET_HITS`、聊天记录
   * `MAX_MESSAGE_HITS`）。打满时段头那个数字**不是**命中总数 —— 只写「10」会被读成
   * 「一共就这些」，正是验收 5 要禁的那类误导（把「有更多但没显示」说成「不存在」）。
   * 所以打满就把段头写成「10+」，并在结果下方交代「+」是什么意思。
   */
  const contactsTruncated = results.contacts.length >= MAX_CONTACT_HITS
  const listingsTruncated = results.listings.length >= MAX_MARKET_HITS
  const messagesTruncated = results.messages.length >= MAX_MESSAGE_HITS
  const truncated = contactsTruncated || listingsTruncated || messagesTruncated
  return (
    <View className="csres">
      {searching ? (
        <View className="csres__hint">
          <Text className="csres__hint-tx">正在搜索…</Text>
        </View>
      ) : !typed ? (
        <View className="csres__hint">
          <Text className="csres__hint-tx">输入关键词，搜聊天记录、联系人和商品</Text>
        </View>
      ) : empty ? (
        <View className="csres__hint">
          <Text className="csres__hint-title">没有找到「{query.trim()}」</Text>
          <Text className="csres__hint-tx">{canRetype ? `${coverage}，换个词试试` : coverage}</Text>
        </View>
      ) : null}

      {localFailed && !searching ? (
        <View className="csres__warn">
          {/* 已经有结果时不能说「搜不了」—— 那批结果就是刚搜出来的，只是列表刷新失败了 */}
          <Text className="csres__warn-tx">
            {empty
              ? '会话列表没加载出来，联系人和聊天记录搜不了'
              : '会话列表刷新失败，下面是上一次搜索的结果'}
          </Text>
          <Text className="csres__warn-btn" onClick={onRetryLocal}>
            重试
          </Text>
        </View>
      ) : null}

      {!searching && results.contacts.length > 0 ? (
        <>
          <SectionHeader
            label="联系人"
            count={results.contacts.length}
            truncated={contactsTruncated}
          />
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

      {!searching && results.listings.length > 0 ? (
        <>
          <SectionHeader
            label="商品"
            count={results.listings.length}
            truncated={listingsTruncated}
          />
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

      {!searching && results.messages.length > 0 ? (
        <>
          <SectionHeader
            label="聊天记录"
            count={results.messages.length}
            truncated={messagesTruncated}
          />
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

      {/* 段头打满上限时带「+」：说清「还有更多没显示」，别让截断读成「就这些」 */}
      {!searching && truncated ? (
        <View className="csres__more">
          <Text className="csres__more-tx">带「+」的那一段还有更多结果，缩小关键词能看全</Text>
        </View>
      ) : null}

      {!searching && marketFailed ? (
        <View className="csres__warn">
          <Text className="csres__warn-tx">商品搜索没连上服务器，只显示了你聊过的东西</Text>
        </View>
      ) : null}

      {/* 如实交代范围：V1 没有全站消息搜索，不写这句会让用户以为「搜不到」就是没有；
          文案由 `describeMessageFooter` 统一产出（与空态同源），有命中时也照样说失败数 */}
      {!searching && !empty && typed ? (
        <View className="csres__foot">
          <Text className="csres__foot-tx">
            {describeMessageFooter({
              listState,
              scanned: scannedConversations,
              failedScans: failedConversations,
              marketFailed,
              hits: results.messages.length,
              depth: MESSAGE_SCAN_DEPTH,
            })}
          </Text>
        </View>
      ) : null}
    </View>
  )
}
