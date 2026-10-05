import type { AdminModerationDetail, AdminModerationRecord } from '@fish/contracts/admin/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { adminLoadOutcome, moderationDecisionError } from './admin-messages'
import { useAdminModerationDetail, useModerationDecision } from './admin-queries'
import {
  auditActionLabel,
  formatAdminDateTime,
  moderationDecisionMeta,
  moderationProviderMeta,
} from './admin-view'
import { ModerationDecisionDialog } from './moderation-decision-dialog'

/**
 * 审核记录详情（#467 验收「详情与审核历史、人工 ALLOW/BLOCK」）。
 * 已有人工决定时不再给决定表单（服务端会 409，界面也不该摆一个必然失败的按钮）。
 */
export function ModerationDetailPage({ recordId }: { recordId: string }) {
  const detail = useAdminModerationDetail(recordId)

  if (detail.isPending) return <LoadingState label="正在加载审核记录…" />
  if (detail.isError) {
    const outcome = adminLoadOutcome(detail.error)
    return (
      <ErrorState
        message={outcome.kind === 'error' ? outcome.message : '审核记录加载失败'}
        onRetry={() => void detail.refetch()}
      />
    )
  }

  return <ModerationDetailView detail={detail.data} recordId={recordId} />
}

function ModerationDetailView({
  detail,
  recordId,
}: {
  detail: AdminModerationDetail
  recordId: string
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const decision = useModerationDecision(recordId)

  const { item } = detail
  const machineMeta =
    detail.machineDecision !== null ? moderationDecisionMeta(detail.machineDecision) : null

  async function submit(input: {
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    idempotencyKey: string
  }) {
    setDialogError(null)
    try {
      await decision.mutateAsync({
        input: { decision: input.decision, reason: input.reason },
        idempotencyKey: input.idempotencyKey,
      })
      setDialogOpen(false)
    } catch (error) {
      const outcome = moderationDecisionError(error)
      if (outcome.conflict) {
        setDialogOpen(false)
      } else {
        setDialogError(outcome.message)
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            className="text-ink-3 text-sm hover:text-brand"
            search={{ tab: 'queue' }}
            to="/admin/moderation"
          >
            ← 审核队列
          </Link>
          <h1 className="mt-1 font-semibold text-[26px] tracking-[-0.03em]">
            {item.listing === null
              ? `（商品已删除）${item.record.titleSnapshot}`
              : item.listing.title}
          </h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            卖家 {item.seller.nickname} · 提交于 {formatAdminDateTime(item.record.createdAt)}
          </p>
        </div>
        {detail.humanDecision === null ? (
          <Button
            onClick={() => {
              setDialogError(null)
              setDialogOpen(true)
            }}
          >
            作出决定
          </Button>
        ) : (
          <Badge variant={moderationDecisionMeta(detail.humanDecision.decision).variant}>
            已决定：{moderationDecisionMeta(detail.humanDecision.decision).label}
          </Badge>
        )}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">机器结果</h2>
            {machineMeta !== null ? (
              <Badge variant={machineMeta.variant}>{machineMeta.label}</Badge>
            ) : null}
          </div>
          <ProviderLine record={item.record} />
          {item.record.matchedRules.length > 0 ? (
            <p className="text-ink-2 text-sm">命中规则：{item.record.matchedRules.join('、')}</p>
          ) : null}
          {item.record.matchedTermsMasked.length > 0 ? (
            <p className="text-ink-2 text-sm">
              命中词（脱敏）：{item.record.matchedTermsMasked.join('、')}
            </p>
          ) : null}
          <p className="text-ink-3 text-xs">
            提交动作 {item.record.action} · 规则版本 {item.record.ruleVersion}
          </p>
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">人工决定</h2>
          {detail.humanDecision === null ? (
            <p className="text-ink-3 text-sm">尚未决定。作出决定后将写入审计，不可在本页改判。</p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-sm">
                <Badge variant={moderationDecisionMeta(detail.humanDecision.decision).variant}>
                  {moderationDecisionMeta(detail.humanDecision.decision).label}
                </Badge>
              </p>
              <p className="text-ink-2 text-sm">{detail.humanDecision.reason}</p>
              <p className="text-ink-3 text-xs">
                {detail.humanDecision.actor === null
                  ? '操作者已删除'
                  : detail.humanDecision.actor.nickname}{' '}
                · {formatAdminDateTime(detail.humanDecision.decidedAt)}
              </p>
            </div>
          )}
          {item.listing !== null ? (
            <Link
              className="text-brand text-sm hover:underline"
              params={{ listingId: item.listing.id }}
              to="/admin/listings/$listingId"
            >
              查看商品详情 →
            </Link>
          ) : null}
        </Card>
      </div>

      <Card className="gap-0 divide-y divide-line border border-line p-0">
        <h2 className="p-4 font-semibold">审核历史</h2>
        {detail.history.length === 0 ? (
          <p className="p-4 text-ink-3 text-sm">无历史记录。</p>
        ) : (
          detail.history.map((history) => (
            <div className="flex items-center justify-between gap-4 p-4" key={history.id}>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant={moderationDecisionMeta(history.decision).variant}>
                    {moderationDecisionMeta(history.decision).label}
                  </Badge>
                  <span className="text-ink-3 text-xs">
                    动作 {history.action} · 规则 {history.ruleVersion}
                  </span>
                </div>
                {history.matchedRules.length > 0 ? (
                  <p className="mt-0.5 text-ink-3 text-xs">
                    命中：{history.matchedRules.join('、')}
                  </p>
                ) : null}
              </div>
              <span className="shrink-0 text-ink-3 text-xs">
                {formatAdminDateTime(history.createdAt)}
              </span>
            </div>
          ))
        )}
      </Card>

      <Card className="gap-0 border border-line p-4">
        <h2 className="font-semibold">提交时内容快照</h2>
        <p className="mt-2 font-medium text-sm">{item.record.titleSnapshot}</p>
        <p className="mt-1 whitespace-pre-wrap text-ink-2 text-sm">
          {item.record.descriptionSnapshot}
        </p>
        <p className="mt-2 text-ink-3 text-xs">
          快照是提交时刻的内容；商品当前标题可能已被编辑。相关审计：
          {auditActionLabel('MODERATION_DECISION')}
        </p>
      </Card>

      {dialogOpen ? (
        <ModerationDecisionDialog
          errorMessage={dialogError}
          key={item.record.id}
          listingTitle={item.listing === null ? item.record.titleSnapshot : item.listing.title}
          onClose={() => setDialogOpen(false)}
          onSubmit={(input) => void submit(input)}
          pending={decision.isPending}
        />
      ) : null}
    </div>
  )
}

/** 上游来源标注（#228 §6：含义随 provider 变化，端上只标注来源与请求号）。 */
function ProviderLine({ record }: { record: AdminModerationRecord }) {
  if (record.provider === null) {
    return <p className="text-ink-3 text-xs">上游来源：无（#228 之前的历史记录）</p>
  }
  const meta = moderationProviderMeta(record.provider)
  return (
    <div className="flex flex-wrap items-center gap-2 text-ink-3 text-xs">
      <Badge variant={meta.variant}>{meta.label}</Badge>
      {record.label !== null ? <span>label {record.label}</span> : null}
      {record.subLabel !== null ? <span>subLabel {record.subLabel}</span> : null}
      {record.score !== null ? <span>score {record.score}</span> : null}
      {record.providerRequestId !== null ? <span>req {record.providerRequestId}</span> : null}
    </div>
  )
}
