import type { AdminModerationDetail, AdminModerationRecord } from '@fish/contracts/admin/schema'
import { Badge } from '@fish/ui/badge'
import { Button } from '@fish/ui/button'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ForbiddenInline, NotFoundInline } from './admin-filter'
import { type AdminActionOutcome, adminLoadView, moderationDecisionError } from './admin-messages'
import { useAdminModerationDetail, useModerationDecision } from './admin-queries'
import { withoutCursor } from './admin-search'
import {
  auditActionLabel,
  formatAdminDateTime,
  moderationDecisionMeta,
  moderationProviderMeta,
} from './admin-view'
import { ModerationDecisionDialog } from './moderation-decision-dialog'
import type { ModerationSearch } from './moderation-page'

/**
 * 决定提交后的界面状态迁移（纯函数）。web-pc 没有 jsdom、点不了按钮（同 `verify/view.ts`
 * 的说明），所以「提交失败后界面变成什么样」在这里钉住：
 * **409 冲突（`outcome.conflict`）关弹窗并立页级横幅**，其余失败留在弹窗内显示错误。
 * `b47c81fe` 的审核 409 页级提示此前只有实现没有用例（#467 审查 §5）。
 */
export type ModerationDecisionState = {
  dialogOpen: boolean
  dialogError: string | null
  conflict: boolean
}

export const MODERATION_DECISION_IDLE: ModerationDecisionState = {
  dialogOpen: false,
  dialogError: null,
  conflict: false,
}

export type ModerationDecisionEvent =
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'succeeded' }
  | { kind: 'failed'; outcome: AdminActionOutcome }

export function moderationDecisionStateAfter(
  state: ModerationDecisionState,
  event: ModerationDecisionEvent,
): ModerationDecisionState {
  switch (event.kind) {
    case 'open':
      return { ...state, dialogError: null, dialogOpen: true }
    case 'close':
    case 'succeeded':
      return { ...state, dialogOpen: false }
    case 'failed':
      return event.outcome.conflict
        ? { dialogError: null, dialogOpen: false, conflict: true }
        : { ...state, dialogError: event.outcome.message }
  }
}

/** 409 冲突的页级提示（弹窗此时已关，提示要跟着页面活到详情刷新之后）。 */
export function ModerationConflictBanner() {
  return (
    <p className="rounded-xl bg-danger-soft px-4 py-3 text-danger text-sm" role="alert">
      该审核记录已被其他管理员处理，详情已刷新。
    </p>
  )
}

/**
 * 审核记录详情（#467 验收「详情与审核历史、人工 ALLOW/BLOCK」）。
 * 已有人工决定时不再给决定表单（服务端会 409，界面也不该摆一个必然失败的按钮）。
 * `search` 是来源列表（URL 上的查询条件：tab + 判定/商品/关键词/时间段），
 * 返回链接据此回到来处（#467 五审 P2：以前只带 tab，检索条件全丢）。
 */
export function ModerationDetailPage({
  recordId,
  search,
}: {
  recordId: string
  search: ModerationSearch
}) {
  const detail = useAdminModerationDetail(recordId)

  if (detail.isPending) return <LoadingState label="正在加载审核记录…" />
  if (detail.isError) {
    const view = adminLoadView(detail.error, '审核记录加载失败')
    // 403 / 404 都不给「重试」（#467 五审 P3）：权限不会因重试改变，已删除的记录也不会回来。
    if (view.kind === 'forbidden') return <ForbiddenInline />
    if (view.kind === 'notFound') {
      return <NotFoundInline label="审核记录" to="/admin/moderation" />
    }
    return <ErrorState message={view.message} onRetry={() => void detail.refetch()} />
  }

  return <ModerationDetailView detail={detail.data} recordId={recordId} search={search} />
}

/** 详情视图（导出供静态渲染测试：本端没有 jsdom，见文件头的纯函数说明）。 */
export function ModerationDetailView({
  detail,
  recordId,
  search,
}: {
  detail: AdminModerationDetail
  recordId: string
  search: ModerationSearch
}) {
  const [decisionState, setDecisionState] = useState(MODERATION_DECISION_IDLE)
  const decision = useModerationDecision(recordId)

  const { item } = detail
  const machineMeta =
    detail.machineDecision !== null ? moderationDecisionMeta(detail.machineDecision) : null

  async function submit(input: {
    decision: 'ALLOW' | 'BLOCK'
    reason: string
    idempotencyKey: string
  }) {
    try {
      await decision.mutateAsync({
        input: { decision: input.decision, reason: input.reason },
        idempotencyKey: input.idempotencyKey,
      })
      setDecisionState((state) => moderationDecisionStateAfter(state, { kind: 'succeeded' }))
    } catch (error) {
      // 状态已被他人改掉（409）：关弹窗、展示页级冲突提示（onError 已全量失效刷新详情）。
      setDecisionState((state) =>
        moderationDecisionStateAfter(state, {
          kind: 'failed',
          outcome: moderationDecisionError(error),
        }),
      )
    }
  }

  return (
    <div className="space-y-5">
      {decisionState.conflict ? <ModerationConflictBanner /> : null}

      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            className="text-ink-3 text-sm hover:text-brand"
            search={withoutCursor(search)}
            to="/admin/moderation"
          >
            {search.tab === 'records' ? '← 审核记录' : '← 审核队列'}
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
            onClick={() =>
              setDecisionState((state) => moderationDecisionStateAfter(state, { kind: 'open' }))
            }
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

      {decisionState.dialogOpen ? (
        <ModerationDecisionDialog
          errorMessage={decisionState.dialogError}
          key={item.record.id}
          listingTitle={item.listing === null ? item.record.titleSnapshot : item.listing.title}
          onClose={() =>
            setDecisionState((state) => moderationDecisionStateAfter(state, { kind: 'close' }))
          }
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
