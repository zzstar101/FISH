import type { MessageDto } from '@fish/contracts/chat/schema'
import type { DisputeDetail } from '@fish/contracts/disputes/schema'
import { MAX_DISPUTE_ATTACHMENTS } from '@fish/contracts/disputes/schema'
import { Image, ScrollView, Text, View } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ICONS } from '@/assets/lib-icons'
import AuthRequired from '@/components/auth-required'
import EmptyState from '@/components/empty-state'
import LoadError from '@/components/load-error'
import TopBar from '@/components/top-bar'
import { useAuthGuard } from '@/features/auth/guard'
import { useAuth } from '@/features/auth/store'
import { addDisputeEvidence, withdrawDispute } from '@/features/disputes/api'
import {
  loadDisputeConversationId,
  loadDisputeDetail,
  loadEvidenceCandidates,
} from '@/features/disputes/load'
import {
  DISPUTE_RESOLUTION_META,
  DISPUTE_STATUS_META,
  DISPUTE_TYPE_META,
  disputeFailureText,
  EVIDENCE_TYPE_LABEL,
  shortDisputeId,
  TRANSACTION_STATUS_LABEL,
} from '@/features/disputes/meta'
import { uploadDisputeAttachment } from '@/features/disputes/upload'
import {
  attachmentActionLabel,
  attachmentSlotsLeft,
  canAddDisputeMaterial,
  canWithdrawDispute,
  disputeNotFoundCopy,
  disputeRoleOf,
  evidenceMessageText,
} from '@/features/disputes/view'
import { UploadAbortedError } from '@/features/upload/active'
import { pickPhotos } from '@/features/upload/api'
import { formatYuan } from '@/lib/money'
import { isApiError } from '@/lib/request'
import { dayLabelOf } from '@/lib/time'
import './index.scss'

/**
 * 争议详情（#497）。
 *
 * ## 可见范围由服务端判定
 *
 * 只有发起人 / 被诉方 / 管理员能看（其余 404，且与「不存在」同一个码，不泄漏存在性）。
 * 页面拿到 404 落「看不到这条争议」的友好态，不是「加载失败 + 重试」。
 *
 * ## 谁能写
 *
 * 只有**发起人 + PENDING** 能撤回、补附件、加聊天证据；被诉方全程只读（附件额度是双方共享的 6 张，
 * 服务端把写入方限死在发起人）。端上的 `canWithdrawDispute` / `canAddDisputeMaterial` 只用于
 * 提前隐藏必然失败的按钮，最终仍以服务端为准。
 *
 * ## 附件链：选图 → presign → PUT 直传 → confirm
 *
 * 见 `features/disputes/upload.ts`。失败逐张提示并停手（同一原因连试只会刷屏）；
 * 每一步前后都核对「页面仍挂载 + 仍是同一登录用户」（`alive` + `userIdRef`），
 * 换号/卸载时由 `UploadAbortedError` 静默中止，不拿别人的会话去 confirm。
 *
 * ## 附件 URL 是 900s 的签名 URL
 *
 * 页面在后台放久了再回来、或预览大图前，先按 `ATTACHMENT_URL_TTL_MS` 判断签名是否过期，
 * 过期就静默重读详情换新签名，否则 `<Image>` 裂、`previewImage` 空图。
 *
 * ## 聊天证据
 *
 * 契约只接受**一条消息**（`messageId`），所以小程序这一侧的做法是：交易详情拿 `conversationId`
 * → 读该会话**最近一页**消息 → 用户点一条文字消息关联成证据。只列文字消息、不提供「翻更早的
 * 消息」：那等于把整段私聊搬进争议里，超出本票范围（媒体消息的证据形态见跟进 issue）。
 */
type PageState = 'loading' | 'ok' | 'notFound' | 'failed'
type EvidenceState = 'idle' | 'loading' | 'ok' | 'failed'

/**
 * 附件 URL 是服务端签发的 capability URL（TTL 900s）。放后台超过这个时长再回来，
 * `<Image>` 会裂、`previewImage` 会拿到空图 —— 所以回前台时先静默重读详情换新签名。
 */
const ATTACHMENT_URL_TTL_MS = 900_000

