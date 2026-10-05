import type { RecommendationMetrics } from '@fish/contracts/admin/recommendation-metrics'
import { RecommendationMetricsWindowSchema } from '@fish/contracts/admin/recommendation-metrics'
import { Card } from '@fish/ui/card'
import { ErrorState, LoadingState } from '@fish/ui/states'
import { useNavigate } from '@tanstack/react-router'
import { FilterChips } from './admin-filter'
import { adminLoadOutcome } from './admin-messages'
import { useAdminMetrics } from './admin-queries'
import { optionalSearch, withoutCursor } from './admin-search'
import { formatLatency, formatRate } from './admin-view'

export type MetricsSearch = { window?: '24h' | '7d' | '30d' }

/**
 * 推荐指标（#467 验收「展示现有聚合接口字段及时间窗口」）。**不新增指标采集**：
 * 漏斗 / 生命周期 / guardrails / 延迟四块照契约渲染；比率可空渲染 `—`，
 * 漏斗比率可能 > 1 照实显示（契约注释明确拒绝当转化率读）。
 */
export function MetricsPage({ search }: { search: MetricsSearch }) {
  const navigate = useNavigate()
  const window = search.window ?? '24h'
  const metrics = useAdminMetrics(window)

  if (metrics.isError) {
    const outcome = adminLoadOutcome(metrics.error)
    return (
      <ErrorState
        message={outcome.kind === 'error' ? outcome.message : '推荐指标加载失败'}
        onRetry={() => void metrics.refetch()}
      />
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-semibold text-[26px] tracking-[-0.03em]">推荐指标</h1>
          <p className="mt-1.5 text-ink-3 text-sm">
            只读展示推荐域聚合接口；延迟与失败率为进程内口径（自本进程启动）。
          </p>
        </div>
        <FilterChips
          ariaLabel="统计窗口"
          onChange={(next) =>
            void navigate({
              to: '/admin/metrics',
              search: { ...withoutCursor(search), window: next as MetricsSearch['window'] },
            })
          }
          options={[
            { value: '24h', label: '近 24 小时' },
            { value: '7d', label: '近 7 天' },
            { value: '30d', label: '近 30 天' },
          ]}
          value={window}
        />
      </div>

      {metrics.isPending ? <LoadingState label="正在加载推荐指标…" /> : null}
      {metrics.data !== undefined ? <MetricsView metrics={metrics.data} /> : null}
    </div>
  )
}

function MetricsView({ metrics }: { metrics: RecommendationMetrics }) {
  const funnel = [
    { label: '推荐请求', value: metrics.funnel.feedRequests },
    { label: '其中降级透传', value: metrics.funnel.degradedFeedRequests },
    { label: '归因曝光', value: metrics.funnel.impressions },
    { label: '归因详情', value: metrics.funnel.detailViews },
    { label: '归因收藏', value: metrics.funnel.favorites },
    { label: '归因会话', value: metrics.funnel.chats },
    { label: '归因交易发起', value: metrics.funnel.transactions },
    { label: '归因成交', value: metrics.funnel.purchases },
  ]
  const rates = [
    { label: '曝光 → 详情', value: metrics.funnel.impressionToDetailRate },
    { label: '详情 → 收藏', value: metrics.funnel.detailToFavoriteRate },
    { label: '详情 → 会话（下界）', value: metrics.funnel.detailToChatRate },
    { label: '会话 → 交易', value: metrics.funnel.chatToTransactionRate },
    { label: '交易 → 成交（下界）', value: metrics.funnel.transactionToPurchaseRate },
  ]
  const lifecycle = [
    {
      label: '新商品首次曝光（小时）',
      summary: metrics.lifecycle.newListingTimeToFirstExposureHours,
    },
    {
      label: '首次发布 → 首次意向（小时）',
      summary: metrics.lifecycle.firstPublishToFirstIntentHours,
    },
    { label: '成交前归因曝光（次）', summary: metrics.lifecycle.exposuresBeforeSale },
  ]
  const guardrails = [
    { label: '空快照排序比例', value: metrics.guardrails.emptyRankedFeedRate },
    { label: '重复曝光率', value: metrics.guardrails.repeatedExposureRate },
    { label: '头部卖家曝光占比', value: metrics.guardrails.topSellerExposureShare },
    { label: '前 10 卖家曝光占比', value: metrics.guardrails.top10SellerExposureShare },
    { label: '陈旧曝光率（上界）', value: metrics.guardrails.staleListingExposureRate },
    { label: '事件写入失败率', value: metrics.guardrails.eventWriteFailureRate },
  ]

  return (
    <div className="space-y-4">
      <p className="text-ink-3 text-xs">
        窗口 {metrics.window} · 生成于 {new Date(metrics.generatedAt).toLocaleString('zh-CN')} ·
        进程启动于 {new Date(metrics.processStartedAt).toLocaleString('zh-CN')}
      </p>

      <Card className="gap-3 border border-line p-5">
        <h2 className="font-semibold">线上漏斗（只含有推荐归因的事件）</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {funnel.map((step) => (
            <div className="rounded-xl bg-surface-2 p-3" key={step.label}>
              <p className="text-ink-3 text-xs">{step.label}</p>
              <p className="mt-0.5 font-bold text-xl">{step.value}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-4 text-ink-2 text-sm">
          {rates.map((rate) => (
            <span key={rate.label}>
              {rate.label} <span className="font-semibold">{formatRate(rate.value)}</span>
            </span>
          ))}
        </div>
        <p className="text-ink-3 text-xs">
          比率是「相邻步事件量之比」而非严格转化率（曝光→详情可 &gt;
          1）；标注下界的两项受归因头缺失影响。
        </p>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">生命周期</h2>
          {lifecycle.map((item) => (
            <div className="rounded-xl bg-surface-2 p-3" key={item.label}>
              <p className="text-ink-3 text-xs">{item.label}</p>
              <p className="mt-0.5 text-sm">
                样本 {item.summary.count} · 中位{' '}
                {item.summary.median === null ? '—' : item.summary.median.toFixed(1)} · p90{' '}
                {item.summary.p90 === null ? '—' : item.summary.p90.toFixed(1)}
              </p>
            </div>
          ))}
        </Card>

        <Card className="gap-3 border border-line p-5">
          <h2 className="font-semibold">Guardrails</h2>
          <div className="grid grid-cols-2 gap-3">
            {guardrails.map((item) => (
              <div className="rounded-xl bg-surface-2 p-3" key={item.label}>
                <p className="text-ink-3 text-xs">{item.label}</p>
                <p className="mt-0.5 font-semibold">{formatRate(item.value)}</p>
              </div>
            ))}
          </div>
          <p className="text-ink-3 text-xs">
            被 429 拒绝请求 {metrics.guardrails.rateLimitedRequests} 次；拒收原因分布：
            {(
              [
                ['归因不存在', metrics.guardrails.eventRejectionReasons.attributionNotFound],
                ['身份不匹配', metrics.guardrails.eventRejectionReasons.identityMismatch],
                ['商品不存在', metrics.guardrails.eventRejectionReasons.listingNotFound],
                ['时间越界', metrics.guardrails.eventRejectionReasons.occurredAtOutOfRange],
                [
                  '服务端确认事件',
                  metrics.guardrails.eventRejectionReasons.serverConfirmedEventType,
                ],
              ] as const
            )
              .map(([label, count]) => `${label} ${count}`)
              .join(' / ')}
          </p>
        </Card>
      </div>

      <Card className="gap-3 border border-line p-5">
        <h2 className="font-semibold">延迟分位（进程内环形缓冲）</h2>
        {metrics.latency.length === 0 ? (
          <p className="text-ink-3 text-sm">暂无延迟样本。</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
            {metrics.latency.map((entry) => (
              <div className="rounded-xl bg-surface-2 p-3" key={entry.metric}>
                <p className="text-ink-3 text-xs">
                  {entry.metric === 'feed'
                    ? 'Feed 请求'
                    : entry.metric === 'events'
                      ? '事件写入'
                      : 'pgvector 召回'}
                  （{entry.count} 次）
                </p>
                <p className="mt-0.5 text-sm">
                  p50 {formatLatency(entry.p50Ms)} · p95 {formatLatency(entry.p95Ms)} · p99{' '}
                  {formatLatency(entry.p99Ms)} · max {formatLatency(entry.maxMs)}
                </p>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

/** validateSearch 共用实现。 */
export function parseMetricsSearch(search: Record<string, unknown>): MetricsSearch {
  const window = optionalSearch(RecommendationMetricsWindowSchema, search.window)
  return window !== undefined ? { window } : {}
}
