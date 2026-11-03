import { Alert, AlertDescription, AlertTitle } from '@fish/ui/alert'
import { Button } from '@fish/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@fish/ui/dialog'
import { EmptyState, ErrorState, LoadingState } from '@fish/ui/states'
import { Loader2, MessageSquareQuote } from 'lucide-react'
import { ApiError } from '../../lib/api-client'
import { formatRelativeTimeAt } from '../../lib/format'
import { useAddDisputeEvidence, useDisputeConversation } from './queries'
import { disputeFailureText, disputeMessagePreview } from './view'

/**
 * 从**本人该交易的会话**里挑一条消息作为聊天证据。
 *
 * 争议摘要只带交易 id，所以数据链是 `GET /transactions/:id` → `conversationId` →
 * `GET /conversations/:id/messages?before=…`（见 `fetchDisputeConversation`）。
 * 服务端会再校验消息确实属于本交易的会话，不属于则 404 `DISPUTE_MESSAGE_NOT_FOUND`。
 *
 * 只支持文本 / 系统消息：聊天历史接口固定排除 `type='MEDIA'`，且争议证据契约
 * （`DisputeEvidenceMessageSchema`）只有 `content`、没有媒体地址/尺寸，选中的图片
 * 在证据区只能渲染成 `[图片或视频]`，不能作为可用证据。聊天图片证据的投影属
 * 后端 + 契约变更，由 #500 跟踪，这里**不接 MEDIA**。
 */
export function EvidencePickerDialog({
  open,
  onOpenChange,
  disputeId,
  transactionId,
  existingMessageIds,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  disputeId: string
  transactionId: string
  existingMessageIds: string[]
}) {
  const conversation = useDisputeConversation(transactionId, open)
  const addEvidence = useAddDisputeEvidence(disputeId)
  const existing = new Set(existingMessageIds)

  // 关闭即清场：上一次的失败提示 / 待确认状态不带进下一次打开。
  function handleOpenChange(next: boolean) {
    if (!next) addEvidence.reset()
    onOpenChange(next)
  }

  // 首屏是最新一页（页内升序），往更早翻的页排在其后；渲染时要反过来拼成
  // 「最早 → 最新」，否则「加载更早」会把更早的消息追加到列表末尾。
  const pages = conversation.data?.pages ?? []
  const messages = [...pages].reverse().flatMap((page) => page?.messages ?? [])
  const latestPageKnown = pages.length > 0 && pages[0] !== null
  const pendingMessageId = addEvidence.isPending ? (addEvidence.variables ?? null) : null

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareQuote className="size-5 text-brand" />
            选择聊天证据
          </DialogTitle>
          <DialogDescription>
            只能选择这笔交易会话里的消息；被选中的消息会作为单条证据提交给平台。 当前仅支持文本 /
            系统消息，聊天图片证据待后端投影（#500）。
          </DialogDescription>
        </DialogHeader>

        {addEvidence.error !== null ? (
          <Alert role="alert" variant="destructive">
            <AlertTitle>添加失败</AlertTitle>
            <AlertDescription>
              {disputeFailureText(
                addEvidence.error instanceof ApiError ? addEvidence.error.code : null,
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {conversation.isPending ? <LoadingState label="正在加载会话消息…" /> : null}
        {conversation.isError ? (
          <ErrorState message="聊天记录加载失败" onRetry={() => void conversation.refetch()} />
        ) : null}
        {conversation.isSuccess && !latestPageKnown ? (
          <EmptyState
            description="这笔交易或它的会话当前不可见，无法读取聊天记录来选证据。"
            emoji="🔒"
            title="无法读取交易会话"
          />
        ) : null}
        {conversation.isSuccess && latestPageKnown && messages.length === 0 ? (
          <EmptyState
            description="交易双方还没有在这笔交易的会话里发过消息。"
            emoji="💬"
            title="没有可用的聊天消息"
          />
        ) : null}

        {messages.length > 0 ? (
          <ul className="max-h-[360px] space-y-2 overflow-y-auto">
            {conversation.hasNextPage ? (
              <li>
                <Button
                  className="w-full"
                  disabled={conversation.isFetchingNextPage}
                  onClick={() => void conversation.fetchNextPage()}
                  size="sm"
                  variant="outline"
                >
                  {conversation.isFetchingNextPage ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : null}
                  {conversation.isFetchingNextPage ? '正在加载…' : '加载更早的消息'}
                </Button>
              </li>
            ) : null}
            {messages.map((message) => {
              const added = existing.has(message.id)
              const pendingThisRow = pendingMessageId === message.id
              const preview = disputeMessagePreview(message)
              return (
                <li key={message.id}>
                  <div className="flex items-start justify-between gap-3 rounded-xl border border-line px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-ink-3 text-xs">
                        {message.sender?.nickname ?? '系统'} ·{' '}
                        {formatRelativeTimeAt(message.createdAt)}
                      </p>
                      <p className="mt-1 line-clamp-3 text-sm leading-5">{preview}</p>
                    </div>
                    <Button
                      aria-label={`${added ? '已添加' : '选为证据'}：${preview}`}
                      disabled={added || pendingThisRow}
                      onClick={() =>
                        addEvidence.mutate(message.id, { onSuccess: () => handleOpenChange(false) })
                      }
                      size="sm"
                      variant={added ? 'outline' : 'default'}
                    >
                      {pendingThisRow ? <Loader2 className="size-3 animate-spin" /> : null}
                      {added ? '已添加' : '选为证据'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}

        <DialogFooter>
          <Button onClick={() => handleOpenChange(false)} type="button" variant="outline">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