export default function DisputeDetailPage() {
  const authStatus = useAuthGuard()
  const { user } = useAuth()
  const userId = user?.id ?? null
  const router = useRouter<{ id?: string }>()
  const disputeId = router.params.id ?? ''

  const [state, setState] = useState<PageState>('loading')
  const [detail, setDetail] = useState<DisputeDetail | null>(null)
  /** 写操作撞了 409（状态已变）：先禁写并静默重拉，避免继续按旧状态渲染按钮 */
  const [stale, setStale] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [evidenceState, setEvidenceState] = useState<EvidenceState>('idle')
  const [messages, setMessages] = useState<MessageDto[]>([])
  const [addingMessageId, setAddingMessageId] = useState<string | null>(null)

  const loadEpoch = useRef(0)
  /** 页面卸载 / 换号后不再发上传链的后半段（`assertUploadActive` 的判据之一） */
  const alive = useRef(true)
  /**
   * 上传链在 await 之间的「当前登录用户」判据：与 `alive` 合用时，换号后即使页面还没卸载，
   * 也不会拿别人的会话去 confirm 上一个账号的争议。
   */
  const userIdRef = useRef(userId)
  userIdRef.current = userId
  /** 当前 `detail` 里附件签名 URL 的签发时刻（判断是否过期，见 ATTACHMENT_URL_TTL_MS） */
  const lastLoadedAt = useRef(0)
  const evidenceLoadingRef = useRef(false)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /**
   * 换号：先在渲染期把上一账号的快照清掉，别让新账号看到上一账号的争议内容；
   * 重新加载由下面的登录态 effect 负责（新账号若非当事人，服务端 404 → 友好态）。
   */
  const [prevUserId, setPrevUserId] = useState(userId)
  if (prevUserId !== userId) {
    setPrevUserId(userId)
    loadEpoch.current += 1
    setDetail(null)
    setStale(false)
    setUploading(false)
    setSheetOpen(false)
    setEvidenceState('idle')
    setMessages([])
    setAddingMessageId(null)
    setState('loading')
  }

  /** `silent`：保留当前内容（不闪骨架屏），用于 409 后重同步 */
  const read = useCallback(
    async (silent = false) => {
      if (disputeId === '') {
        setState('notFound')
        return
      }
      const epoch = ++loadEpoch.current
      if (!silent) setState('loading')
      const result = await loadDisputeDetail(disputeId)
      if (epoch !== loadEpoch.current) return
      if (result.state === 'ok') {
        setDetail(result.detail)
        lastLoadedAt.current = Date.now()
        setStale(false)
        setState('ok')
      } else {
        setState(result.state)
      }
    },
    [disputeId],
  )

  /**
   * 409 = 服务端状态已经变了（处理完 / 已撤回），本次写操作必然失败。
   * 返回 true 时已触发静默重拉：按钮会在 `stale` 期间隐藏，刷新完成后按新状态重新判定。
   */
  const resyncIfConflict = (error: unknown): boolean => {
    if (!isApiError(error) || error.status !== 409) return false
    setStale(true)
    void read(true)
    return true
  }

  useEffect(() => {
    if (authStatus !== 'authed' || userId === null) return
    void read()
  }, [authStatus, userId, read])

  /**
   * 回前台时补一次：附件签名 900s 后就失效，页面在后台放久了再回来 `<Image>` 会裂。
   * 只有距上次加载超过 TTL 才重读，避免「选完图/看完大图回来」这种同会话回前台白打一次请求。
   */
  useDidShow(() => {
    if (detail === null) return
    if (Date.now() - lastLoadedAt.current <= ATTACHMENT_URL_TTL_MS) return
    void read(true)
  })

  const runWithdraw = async () => {
    if (detail === null) return
    setWithdrawing(true)
    try {
      const next = await withdrawDispute(detail.id)
      setDetail(next)
      setStale(false)
      void Taro.showToast({ title: '已撤回争议', icon: 'none' })
    } catch (error) {
      resyncIfConflict(error)
      void Taro.showToast({
        title: isApiError(error)
          ? disputeFailureText(error.code, 'withdraw')
          : disputeFailureText(null),
        icon: 'none',
      })
    } finally {
      setWithdrawing(false)
    }
  }

  /** 撤回要二次确认：它是不可逆的（撤回后不能恢复，只能重新发起）。 */
  const onWithdraw = () => {
    if (detail === null || withdrawing) return
    void Taro.showModal({
      title: '撤回这条争议？',
      content: '撤回后本次争议处理结束，不能恢复；如问题仍未解决，可以重新发起。',
      confirmText: '撤回',
      confirmColor: '#ff5f6d',
      cancelText: '再想想',
    })
      .then((result) => {
        if (result.confirm) void runWithdraw()
      })
      .catch(() => {})
  }

  const addAttachments = () => {
    if (detail === null || uploading) return
    const slots = attachmentSlotsLeft(detail.attachments.length)
    if (slots <= 0) {
      void Taro.showToast({ title: '附件最多 6 张', icon: 'none' })
      return
    }
    void (async () => {
      let picked: Awaited<ReturnType<typeof pickPhotos>>
      try {
        picked = await pickPhotos(slots)
      } catch (error) {
        void Taro.showToast({
          title: error instanceof Error ? error.message : '无法选择图片，请稍后重试',
          icon: 'none',
        })
        return
      }
      if (picked.rejected !== null) {
        void Taro.showToast({ title: picked.rejected, icon: 'none' })
      }
      if (picked.photos.length === 0) return

      const epoch = loadEpoch.current
      const current = () => alive.current && epoch === loadEpoch.current
      setUploading(true)
      try {
        for (const photo of picked.photos) {
          if (!current()) break
          try {
            const attachment = await uploadDisputeAttachment(detail.id, photo, {
              isActive: current,
              currentUserId: () => userIdRef.current,
            })
            if (!current()) break
            setDetail((prev) =>
              prev === null ? prev : { ...prev, attachments: [...prev.attachments, attachment] },
            )
          } catch (error) {
            if (error instanceof UploadAbortedError) break
            resyncIfConflict(error)
            void Taro.showToast({
              title: isApiError(error) ? disputeFailureText(error.code) : '图片上传失败，请重试',
              icon: 'none',
            })
            // 一张失败就停手：继续下一张大概率是同一个原因（额度满 / 网络断 / 争议已处理）
            break
          }
        }
      } finally {
        setUploading(false)
      }
    })()
  }

  const loadMessages = async () => {
    if (detail === null || evidenceLoadingRef.current) return
    evidenceLoadingRef.current = true
    setEvidenceState('loading')
    try {
      const conversationId = await loadDisputeConversationId(detail.transaction.id)
      if (conversationId === null) {
        if (alive.current) setEvidenceState('failed')
        return
      }
      const result = await loadEvidenceCandidates(conversationId)
      if (!alive.current) return
      setMessages(result.messages)
      setEvidenceState(result.failed ? 'failed' : 'ok')
    } finally {
      evidenceLoadingRef.current = false
    }
  }

  const openEvidenceSheet = () => {
    if (detail === null) return
    setSheetOpen(true)
    if (evidenceState !== 'ok' && evidenceState !== 'loading') void loadMessages()
  }

  const addEvidence = async (messageId: string) => {
    if (detail === null || addingMessageId !== null) return
    setAddingMessageId(messageId)
    try {
      const result = await addDisputeEvidence(detail.id, messageId)
      setDetail((prev) => {
        if (prev === null) return prev
        if (prev.evidence.some((item) => item.message.id === result.evidence.message.id))
          return prev
        return { ...prev, evidence: [...prev.evidence, result.evidence] }
      })
      setSheetOpen(false)
      void Taro.showToast({
        title: result.created ? '已添加为证据' : '这条消息已经是证据',
        icon: 'none',
      })
    } catch (error) {
      resyncIfConflict(error)
      void Taro.showToast({
        title: isApiError(error) ? disputeFailureText(error.code) : disputeFailureText(null),
        icon: 'none',
      })
    } finally {
      setAddingMessageId(null)
    }
  }

  /**
   * 附件 URL 是 900s TTL 的签名 URL：过期后 `<Image>` 已裂，直接 `previewImage` 只会弹空图。
   * 所以先看上次加载距今是否超 TTL，超了就先静默重读详情换新签名再打开；重读失败仍按旧 URL
   * 打开（至少给一次机会），不额外弹错。
   */
  const previewAttachment = (index: number) => {
    if (detail === null || detail.attachments.length === 0) return
    const targets = detail.attachments
    const picked = targets[index]
    const openWith = (urls: string[], currentUrl: string | undefined) => {
      void Taro.previewImage({ urls, current: currentUrl })
    }
    if (Date.now() - lastLoadedAt.current <= ATTACHMENT_URL_TTL_MS) {
      openWith(
        targets.map((attachment) => attachment.url),
        picked?.url,
      )
      return
    }
    void (async () => {
      const result = await loadDisputeDetail(detail.id)
      if (!alive.current) return
      if (result.state !== 'ok') {
        openWith(
          targets.map((attachment) => attachment.url),
          picked?.url,
        )
        return
      }
      setDetail(result.detail)
      lastLoadedAt.current = Date.now()
      setStale(false)
      const fresh = result.detail.attachments
      // 以 id 对齐：刷新期间附件可能被别人补上，顺序不一定和旧快照一致
      openWith(
        fresh.map((attachment) => attachment.url),
        fresh.find((attachment) => attachment.id === picked?.id)?.url,
      )
    })()
  }

  if (authStatus !== 'authed') {
    return <AuthRequired restoring={authStatus === 'unknown'} />
  }

  const notFound = disputeNotFoundCopy('detail')
  const nowMs = Date.now()
  const role = detail === null ? 'observer' : disputeRoleOf(detail, userId)
  // `stale`（刚撞 409、正在重拉）期间先禁写：继续按旧 `PENDING` 放出按钮只会再失败一次
  const canWrite = detail !== null && !stale && canAddDisputeMaterial(detail, userId)
  const canWithdraw = detail !== null && !stale && canWithdrawDispute(detail, userId)
  const attachmentCount = detail?.attachments.length ?? 0
  const evidenceIds = new Set((detail?.evidence ?? []).map((item) => item.message.id))
  const candidates = messages
    .filter((message) => message.type === 'TEXT' && message.recalledAt === null)
    .filter((message) => !evidenceIds.has(message.id))
    .slice()
    .reverse()

  const statusMeta = detail === null ? null : DISPUTE_STATUS_META[detail.status]
  const resolutionMeta =
    detail?.resolution === null || detail?.resolution === undefined
      ? null
      : DISPUTE_RESOLUTION_META[detail.resolution]

  return (
    <View className="dsd">
      <View className="dsd__bg" />
      <TopBar variant="glass" spacer back title="争议" titleEm="详情" />

      <View className="dsd__body">
        {state === 'loading' ? (
          <View className="dsd__skeleton">
            {[0, 1, 2].map((i) => (
              <View
                key={`sk-${i}`}
                className="dsd__skelbar"
                style={{ width: i === 0 ? '70%' : '100%' }}
              />
            ))}
            <Text className="dsd__skel-hint">正在读取争议…</Text>
          </View>
        ) : state === 'notFound' ? (
          <View className="dsd__emptypad">
            <EmptyState
              title={notFound.title}
              text={notFound.text}
              icon={ICONS.shieldLine}
              actionText="返回"
              onAction={() => {
                void Taro.navigateBack()
              }}
            />
          </View>
        ) : state === 'failed' ? (
          <LoadError
            title="争议详情加载失败"
            text="网络似乎不太顺畅，稍后再试试"
            onRetry={() => {
              void read()
            }}
          />
        ) : detail === null || statusMeta === null ? (
          <LoadError
            title="争议详情加载失败"
            text="请稍后重试"
            onRetry={() => {
              void read()
            }}
          />
        ) : (
          <View className="dsd__content">
            {/* 状态卡：状态胶囊 + 类型 + 结论 / 撤回信息 */}
            <View className="dsd__card">
              <View className="dsd__top">
                <View className={`dsd__chip is-${statusMeta.tone}`}>
                  <View className="dsd__chip-dot" />
                  <Text>{statusMeta.label}</Text>
                </View>
                <Text className="dsd__type">{DISPUTE_TYPE_META[detail.type].label}</Text>
              </View>
              <Text className="dsd__statusnote">{statusMeta.note}</Text>

              {resolutionMeta !== null ? (
                <View className={`dsd__verdict is-${resolutionMeta.tone}`}>
                  <Text className="dsd__verdict-label">{resolutionMeta.label}</Text>
                  <Text className="dsd__verdict-note">{resolutionMeta.note}</Text>
                  {detail.resolutionNote !== null ? (
                    <Text className="dsd__verdict-text">{detail.resolutionNote}</Text>
                  ) : null}
                  {detail.handledAt !== null ? (
                    <Text className="dsd__verdict-time num">{`处理于 ${dayLabelOf(detail.handledAt, nowMs)}`}</Text>
                  ) : null}
                </View>
              ) : null}

              {detail.status === 'WITHDRAWN' && detail.withdrawnAt !== null ? (
                <Text className="dsd__statusnote num">{`撤回于 ${dayLabelOf(detail.withdrawnAt, nowMs)}`}</Text>
              ) : null}

              <View className="dsd__meta">
                <Text className="dsd__meta-t">{`发起于 ${dayLabelOf(detail.createdAt, nowMs)}`}</Text>
                <Text className="dsd__meta-t num">{shortDisputeId(detail.id)}</Text>
              </View>
            </View>

            {/* 争议说明 */}
            <View className="dsd__card">
              <Text className="dsd__card-h">争议说明</Text>
              <Text className="dsd__detail-text">
                {detail.detailText ?? '发起人没有填写补充说明。'}
              </Text>
            </View>

            {/* 交易摘要 */}
            <View className="dsd__card">
              <Text className="dsd__card-h">关联交易</Text>
              <View className="dsd__row">
                <Text className="dsd__k">商品</Text>
                <Text className="dsd__v">{detail.transaction.listingTitle}</Text>
              </View>
              <View className="dsd__row">
                <Text className="dsd__k">金额</Text>
                <Text className="dsd__v num">{formatYuan(detail.transaction.amountCents)}</Text>
              </View>
              <View className="dsd__row">
                <Text className="dsd__k">买家</Text>
                <Text className="dsd__v">{detail.transaction.buyer.nickname}</Text>
              </View>
              <View className="dsd__row">
                <Text className="dsd__k">卖家</Text>
                <Text className="dsd__v">{detail.transaction.seller.nickname}</Text>
              </View>
              <View className="dsd__row">
                <Text className="dsd__k">交易状态</Text>
                <Text className="dsd__v">
                  {TRANSACTION_STATUS_LABEL[detail.transaction.status]}
                </Text>
              </View>
              <View className="dsd__row">
                <Text className="dsd__k">下单时间</Text>
                <Text className="dsd__v num">
                  {dayLabelOf(detail.transaction.createdAt, nowMs)}
                </Text>
              </View>
              <View
                className="dsd__link"
                onClick={() => {
                  void Taro.navigateTo({
                    url: `/pkg-trade/pages/transaction-meetup/index?id=${encodeURIComponent(detail.transaction.id)}`,
                  })
                }}
              >
                <Text>查看订单详情</Text>
              </View>
            </View>

            {/* 附件 */}
            <View className="dsd__card">
              <View className="dsd__card-head">
                <Text className="dsd__card-h">附件</Text>
                <Text className="dsd__card-count num">{`${attachmentCount} / ${MAX_DISPUTE_ATTACHMENTS}`}</Text>
              </View>
              {detail.attachments.length === 0 ? (
                <Text className="dsd__hint">还没有上传附件。</Text>
              ) : (
                <View className="dsd__thumbs">
                  {detail.attachments.map((attachment, index) => (
                    <View
                      key={attachment.id}
                      className="dsd__thumb"
                      onClick={() => previewAttachment(index)}
                    >
                      <Image className="dsd__thumb-img" src={attachment.url} mode="aspectFill" />
                    </View>
                  ))}
                </View>
              )}
              {canWrite ? (
                <View className="dsd__inline-actions">
                  <View
                    className={`dsd__btn dsd__btn--sec${uploading ? ' is-off' : ''}`}
                    onClick={addAttachments}
                  >
                    <Text>{uploading ? '上传中…' : attachmentActionLabel(attachmentCount)}</Text>
                  </View>
                </View>
              ) : null}
            </View>

            {/* 聊天证据 */}
            <View className="dsd__card">
              <View className="dsd__card-head">
                <Text className="dsd__card-h">聊天证据</Text>
                <Text className="dsd__card-count num">{`${detail.evidence.length} 条`}</Text>
              </View>
              {detail.evidence.length === 0 ? (
                <Text className="dsd__hint">还没有关联聊天消息。</Text>
              ) : (
                <View className="dsd__evidences">
                  {detail.evidence.map((item) => (
                    <View key={item.message.id} className="dsd__evidence">
                      <View className="dsd__evidence-top">
                        <Text className="dsd__evidence-type">
                          {EVIDENCE_TYPE_LABEL[item.message.type]}
                        </Text>
                        <Text className="dsd__evidence-sender">
                          {item.message.senderNickname ?? '系统'}
                        </Text>
                        <Text className="dsd__evidence-time num">
                          {dayLabelOf(item.message.createdAt, nowMs)}
                        </Text>
                      </View>
                      {/* 撤回的消息不显示正文（与聊天页一致），否则「撤回」形同虚设 */}
                      <Text
                        className={`dsd__evidence-text${item.message.recalledAt !== null ? ' is-recalled' : ''}`}
                      >
                        {evidenceMessageText(item.message)}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
              {canWrite ? (
                <View className="dsd__inline-actions">
                  <View className="dsd__btn dsd__btn--sec" onClick={openEvidenceSheet}>
                    <Text>选聊天证据</Text>
                  </View>
                </View>
              ) : null}
            </View>

            {role === 'respondent' ? (
              <Text className="dsd__note">
                你是被诉方：可以查看全部材料与结论，材料只能由发起人提交。
              </Text>
            ) : null}

            {stale ? (
              <Text className="dsd__note">
                争议状态刚有更新，正在刷新；刷新完成后才能继续操作。
              </Text>
            ) : null}

            {canWithdraw ? (
              <View
                className={`dsd__btn dsd__btn--danger${withdrawing ? ' is-off' : ''}`}
                onClick={onWithdraw}
              >
                <Text>{withdrawing ? '撤回中…' : '撤回争议'}</Text>
              </View>
            ) : null}

            <Text className="dsd__foot">争议由管理员处理，结论为最终结论。</Text>
          </View>
        )}
      </View>

      {/* 选证据：底部弹层，列出该交易会话最近一页的文字消息 */}
      {sheetOpen ? (
        <View className="dsd__sheetanchor">
          <View className="dsd__scrim" onClick={() => setSheetOpen(false)} />
          <View className="dsd__sheet">
            <View className="dsd__sheet-head">
              <Text className="dsd__sheet-title">选一条聊天消息</Text>
              <Text className="dsd__sheet-close" onClick={() => setSheetOpen(false)}>
                关闭
              </Text>
            </View>
            {/* 说清范围：只列最近一页的文字消息，更早的请回会话里核对 */}
            <Text className="dsd__sheet-note">只显示这段会话最近一页的文字消息。</Text>
            {evidenceState === 'loading' ? (
              <Text className="dsd__sheet-hint">正在读取最近消息…</Text>
            ) : evidenceState === 'failed' ? (
              <View className="dsd__sheet-fail">
                <Text className="dsd__sheet-hint">最近消息没读出来。</Text>
                <View
                  className="dsd__btn dsd__btn--sec"
                  onClick={() => {
                    void loadMessages()
                  }}
                >
                  <Text>重试</Text>
                </View>
              </View>
            ) : candidates.length === 0 ? (
              <Text className="dsd__sheet-hint">
                最近的文字消息都已经是证据了，或这段会话还没有文字消息。
              </Text>
            ) : (
              <ScrollView scrollY className="dsd__sheet-list">
                {candidates.map((message) => (
                  <View
                    key={message.id}
                    className={`dsd__cand${addingMessageId === message.id ? ' is-busy' : ''}`}
                    onClick={() => {
                      void addEvidence(message.id)
                    }}
                  >
                    <View className="dsd__cand-top">
                      <Text className="dsd__cand-sender">{message.sender?.nickname ?? '对方'}</Text>
                      <Text className="dsd__cand-time num">
                        {dayLabelOf(message.createdAt, nowMs)}
                      </Text>
                    </View>
                    <Text className="dsd__cand-text">{message.content}</Text>
                    {addingMessageId === message.id ? (
                      <Text className="dsd__cand-busy">正在添加…</Text>
                    ) : null}
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>
      ) : null}
    </View>
  )
}
