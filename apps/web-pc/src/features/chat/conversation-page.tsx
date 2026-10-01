import type { MediaMessageDto, MessageDto } from '@fish/contracts/chat/schema'
import { MEDIA_MAX_VOICE_DURATION_MS } from '@fish/contracts/chat/schema'
import type { ListingStatus } from '@fish/contracts/listings/schema'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Textarea } from '@fish/ui/textarea'
import { UserAvatar } from '@fish/ui/user-avatar'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ImagePlus, Mic, Send, Square } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ListingThumb } from '../../components/listing-thumb'
import { PriceText } from '../../components/price-text'
import { useAuth } from '../auth/auth-provider'
import { presignMediaUpload } from './api'
import {
  describeImageDimensionRejection,
  describeMediaFileRejection,
  describeVoiceDurationRejection,
  IMAGE_FILE_ACCEPT,
  type MediaUploadDraft,
  probeImageSize,
  resolveMediaContentType,
  startVoiceRecording,
  type VoiceRecorder,
} from './media'
import {
  MediaBubble,
  MessageBubble,
  PendingMediaBubble,
  PendingMessageBubble,
} from './message-bubble'
import {
  createMediaOutboxMessage,
  createOutboxMessage,
  dispatchMediaOutboxSend,
  dispatchOutboxSend,
  type OutboxMessage,
  removeOutboxMessage,
  resetOutboxForRetry,
} from './outbox'
import {
  applyReadEventToCache,
  flattenMediaPages,
  flattenMessagePages,
  insertMediaIntoCache,
  insertMessageIntoCache,
  invalidateConversationSurfaces,
  isMessageRead,
  mergeMediaIntoCache,
  mergeMessagesIntoCache,
  probeChatSession,
  refreshConversationOnReconnect,
  useConversation,
  useMarkConversationRead,
  useMediaHistory,
  useMessageHistory,
  useSendMediaMessage,
  useSendTextMessage,
} from './queries'
import { INITIAL_READ_RECEIPT_STATE, onIncomingMessage, resolveReadReceipt } from './read-receipt'
import { type ChatRealtimeStatus, useChatRealtime } from './realtime'
import { buildTimeline, excludeCachedMedia, excludeCachedMessages } from './view'

/** 服务端硬上限 60s；提前 5s 自动收尾，避免录到一半被 422 拒掉。 */
const VOICE_AUTO_STOP_MS = MEDIA_MAX_VOICE_DURATION_MS - 5_000

/** 媒体 DTO 没有 sender 摘要，读位只按 createdAt 与对方读位比较（与文本同一口径）。 */
function isMediaRead(media: MediaMessageDto, counterpartLastReadAt: string | null): boolean {
  if (counterpartLastReadAt === null) return false
  return Date.parse(media.createdAt) <= Date.parse(counterpartLastReadAt)
}

const STATUS_LABEL: Record<ListingStatus, string> = {
  ACTIVE: '在售',
  RESERVED: '已预定',
  SOLD: '已售出',
  OFFLINE: '已下架',
}

function RealtimeStatus({ status }: { status: ChatRealtimeStatus }) {
  if (status === 'open') {
    return (
      <span className="inline-flex items-center gap-1.5 text-success text-xs">
        <span className="size-1.5 rounded-full bg-success" />
        实时连接正常
      </span>
    )
  }
  if (status === 'reconnecting') {
    return (
      <span className="inline-flex items-center gap-1.5 text-warn text-xs">
        <span className="size-1.5 rounded-full bg-warn" />
        连接已断开，正在重连…
      </span>
    )
  }
  return null
}

