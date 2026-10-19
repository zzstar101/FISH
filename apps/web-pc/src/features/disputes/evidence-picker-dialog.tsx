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
 * `GET /conversations/:id/messages`（见 `fetchDisputeConversation`）。服务端会再校验
 * 消息确实属于本交易的会话，不属于则 404 `DISPUTE_MESSAGE_NOT_FOUND`。
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

  const closeAfterSuccess = () => {
    addEvidence.reset()
    onOpenChange(false)
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareQuote className="size-5 text-brand" />
            选择聊天证据
          </DialogTitle>
          <DialogDescription>
            只能选择这笔交易会话里的消息；被选中的消息会作为单条证据提交给平台。
          </DialogDescription>
        </DialogHeader>

        {addEvidence.error !== null ? (
          <Alert variant="destructive">
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
        {conversation.isSuccess && (conversation.data?.messages.length ?? 0) === 0 ? (
          <EmptyState
            description="交易双方还没有在这笔交易的会话里发过消息。"
            emoji="💬"
            title="没有可用的聊天消息"
          />
        ) : null}

        {conversation.isSuccess && conversation.data !== null ? (
          <ul className="max-h-[360px] space-y-2 overflow-y-auto">
            {conversation.data.messages.map((message) => {
              const added = existing.has(message.id)
              return (
                <li key={message.id}>
                  <div className="flex items-start justify-between gap-3 rounded-xl border border-line px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-ink-3 text-xs">
                        {message.sender?.nickname ?? '系统'} ·{' '}
                        {formatRelativeTimeAt(message.createdAt)}
                      </p>
                      <p className="mt-1 line-clamp-3 text-sm leading-5">
                        {disputeMessagePreview(message)}
                      </p>
                    </div>
                    <Button
                      disabled={added || addEvidence.isPending}
                      onClick={() =>
                        addEvidence.mutate(message.id, { onSuccess: closeAfterSuccess })
                      }
                      size="sm"
                      variant={added ? 'outline' : 'default'}
                    >
                      {addEvidence.isPending ? <Loader2 className="size-3 animate-spin" /> : null}
                      {added ? '已添加' : '选为证据'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        ) : null}

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