export function ConversationPage({ conversationId }: { conversationId: string }) {
  const { me } = useAuth()
  const ownerId = me?.id ?? null
  const queryClient = useQueryClient()
  const conversation = useConversation(ownerId, conversationId)
  const history = useMessageHistory(ownerId, conversationId)
  const mediaHistory = useMediaHistory(ownerId, conversationId)
  const markRead = useMarkConversationRead(ownerId)
  const sendMessage = useSendTextMessage(ownerId)
  const sendMedia = useSendMediaMessage(ownerId)
  const [draft, setDraft] = useState('')
  const [outbox, setOutbox] = useState<OutboxMessage[]>([])
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [voiceStarting, setVoiceStarting] = useState(false)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [localMessages, setLocalMessages] = useState<MessageDto[]>([])
  const [localMedia, setLocalMedia] = useState<MediaMessageDto[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const recorderRef = useRef<VoiceRecorder | null>(null)
  const recordStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mediaPreviewUrlsRef = useRef(new Map<string, string>())
  const mountedRef = useRef(true)
  const markReadRef = useRef(markRead)
  markReadRef.current = markRead
  const sendRef = useRef(sendMessage)
  sendRef.current = sendMessage
  const sendMediaRef = useRef(sendMedia)
  sendMediaRef.current = sendMedia
  const historyErrorRef = useRef(false)
  const mediaHistoryErrorRef = useRef(false)
  const recoveryGenerationRef = useRef(0)
  historyErrorRef.current = history.isError
  mediaHistoryErrorRef.current = mediaHistory.isError
  const readReceiptRef = useRef(INITIAL_READ_RECEIPT_STATE)
  const liveRef = useRef<{
    conversationId: string
    messages: Map<string, MessageDto>
    media: Map<string, MediaMessageDto>
  }>({ conversationId, messages: new Map(), media: new Map() })
  if (liveRef.current.conversationId !== conversationId) {
    liveRef.current = { conversationId, messages: new Map(), media: new Map() }
    readReceiptRef.current = INITIAL_READ_RECEIPT_STATE
  }
  const mergeLiveRef = useRef<() => void>(() => {})
  mergeLiveRef.current = () => {
    if (ownerId === null) return
    mergeMessagesIntoCache(queryClient, ownerId, conversationId, [
      ...liveRef.current.messages.values(),
    ])
    mergeMediaIntoCache(queryClient, ownerId, conversationId, [...liveRef.current.media.values()])
  }
  useEffect(() => {
    if (history.isFetching || history.isError) return
    mergeLiveRef.current()
    setLocalMessages([])
  }, [history.isFetching, history.isError])
  useEffect(() => {
    if (mediaHistory.isFetching || mediaHistory.isError) return
    mergeLiveRef.current()
    setLocalMedia([])
  }, [mediaHistory.isFetching, mediaHistory.isError])

  // 本地预览用的 object URL 只属于 outbox：条目离场后（effect 在提交之后跑）再 revoke，
  // 避免气泡还在 DOM 里时被回收。
  useEffect(() => {
    const registry = mediaPreviewUrlsRef.current
    for (const item of outbox) {
      if (item.kind === 'MEDIA' && !registry.has(item.clientRequestId)) {
        registry.set(item.clientRequestId, item.previewUrl)
      }
    }
    for (const [clientRequestId, url] of registry) {
      if (!outbox.some((item) => item.clientRequestId === clientRequestId)) {
        URL.revokeObjectURL(url)
        registry.delete(clientRequestId)
      }
    }
  }, [outbox])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(
    () => () => {
      if (recordStopTimerRef.current !== null) clearTimeout(recordStopTimerRef.current)
      recorderRef.current?.cancel()
      recorderRef.current = null
      for (const url of mediaPreviewUrlsRef.current.values()) URL.revokeObjectURL(url)
      mediaPreviewUrlsRef.current.clear()
    },
    [],
  )

  const messages = useMemo(() => flattenMessagePages(history.data), [history.data])
  const mediaMessages = useMemo(() => flattenMediaPages(mediaHistory.data), [mediaHistory.data])
  const visibleLocalMessages = useMemo(
    () => excludeCachedMessages(localMessages, messages),
    [localMessages, messages],
  )
  const visibleLocalMedia = useMemo(
    () => excludeCachedMedia(localMedia, mediaMessages),
    [localMedia, mediaMessages],
  )
  // 文本与媒体来自两个端点 / 两条实时通道，渲染前必须按 (createdAt, id) 归并成一条时间线。
  const timeline = useMemo(
    () =>
      buildTimeline(
        [...messages, ...visibleLocalMessages],
        [...mediaMessages, ...visibleLocalMedia],
      ),
    [messages, visibleLocalMessages, mediaMessages, visibleLocalMedia],
  )
  const hasOlderPages = history.hasNextPage || mediaHistory.hasNextPage
  const counterpartLastReadAt = conversation.data?.counterpartLastReadAt ?? null

  const realtimeStatus = useChatRealtime(ownerId, {
    onEvent: (event) => {
      if (ownerId === null) return
      if (event.type === 'message.new') {
        if (event.conversationId === conversationId) {
          rememberMessage(event.message)
          if (event.message.senderId !== ownerId) {
            const receipt = onIncomingMessage(document.visibilityState)
            readReceiptRef.current = receipt.state
            if (receipt.markRead) markReadRef.current.mutate(conversationId)
          }
        }
        invalidateConversationSurfaces(queryClient, ownerId)
        return
      }
      if (event.type === 'media.new') {
        if (event.conversationId === conversationId) {
          rememberMedia(event.media)
          if (event.media.senderId !== ownerId) {
            markReadRef.current.mutate(conversationId)
          }
        }
        invalidateConversationSurfaces(queryClient, ownerId)
        return
      }
      if (event.type === 'conversation.read') {
        applyReadEventToCache(queryClient, ownerId, event)
        invalidateConversationSurfaces(queryClient, ownerId)
      }
    },
    onOpen: () => {
      if (ownerId === null) return
      recoverAfterReconnect()
      invalidateConversationSurfaces(queryClient, ownerId)
    },
    onDisconnected: () => {
      if (ownerId === null) return
      probeChatSession(queryClient, ownerId)
    },
  })

  useEffect(() => {
    const current = conversation.data
    if (ownerId === null || current === undefined || current === null) return

    const applyReadReceipt = () => {
      const receipt = resolveReadReceipt(
        readReceiptRef.current,
        document.visibilityState,
        current.unreadCount > 0,
      )
      readReceiptRef.current = receipt.state
      if (receipt.markRead) markReadRef.current.mutate(conversationId)
    }

    applyReadReceipt()
    document.addEventListener('visibilitychange', applyReadReceipt)
    return () => document.removeEventListener('visibilitychange', applyReadReceipt)
  }, [conversation.data, conversationId, ownerId])

  const lastTimelineId = timeline.at(-1)?.id ?? null
  const scrollSignal = `${conversationId}:${lastTimelineId ?? ''}:${outbox.length}`
  useEffect(() => {
    const node = scrollRef.current
    if (node === null || scrollSignal.length === 0) return
    node.scrollTop = node.scrollHeight
  }, [scrollSignal])

  function rememberMessage(message: MessageDto) {
    if (ownerId === null) return
    liveRef.current.messages.set(message.id, message)
    // 历史 query 处于错误态时不能写伪页，否则会把可重试的 error 改成 success；
    // 消息留在 liveRef，等用户/重连把历史拉成功后再合并。
    if (historyErrorRef.current) {
      if (messages.some((item) => item.id === message.id)) return
      setLocalMessages((current) =>
        current.some((item) => item.id === message.id) ? current : [...current, message],
      )
      return
    }
    insertMessageIntoCache(queryClient, ownerId, conversationId, message)
  }

  function rememberMedia(media: MediaMessageDto) {
    if (ownerId === null) return
    liveRef.current.media.set(media.id, media)
    // 与文本同一理由：历史处于错误态时不能写伪页，媒体留在 liveRef 等补拉成功再合并。
    if (mediaHistoryErrorRef.current) {
      if (mediaMessages.some((item) => item.id === media.id)) return
      setLocalMedia((current) =>
        current.some((item) => item.id === media.id) ? current : [...current, media],
      )
      return
    }
    insertMediaIntoCache(queryClient, ownerId, conversationId, media)
  }

  function recoverAfterReconnect() {
    if (ownerId === null) return
    const generation = recoveryGenerationRef.current + 1
    recoveryGenerationRef.current = generation
    setRecoveryError(null)
    void refreshConversationOnReconnect(queryClient, ownerId, conversationId)
      .then(() => {
        if (recoveryGenerationRef.current !== generation) return
        mergeLiveRef.current()
      })
      .catch(() => {
        if (recoveryGenerationRef.current !== generation) return
        setRecoveryError('断线后的历史补拉失败，请重试')
      })
  }

  function dispatch(item: OutboxMessage) {
    if (ownerId === null) return
    if (item.kind === 'MEDIA') {
      void dispatchMediaOutboxSend({
        item,
        conversationId,
        mutation: sendMediaRef.current,
        presign: presignMediaUpload,
        setOutbox,
        onSent: rememberMedia,
      })
      return
    }
    void dispatchOutboxSend({
      item,
      conversationId,
      mutation: sendRef.current,
      setOutbox,
      onSent: rememberMessage,
    })
  }

  function dismissOutbox(clientRequestId: string) {
    setOutbox((current) => removeOutboxMessage(current, clientRequestId))
  }

  // 按钮、Enter、重试同一套规则：允许排队连发，每条各自结算（见 dispatchOutboxSend），
  // 不再用 mutation.isPending 只锁住发送按钮。
  function submit() {
    const content = draft.trim()
    if (ownerId === null || content.length === 0 || content.length > 2000) return
    const item = createOutboxMessage(content)
    setOutbox((current) => [...current, item])
    setDraft('')
    dispatch(item)
  }

  function retry(item: OutboxMessage) {
    setOutbox((current) => resetOutboxForRetry(current, item.clientRequestId))
    dispatch(item)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  function enqueueMedia(draft: MediaUploadDraft, previewUrl: string) {
    const item = createMediaOutboxMessage(draft, previewUrl)
    setOutbox((current) => [...current, item])
    dispatch(item)
  }

  /** 选图：客户端初筛（mime/体积/尺寸）不过就不进 outbox，直接给可读反馈。 */
  async function pickImageFile(file: File) {
    const fileError = describeMediaFileRejection('IMAGE', file)
    if (fileError !== null) {
      setMediaError(fileError)
      return
    }
    // 与服务端同一份 MIME 口径（浏览器不给 MIME 时按扩展名回退）。
    const contentType = resolveMediaContentType('IMAGE', file)
    const size = contentType === null ? null : await probeImageSize(file, contentType)
    if (size === null) {
      setMediaError('无法读取图片尺寸，请换一张')
      return
    }
    const dimensionError = describeImageDimensionRejection(size.width, size.height)
    if (dimensionError !== null) {
      setMediaError(dimensionError)
      return
    }
    setMediaError(null)
    enqueueMedia(
      { kind: 'IMAGE', file, width: size.width, height: size.height },
      URL.createObjectURL(file),
    )
  }

  async function toggleRecording() {
    // 授权弹窗期间按钮还在，再点一次会开出第二条录音；用 voiceStarting 挡掉。
    if (voiceStarting) return
    if (recording) {
      await finishRecording()
      return
    }
    setVoiceStarting(true)
    try {
      const recorder = await startVoiceRecording()
      // 授权/初始化期间可能已切会话（会话页按账号+会话 id 重挂载）：立即释放，别留下常亮麦克风。
      if (!mountedRef.current) {
        recorder.cancel()
        return
      }
      recorderRef.current = recorder
      setRecording(true)
      setMediaError(null)
      recordStopTimerRef.current = setTimeout(() => void finishRecording(), VOICE_AUTO_STOP_MS)
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : '无法开始录音，请检查麦克风权限')
    } finally {
      setVoiceStarting(false)
    }
  }

  async function finishRecording() {
    if (recordStopTimerRef.current !== null) {
      clearTimeout(recordStopTimerRef.current)
      recordStopTimerRef.current = null
    }
    const recorder = recorderRef.current
    recorderRef.current = null
    setRecording(false)
    if (recorder === null) return
    try {
      const { file, durationMs } = await recorder.stop()
      const rejected =
        describeMediaFileRejection('VOICE', file) ?? describeVoiceDurationRejection(durationMs)
      if (rejected !== null) {
        setMediaError(rejected)
        return
      }
      setMediaError(null)
      enqueueMedia({ kind: 'VOICE', file, durationMs }, URL.createObjectURL(file))
    } catch {
      setMediaError('录音失败，请重试')
    }
  }

  function loadOlderPages() {
    if (history.hasNextPage) void history.fetchNextPage()
    if (mediaHistory.hasNextPage) void mediaHistory.fetchNextPage()
  }

  if (conversation.isPending) return <LoadingState label="正在加载会话…" />

  if (conversation.isError) {
    return <ErrorState message="会话加载失败" onRetry={() => void conversation.refetch()} />
  }

  if (conversation.data === null) {
    return (
      <EmptyState
        action={
          <Button asChild variant="outline">
            <Link to="/messages">返回消息列表</Link>
          </Button>
        }
        description="可能已被删除，或者当前账号无权查看"
        emoji="💬"
        title="会话不存在或不可访问"
      />
    )
  }

  const item = conversation.data

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            aria-label="返回消息列表"
            className="grid size-9 place-items-center rounded-lg border border-line bg-surface text-ink-2 transition-colors hover:text-brand"
            to="/messages"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div>
            <h1 className="font-semibold text-[24px] tracking-[-0.03em]">
              {item.counterpart.nickname}
            </h1>
            <p className="mt-0.5 text-ink-3 text-xs">
              {item.role === 'buyer' ? '我是买家' : '我是卖家'}
            </p>
          </div>
        </div>
        <RealtimeStatus status={realtimeStatus} />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_320px] items-start gap-5">
        <Card className="gap-0 border border-line p-0">
          <div className="flex h-[calc(100dvh-230px)] min-h-[520px] flex-col">
            <div className="border-line border-b px-5 py-4">
              <Link
                className="flex items-center gap-3 rounded-xl p-1.5 transition-colors hover:bg-surface-2"
                params={{ listingId: item.listing.id }}
                to="/listing/$listingId"
              >
                <ListingThumb
                  alt={item.listing.title}
                  className="size-12 rounded-lg"
                  coverUrl={item.listing.coverUrl}
                  listingId={item.listing.id}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">{item.listing.title}</p>
                  <p className="mt-0.5 text-ink-3 text-xs">
                    {STATUS_LABEL[item.listing.status]} · 点击查看商品
                  </p>
                </div>
                <PriceText
                  cents={item.listing.priceCents}
                  className="shrink-0 font-bold text-base"
                />
              </Link>
            </div>

            {recoveryError !== null ? (
              <div className="flex items-center justify-between gap-3 border-line border-b bg-warn-soft px-5 py-2 text-warn text-xs">
                <span>{recoveryError}</span>
                <button
                  className="font-medium hover:underline"
                  onClick={recoverAfterReconnect}
                  type="button"
                >
                  重试
                </button>
              </div>
            ) : null}

            <div className="flex-1 overflow-y-auto bg-surface-2/40 px-5 py-4" ref={scrollRef}>
              {history.isPending ? <LoadingState label="正在加载历史消息…" /> : null}
              {history.isError && !history.isFetchNextPageError ? (
                <ErrorState message="历史消息加载失败" onRetry={() => void history.refetch()} />
              ) : null}
              {history.isFetchNextPageError ? (
                <div className="mb-4">
                  <ErrorState
                    message="更早消息加载失败"
                    onRetry={() => void history.fetchNextPage()}
                  />
                </div>
              ) : null}
              {mediaHistory.isError ? (
                <div className="mb-4">
                  <ErrorState
                    message="媒体消息加载失败"
                    onRetry={() => void mediaHistory.refetch()}
                  />
                </div>
              ) : null}
              {hasOlderPages ? (
                <div className="mb-4 flex justify-center">
                  <Button
                    disabled={history.isFetchingNextPage || mediaHistory.isFetchingNextPage}
                    onClick={loadOlderPages}
                    size="sm"
                    variant="outline"
                  >
                    {history.isFetchingNextPage || mediaHistory.isFetchingNextPage
                      ? '正在加载…'
                      : '加载更早消息'}
                  </Button>
                </div>
              ) : null}
              {history.isSuccess && mediaHistory.isSuccess && timeline.length === 0 ? (
                <p className="py-10 text-center text-ink-3 text-sm">还没有消息，发一条打个招呼吧</p>
              ) : null}
              <div className="space-y-4">
                {timeline.map((entry) =>
                  entry.kind === 'message' ? (
                    <MessageBubble
                      isMine={entry.message.senderId === ownerId}
                      isRead={isMessageRead(entry.message, counterpartLastReadAt)}
                      key={`message-${entry.id}`}
                      message={entry.message}
                    />
                  ) : (
                    <MediaBubble
                      isMine={entry.media.senderId === ownerId}
                      isRead={isMediaRead(entry.media, counterpartLastReadAt)}
                      key={`media-${entry.id}`}
                      media={entry.media}
                    />
                  ),
                )}
                {outbox.map((entry) =>
                  entry.kind === 'MEDIA' ? (
                    <PendingMediaBubble
                      item={entry}
                      key={entry.clientRequestId}
                      onDismiss={() => dismissOutbox(entry.clientRequestId)}
                      onRetry={() => retry(entry)}
                    />
                  ) : (
                    <PendingMessageBubble
                      item={entry}
                      key={entry.clientRequestId}
                      onDismiss={() => dismissOutbox(entry.clientRequestId)}
                      onRetry={() => retry(entry)}
                    />
                  ),
                )}
              </div>
            </div>

            <div className="border-line border-t p-4">
              <div className="flex items-end gap-3">
                <input
                  accept={IMAGE_FILE_ACCEPT}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (file !== undefined) void pickImageFile(file)
                  }}
                  ref={imageInputRef}
                  type="file"
                />
                <Button
                  aria-label="发送图片"
                  className="h-11 w-11"
                  onClick={() => imageInputRef.current?.click()}
                  type="button"
                  variant="outline"
                >
                  <ImagePlus className="size-4" />
                </Button>
                <Button
                  aria-label={recording ? '结束录音并发送' : '录制语音'}
                  className={`h-11 w-11 ${recording ? 'animate-pulse' : ''}`}
                  disabled={voiceStarting}
                  onClick={() => void toggleRecording()}
                  type="button"
                  variant={recording ? 'default' : 'outline'}
                >
                  {recording ? <Square className="size-4" /> : <Mic className="size-4" />}
                </Button>
                <Textarea
                  aria-label="消息内容"
                  className="max-h-[160px] min-h-[44px] flex-1 resize-none"
                  maxLength={2000}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入消息，Enter 发送，Shift + Enter 换行"
                  value={draft}
                />
                <Button
                  className="h-11"
                  disabled={draft.trim().length === 0}
                  onClick={submit}
                  type="button"
                >
                  <Send className="size-4" />
                  发送
                </Button>
              </div>
              {recording ? (
                <p className="mt-2 text-danger text-xs" role="status">
                  正在录音…再次点击麦克风结束并发送（最长 60 秒）
                </p>
              ) : null}
              {mediaError !== null ? (
                <p className="mt-2 text-danger text-xs" role="alert">
                  {mediaError}
                </p>
              ) : null}
              <p className="mt-2 text-right text-ink-3 text-xs">{draft.length}/2000</p>
            </div>
          </div>
        </Card>

        <aside className="sticky top-24 space-y-4">
          <Card className="gap-0 border border-line p-5">
            <h2 className="font-semibold text-base">商品</h2>
            <Link
              className="mt-4 flex gap-3 rounded-xl p-2 transition-colors hover:bg-surface-2"
              params={{ listingId: item.listing.id }}
              to="/listing/$listingId"
            >
              <ListingThumb
                alt={item.listing.title}
                className="size-16 rounded-xl"
                coverUrl={item.listing.coverUrl}
                listingId={item.listing.id}
              />
              <div className="min-w-0">
                <p className="line-clamp-2 font-medium text-sm">{item.listing.title}</p>
                <PriceText
                  cents={item.listing.priceCents}
                  className="mt-2 block font-bold text-lg"
                />
                <p className="mt-1 text-ink-3 text-xs">{STATUS_LABEL[item.listing.status]}</p>
              </div>
            </Link>
          </Card>

          <Card className="gap-0 border border-line p-5">
            <h2 className="font-semibold text-base">对方</h2>
            <div className="mt-4 flex items-center gap-3">
              <UserAvatar
                avatarUrl={item.counterpart.avatarUrl}
                emoji={item.counterpart.nickname.slice(0, 1)}
                size="lg"
              />
              <p className="truncate font-semibold">{item.counterpart.nickname}</p>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  )
}
